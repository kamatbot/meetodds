//! Continuous Apple ASR; no model VAD and no separate speculative model pass. A cheap
//! energy gate keeps silence (and keystrokes alone) away from the recognizer.
use super::{live_preview::LiveTranscriptPreviewUpdate, worker::TranscriptUpdate};
use crate::apple_speech::{SpeechEvent, SpeechSession};
use crate::audio::{recording_state::DeviceType, AudioChunk};
use log::warn;
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::{sync::mpsc, task::JoinHandle};

static PREVIEW_REVISION: AtomicU64 = AtomicU64::new(1);

/// Per-source input bound, by audio time (callback sizes vary by device).
const MAX_QUEUED_US: u64 = 10_000_000;

fn source_index(device: &DeviceType) -> usize {
    match device {
        DeviceType::Microphone => 0,
        DeviceType::System => 1,
    }
}

fn duration_us(samples: usize, rate: u32) -> u64 {
    samples as u64 * 1_000_000 / rate.max(1) as u64
}

/// A capture chunk plus the audio of its source that was dropped just before it
/// (queue full), so the sample clock stays aligned with the recording.
pub struct AppleInput {
    chunk: AudioChunk,
    dropped_secs: f64,
}

pub enum AppleSendError {
    /// This chunk was skipped for transcription only; the next one carries the gap.
    Full,
    /// The Apple task has ended.
    Closed,
}

#[derive(Clone)]
pub struct AppleAudioSender {
    sender: mpsc::UnboundedSender<AppleInput>,
    queued_us: Arc<[AtomicU64; 2]>,
    dropped_secs: [f64; 2],
}

impl AppleAudioSender {
    pub fn try_send(&mut self, chunk: AudioChunk) -> Result<(), AppleSendError> {
        let i = source_index(&chunk.device_type);
        let us = duration_us(chunk.data.len(), chunk.sample_rate);
        let queued = self.queued_us[i].load(Ordering::Acquire);
        if queued > 0 && queued + us > MAX_QUEUED_US {
            self.dropped_secs[i] += us as f64 / 1e6;
            return Err(AppleSendError::Full);
        }
        self.queued_us[i].fetch_add(us, Ordering::AcqRel);
        let dropped_secs = std::mem::take(&mut self.dropped_secs[i]);
        self.sender
            .send(AppleInput { chunk, dropped_secs })
            .map_err(|_| AppleSendError::Closed)
    }
}

/// Energy gate in front of the recognizer. Apple analyzes silence at full cost and has
/// produced text from digital zeros, so audio is only fed around sustained energy:
/// 5 consecutive loud 10 ms frames. A keystroke (<= 15 ms click, a gap, then the release)
/// never lights 5 in a row, so typing alone neither opens the gate nor extends it; any
/// vowel does. Pre-roll keeps onsets; hangover keeps word endings and gives Apple enough
/// trailing audio to finalize before input pauses.
pub struct SpeechGate {
    open: bool,
    hangover_left: u32,
    frame_energy: f32,
    frame_len: usize,
    loud_run: u32,
    /// Closed: pre-roll. Open: audio waiting to be fed (the caller drains it).
    pub pending: VecDeque<(Vec<f32>, f64)>,
}

impl SpeechGate {
    /// ponytail: fixed threshold (-50 dBFS RMS per 10 ms frame, after the app's mic
    /// loudness normalization). Rooms whose noise floor sits above it keep the gate open,
    /// which costs CPU, never words; track the noise floor adaptively if that shows up.
    const THRESHOLD: f32 = 1e-5;
    const SUSTAINED_FRAMES: u32 = 5;
    const HANGOVER_FRAMES: u32 = 150;
    const PREROLL_SECS: f64 = 0.3;

    pub fn new() -> Self {
        Self {
            open: false,
            hangover_left: 0,
            frame_energy: 0.0,
            frame_len: 0,
            loud_run: 0,
            pending: VecDeque::new(),
        }
    }

    fn end_frame(&mut self) {
        let loud = self.frame_energy / self.frame_len.max(1) as f32 > Self::THRESHOLD;
        self.loud_run = if loud { self.loud_run + 1 } else { 0 };
        if self.loud_run >= Self::SUSTAINED_FRAMES {
            self.open = true;
            self.hangover_left = Self::HANGOVER_FRAMES;
        } else if self.open {
            self.hangover_left -= 1;
            self.open = self.hangover_left > 0;
        }
    }

    /// Queue one chunk starting at `start` (sample-clock seconds). Returns true when
    /// `pending` should be fed now: pre-roll + this chunk on opening, or the tail.
    pub fn process(&mut self, samples: Vec<f32>, start: f64, rate: u32) -> bool {
        let was_open = self.open;
        let frame = (rate / 100).max(1) as usize;
        for x in &samples {
            self.frame_energy += x * x;
            self.frame_len += 1;
            if self.frame_len == frame {
                self.end_frame();
                self.frame_energy = 0.0;
                self.frame_len = 0;
            }
        }
        self.pending.push_back((samples, start));
        if self.open || was_open {
            return true;
        }
        let secs = |b: &Vec<f32>| b.len() as f64 / rate.max(1) as f64;
        while self.pending.len() > 1
            && self.pending.iter().skip(1).map(|(b, _)| secs(b)).sum::<f64>() >= Self::PREROLL_SECS
        {
            self.pending.pop_front();
        }
        false
    }
}

/// What the event loop should do with one session event.
pub enum Step {
    Final { text: String, start: f64, end: f64 },
    Partial { text: String, start: f64, end: f64 },
    /// The current session finished (expected only after input closed).
    Ended,
    Nothing,
}

/// Maps a session's timeline to recording time. Skipped audio (gate closed, dropped
/// input) is spliced out: the analyzer gets contiguous audio, because SpeechAnalyzer
/// mis-hears the first words after a `bufferStartTime` jump (measured), and a fresh
/// session per speech burst finalizes ~0.3-0.8 s later than a warm one (measured).
#[derive(Default)]
struct Timeline {
    /// (analyzer time, recording time - analyzer time from there on).
    /// ponytail: one entry per pause, never pruned (~16 B each); fine for any meeting.
    splices: Vec<(f64, f64)>,
    fed_end: Option<f64>,
}

impl Timeline {
    /// Analyzer timestamp for `secs` of audio that starts at recording time `at`.
    fn place(&mut self, at: f64, secs: f64) -> f64 {
        let t = match self.fed_end {
            Some(end) if self.splices.last().is_some_and(|s| (at - end - s.1).abs() < 1e-6) => end,
            Some(end) => {
                self.splices.push((end, at - end));
                end
            }
            None => {
                self.splices.push((at, 0.0));
                at
            }
        };
        self.fed_end = Some(t + secs);
        t
    }

    fn to_recording(&self, t: f64) -> f64 {
        let i = self.splices.partition_point(|s| s.0 <= t);
        t + self.splices.get(i.saturating_sub(1)).map_or(0.0, |s| s.1)
    }
}

/// An Apple session, its final watermark (recording time) and timeline.
struct Live {
    session: SpeechSession,
    final_end: f64,
    timeline: Timeline,
}

impl Live {
    fn new(session: SpeechSession) -> Self {
        Self { session, final_end: -1.0, timeline: Timeline::default() }
    }
}

/// One capture source: gate, sample clock and its Apple session. A captions toggle or a
/// full Swift queue continues in a new session anchored at the sample clock; the previous
/// one finishes in `retiring` (its queued audio is still finalized).
pub struct Source {
    name: &'static str,
    live: Option<Live>,
    partials: bool,
    retiring: Vec<Live>,
    clock: SampleClock,
    gate: SpeechGate,
    pub restarts: u32,
}

impl Source {
    pub fn new(name: &'static str, session: SpeechSession, partials: bool) -> Self {
        Self {
            name,
            live: Some(Live::new(session)),
            partials,
            retiring: Vec::new(),
            clock: SampleClock::default(),
            gate: SpeechGate::new(),
            restarts: 0,
        }
    }

    pub fn is_done(&self) -> bool {
        self.live.is_none() && self.retiring.is_empty()
    }

    /// End of input: the current session finalizes everything it was fed.
    pub fn finish(&self) {
        if let Some(live) = &self.live {
            live.session.finish();
        }
    }

    async fn restart(&mut self, locale: &str, partials: bool) -> Result<(), String> {
        let next = Live::new(SpeechSession::start(locale, partials).await?);
        self.partials = partials;
        self.restarts += 1;
        if let Some(old) = self.live.replace(next) {
            old.session.finish();
            self.retiring.push(old);
        }
        Ok(())
    }

    /// Returns true when input was dropped or a session overflowed (caller warns).
    pub async fn accept(&mut self, locale: &str, chunk: AudioChunk, dropped_secs: f64, partials: bool) -> Result<bool, String> {
        let rate = chunk.sample_rate;
        self.clock.skip(dropped_secs);
        let start = self.clock.accept(chunk.data.len(), rate, chunk.timestamp)?;
        let mut behind = dropped_secs > 0.0;
        if behind {
            // Pre-roll from before the drop is not contiguous with this chunk.
            self.gate.pending.clear();
        }
        if partials != self.partials {
            // Captions toggled: partials vs finals-only.
            self.restart(locale, partials).await?;
        }
        if !self.gate.process(chunk.data, start, rate) {
            return Ok(behind);
        }
        while let Some((samples, at)) = self.gate.pending.pop_front() {
            let secs = samples.len() as f64 / rate as f64;
            let Some(live) = &mut self.live else { break };
            if live.session.push(&samples, rate, live.timeline.place(at, secs))? {
                continue;
            }
            // The recognizer is ~10 s behind. Keep live transcription going.
            behind = true;
            self.restart(locale, self.partials).await?;
            let Some(live) = &mut self.live else { break };
            if !live.session.push(&samples, rate, live.timeline.place(at, secs))? {
                return Err("Apple Speech cannot accept live audio.".into());
            }
        }
        Ok(behind)
    }

    /// Next event of the current (`None`) or a retiring (`Some(i)`) session.
    pub async fn next_event(&mut self) -> (Option<SpeechEvent>, Option<usize>) {
        let Self { live, retiring, .. } = self;
        std::future::poll_fn(|cx| {
            if let Some(l) = live.as_mut() {
                if let std::task::Poll::Ready(event) = l.session.events.poll_recv(cx) {
                    return std::task::Poll::Ready((event, None));
                }
            }
            for (i, l) in retiring.iter_mut().enumerate() {
                if let std::task::Poll::Ready(event) = l.session.events.poll_recv(cx) {
                    return std::task::Poll::Ready((event, Some(i)));
                }
            }
            std::task::Poll::Pending
        })
        .await
    }

    /// Validates, de-duplicates and maps a result to recording time.
    pub fn on_event(&mut self, event: Option<SpeechEvent>, from: Option<usize>) -> Result<Step, String> {
        let current = from.is_none();
        let live = match from {
            Some(i) => self.retiring.get_mut(i),
            None => self.live.as_mut(),
        };
        let Some(live) = live else { return Ok(Step::Nothing) };
        match event {
            Some(SpeechEvent::Result { text, start, end, is_final }) => {
                if !valid_result(&text, start, end) {
                    return Ok(Step::Nothing);
                }
                let (start, end) = (live.timeline.to_recording(start), live.timeline.to_recording(end));
                // A retiring session's partials are stale; the live caption is the new session's.
                if end <= live.final_end || !(is_final || current) {
                    return Ok(Step::Nothing);
                }
                let text = text.trim().to_owned();
                if !is_final {
                    return Ok(Step::Partial { text, start, end });
                }
                live.final_end = end;
                Ok(Step::Final { text, start, end })
            }
            Some(SpeechEvent::Finished) if current => {
                self.live = None;
                Ok(Step::Ended)
            }
            Some(SpeechEvent::Error { message }) if current => Err(message),
            None if current => Err("Apple Speech disconnected or its result queue overflowed.".into()),
            Some(SpeechEvent::Finished | SpeechEvent::Error { .. }) | None => {
                if !matches!(event, Some(SpeechEvent::Finished)) {
                    warn!("A finished Apple Speech {} session ended with an error; live transcription continues.", self.name);
                }
                if let Some(i) = from {
                    self.retiring.remove(i);
                }
                Ok(Step::Nothing)
            }
            _ => Ok(Step::Nothing),
        }
    }
}

pub struct PreparedApple {
    pub sender: AppleAudioSender,
    receiver: mpsc::UnboundedReceiver<AppleInput>,
    locale: String,
    microphone: Option<Source>,
    system: Option<Source>,
}

impl PreparedApple {
    /// Freeze the selected locale before opening capture. No implicit asset downloads.
    pub async fn from_config<R: Runtime>(
        app: &AppHandle<R>,
        microphone: bool,
        system: bool,
    ) -> Result<Option<Self>, String> {
        let config =
            crate::api::api::api_get_transcript_config(app.clone(), app.state(), None).await?;
        let Some(config) = config.filter(|c| c.provider == crate::apple_speech::PROVIDER) else {
            return Ok(None);
        };
        // Captions off: finals only. Toggling captions later restarts at the sample clock.
        let partials = super::preview_control::PREVIEW_GATE.enabled();
        let mic = if microphone {
            Some(Source::new("microphone", SpeechSession::start(&config.model, partials).await?, partials))
        } else {
            None
        };
        let sys = if system {
            Some(Source::new("system", SpeechSession::start(&config.model, partials).await?, partials))
        } else {
            None
        };
        let (sender, receiver) = mpsc::unbounded_channel();
        Ok(Some(Self {
            sender: AppleAudioSender {
                sender,
                queued_us: Arc::new([AtomicU64::new(0), AtomicU64::new(0)]),
                dropped_secs: [0.0; 2],
            },
            receiver,
            locale: config.model,
            microphone: mic,
            system: sys,
        }))
    }

    pub fn spawn<R: Runtime>(self, app: AppHandle<R>, separated: bool) -> JoinHandle<()> {
        // The pipeline owns the only sender after this method, so shutdown closes input.
        let Self {
            sender,
            mut receiver,
            locale,
            mut microphone,
            mut system,
        } = self;
        let queued_us = sender.queued_us.clone();
        drop(sender);
        tokio::spawn(async move {
            let mut input_open = true;
            let mut finish_deadline = None;
            let mut last_warning: Option<std::time::Instant> = None;
            let outcome: Result<(), String> = async {
                loop {
                    if microphone.is_none() && system.is_none() {
                        if input_open { return Err("Apple Speech ended before recording stopped.".into()); }
                        break;
                    }
                    tokio::select! {
                        input = receiver.recv(), if input_open => match input {
                            Some(input) => {
                                let chunk = &input.chunk;
                                let i = source_index(&chunk.device_type);
                                queued_us[i].fetch_sub(duration_us(chunk.data.len(), chunk.sample_rate), Ordering::AcqRel);
                                let source = if i == 0 { &mut microphone } else { &mut system };
                                if let Some(source) = source.as_mut() {
                                    let partials = super::preview_control::PREVIEW_GATE.enabled();
                                    if source.accept(&locale, input.chunk, input.dropped_secs, partials).await? {
                                        warn_behind(&app, &mut last_warning);
                                    }
                                }
                            }
                            None => {
                                input_open = false;
                                for source in [&microphone, &system].into_iter().flatten() { source.finish(); }
                                finish_deadline = Some(tokio::time::Instant::now() + std::time::Duration::from_secs(30));
                            }
                        },
                        (event, from) = next_event(&mut microphone), if microphone.is_some() => {
                            on_step(&app, &mut microphone, event, from, separated, input_open)?;
                        },
                        (event, from) = next_event(&mut system), if system.is_some() => {
                            on_step(&app, &mut system, event, from, separated, input_open)?;
                        },
                        _ = wait_for_finish(finish_deadline), if finish_deadline.is_some() => {
                            return Err("Apple Speech did not finish in time. Audio is retained; retry transcription from the saved recording.".into());
                        }
                    }
                }
                Ok(())
            }.await;
            if let Err(message) = outcome {
                // Audio persistence continues independently. No silent fallback or fabricated final text.
                let _ = app.emit("transcription-error", serde_json::json!({
                    "error": message, "userMessage": format!("{} Recording audio continues to be saved. Stop the meeting and retry from its audio.", message), "actionable": false
                }));
            }
            // Drop both sources (cancels recognition) before signalling completion.
            drop(microphone);
            drop(system);
            let _ = app.emit(
                "live-transcript-preview-clear",
                serde_json::json!({"source": null}),
            );
            let _ = app.emit(
                "transcription-queue-complete",
                serde_json::json!({"provider": "appleSpeech"}),
            );
        })
    }
}

/// Non-blocking banner (the existing transcription performance warning), at most every 30 s.
fn warn_behind<R: Runtime>(app: &AppHandle<R>, last: &mut Option<std::time::Instant>) {
    if last.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(30)) {
        return;
    }
    *last = Some(std::time::Instant::now());
    warn!("Apple Speech fell behind live audio; skipped input or restarted a session. Recording continues.");
    let _ = app.emit(
        "chunk-drop-warning",
        "Live transcription fell behind and skipped or restarted briefly. The recording is unaffected.",
    );
}

async fn next_event(source: &mut Option<Source>) -> (Option<SpeechEvent>, Option<usize>) {
    match source {
        Some(source) => source.next_event().await,
        None => std::future::pending().await,
    }
}

fn on_step<R: Runtime>(
    app: &AppHandle<R>,
    source: &mut Option<Source>,
    event: Option<SpeechEvent>,
    from: Option<usize>,
    separated: bool,
    input_open: bool,
) -> Result<(), String> {
    let Some(src) = source.as_mut() else { return Ok(()) };
    match src.on_event(event, from)? {
        Step::Final { text, start, end } => emit_result(app, src.name, separated, text, start, end, true)?,
        Step::Partial { text, start, end } => emit_result(app, src.name, separated, text, start, end, false)?,
        Step::Ended if input_open => {
            return Err(format!("Apple Speech stopped recognizing {} audio unexpectedly.", src.name));
        }
        Step::Ended | Step::Nothing => {}
    }
    if src.is_done() {
        *source = None;
    }
    Ok(())
}

async fn wait_for_finish(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

/// Sample-count time is monotonic and excludes paused audio, which capture discards.
/// Capture timestamps denote the end of a callback; anchor the first buffer at its start.
#[derive(Default)]
struct SampleClock {
    next: Option<f64>,
}
impl SampleClock {
    fn accept(&mut self, samples: usize, rate: u32, capture_end: f64) -> Result<f64, String> {
        if rate == 0 || !capture_end.is_finite() || capture_end < 0.0 {
            return Err("Invalid Apple Speech audio clock.".into());
        }
        let duration = samples as f64 / rate as f64;
        let start = self
            .next
            .unwrap_or_else(|| (capture_end - duration).max(0.0));
        self.next = Some(start + duration);
        Ok(start)
    }
    /// Audio dropped before reaching this task still occupied recording time.
    fn skip(&mut self, secs: f64) {
        if let Some(next) = &mut self.next {
            *next += secs;
        }
    }
}

fn valid_result(text: &str, start: f64, end: f64) -> bool {
    !text.trim().is_empty() && start.is_finite() && end.is_finite() && start >= 0.0 && end >= start
}

fn emit_result<R: Runtime>(
    app: &AppHandle<R>,
    source: &str,
    separated: bool,
    text: String,
    start: f64,
    end: f64,
    is_final: bool,
) -> Result<(), String> {
    let (speaker, label) = match (source, separated) {
        ("microphone", true) => ("me", "Me"),
        ("system", _) => ("remote-unknown", "Other party"),
        _ => ("room-unknown", "Speaker"),
    };
    super::worker::emit_speech_detected(app);
    if is_final {
        let update = TranscriptUpdate {
            text,
            timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
            source: source.into(),
            speaker: speaker.into(),
            speaker_label: label.into(),
            speaker_source: source.into(),
            speaker_confidence: if source == "microphone" && separated {
                1.0
            } else {
                0.25
            },
            sequence_id: super::worker::next_sequence_id(),
            chunk_start_time: start,
            is_partial: false,
            confidence: 0.85,
            audio_start_time: start,
            audio_end_time: end,
            duration: end - start,
        };
        app.emit("transcript-update", update).map_err(|_| {
            "Could not deliver the final Apple Speech transcript.".to_string()
        })?;
        let _ = app.emit(
            "live-transcript-preview-clear",
            serde_json::json!({"source": source}),
        );
    } else if super::preview_control::PREVIEW_GATE.epoch().is_some() {
        // Existing presentation/translation consumers receive the same partial-event contract.
        let _ = app.emit(
            "live-transcript-preview",
            LiveTranscriptPreviewUpdate {
                text,
                source: source.into(),
                speaker: speaker.into(),
                speaker_label: label.into(),
                revision: PREVIEW_REVISION.fetch_add(1, Ordering::Relaxed),
                audio_start_time: start,
                audio_end_time: end,
                latency_ms: 0, // No decoder timing is exposed by SpeechAnalyzer; do not invent one.
            },
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn chunk(device_type: DeviceType, samples: usize, capture_end: f64) -> AudioChunk {
        AudioChunk { data: vec![0.0; samples], sample_rate: 48000, timestamp: capture_end, chunk_id: 0, device_type }
    }

    #[test]
    fn apple_overflow_skips_audio_but_keeps_timestamps_aligned() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut sender = AppleAudioSender {
            sender: tx,
            queued_us: Arc::new([AtomicU64::new(0), AtomicU64::new(0)]),
            dropped_secs: [0.0; 2],
        };
        // A stalled task: ten 1 s mic chunks fill the 10 s budget, three more are dropped.
        for i in 0..13 {
            let sent = sender.try_send(chunk(DeviceType::Microphone, 48000, i as f64 + 1.0));
            assert_eq!(sent.is_ok(), i < 10);
        }
        // Each source has its own budget.
        assert!(sender.try_send(chunk(DeviceType::System, 48000, 1.0)).is_ok());
        // The task catches up the way `spawn` does; the next mic chunk carries the gap.
        let mut clock = SampleClock::default();
        let mut starts = vec![];
        while let Ok(input) = rx.try_recv() {
            let i = source_index(&input.chunk.device_type);
            sender.queued_us[i].fetch_sub(duration_us(input.chunk.data.len(), 48000), Ordering::AcqRel);
            if i == 0 {
                clock.skip(input.dropped_secs);
                starts.push(clock.accept(48000, 48000, input.chunk.timestamp).unwrap());
            }
        }
        assert!(sender.try_send(chunk(DeviceType::Microphone, 48000, 14.0)).is_ok());
        let input = rx.try_recv().unwrap();
        assert_eq!(input.dropped_secs, 3.0);
        clock.skip(input.dropped_secs);
        starts.push(clock.accept(48000, 48000, input.chunk.timestamp).unwrap());
        // Chunk 14 starts at 13 s of recording time, not 10 s.
        assert_eq!(starts, vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 13.0]);
        // Closed task: reported as such, not as overflow.
        drop(rx);
        assert!(matches!(sender.try_send(chunk(DeviceType::System, 480, 2.0)), Err(AppleSendError::Closed)));
    }

    #[test]
    fn timeline_splices_out_skipped_audio_and_maps_results_back() {
        let mut t = Timeline::default();
        // Fed 0-2 s, skipped 2-10 s (gate closed), fed 10-11 s, skipped, fed 20-21 s.
        assert_eq!(t.place(0.0, 1.0), 0.0);
        assert_eq!(t.place(1.0, 1.0), 1.0);
        assert_eq!(t.place(10.0, 1.0), 2.0, "the analyzer sees contiguous audio");
        assert_eq!(t.place(20.0, 1.0), 3.0);
        assert_eq!(t.splices, vec![(0.0, 0.0), (2.0, 8.0), (3.0, 17.0)]);
        for (analyzer, recording) in [(0.5, 0.5), (1.99, 1.99), (2.0, 10.0), (2.5, 10.5), (3.25, 20.25)] {
            assert!((t.to_recording(analyzer) - recording).abs() < 1e-9, "{analyzer}");
        }
        // A session that first gets audio mid-recording is anchored there.
        let mut late = Timeline::default();
        assert_eq!(late.place(42.0, 0.5), 42.0);
        assert_eq!(late.to_recording(42.25), 42.25);
    }

    /// Native: pushing 30 s of voice-level audio at once overflows the Swift queue (10 s);
    /// the source restarts instead of ending, and every session still finishes cleanly.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires macOS 26+, supported hardware, and installed English speech assets"]
    async fn apple_native_full_queue_restarts_without_ending() {
        let session = SpeechSession::start("en_US", false).await.unwrap();
        let mut source = Source::new("microphone", session, false);
        let tone: Vec<f32> = (0..48000).map(|i| 0.1 * (i as f32 * 0.03).sin()).collect();
        for i in 0..30 {
            let mut input = chunk(DeviceType::Microphone, 0, i as f64 + 1.0);
            input.data = tone.clone();
            source.accept("en_US", input, 0.0, false).await.unwrap();
        }
        assert!(source.restarts >= 1, "the Swift queue should have filled");
        source.finish();
        while !source.is_done() {
            let (event, from) = tokio::time::timeout(std::time::Duration::from_secs(60), source.next_event()).await.unwrap();
            source.on_event(event, from).unwrap();
        }
    }

    /// Feed a 48 kHz signal through the gate in 1024-sample chunks; returns fed spans (s).
    fn fed(gate: &mut SpeechGate, signal: &[f32]) -> Vec<(f64, f64)> {
        let mut spans = vec![];
        for (i, c) in signal.chunks(1024).enumerate() {
            if gate.process(c.to_vec(), (i * 1024) as f64 / 48000.0, 48000) {
                spans.extend(gate.pending.drain(..).map(|(b, t)| (t, t + b.len() as f64 / 48000.0)));
            }
        }
        spans
    }

    /// Fast typing from `from` to `to` s: a loud 15 ms press every 100 ms and a 10 ms
    /// release 60 ms after it.
    fn add_clicks(signal: &mut [f32], from: f64, to: f64) {
        let mut t = from;
        while t < to {
            for (at, ms) in [(t, 15), (t + 0.06, 10)] {
                for s in signal.iter_mut().skip((at * 48000.0) as usize).take(48 * ms) {
                    *s += 0.5;
                }
            }
            t += 0.1;
        }
    }

    #[test]
    fn gate_skips_silence_and_keystrokes_alone() {
        let mut signal = vec![0.0; 48000 * 6];
        add_clicks(&mut signal, 3.0, 6.0);
        let mut gate = SpeechGate::new();
        assert!(fed(&mut gate, &signal).is_empty());
        // Only the pre-roll is held while closed.
        assert!(gate.pending.iter().map(|(b, _)| b.len()).sum::<usize>() <= 48000 * 3 / 10 + 1024);
    }

    #[test]
    fn gate_keeps_onset_and_tail_contiguous_and_typing_does_not_extend_it() {
        // Silence, 2 s of voice-level tone (-23 dBFS), then typing only.
        let mut signal: Vec<f32> = (0..48000 * 8)
            .map(|i| if (48000..48000 * 3).contains(&i) { 0.1 * (i as f32 * 0.03).sin() } else { 0.0 })
            .collect();
        add_clicks(&mut signal, 3.0, 8.0);
        let spans = fed(&mut SpeechGate::new(), &signal);
        assert!(spans.windows(2).all(|w| (w[1].0 - w[0].1).abs() < 1e-9), "one contiguous run");
        let (first, last) = (spans[0].0, spans[spans.len() - 1].1);
        assert!((0.65..=0.8).contains(&first), "pre-roll before the 1 s onset: {first}");
        assert!((4.45..=4.6).contains(&last), "1.5 s hangover after the 3 s offset, clicks ignored: {last}");
    }

    #[test]
    fn sample_clock_excludes_pause_and_callback_jitter() {
        let mut clock = SampleClock::default();
        assert_eq!(clock.accept(480, 48000, 0.01).unwrap(), 0.0);
        assert_eq!(clock.accept(480, 48000, 15.02).unwrap(), 0.01);
        assert_eq!(clock.accept(480, 48000, 15.03).unwrap(), 0.02);
    }
    #[test]
    fn timestamps_and_text_are_validated() {
        assert!(!valid_result(" ", 0.0, 1.0));
        assert!(!valid_result("word", f64::NAN, 1.0));
        assert!(!valid_result("word", 2.0, 1.0));
        assert!(valid_result("word", 1.0, 2.0));
        assert!(SampleClock::default().accept(1, 0, 0.0).is_err());
    }
}
