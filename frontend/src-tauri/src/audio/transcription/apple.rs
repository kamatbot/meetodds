//! Continuous Apple ASR; no VAD sentence gate and no separate speculative model pass.
use super::{live_preview::LiveTranscriptPreviewUpdate, worker::TranscriptUpdate};
use crate::apple_speech::{SpeechEvent, SpeechSession};
use crate::audio::{recording_state::DeviceType, AudioChunk};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::{sync::mpsc, task::JoinHandle};

static PREVIEW_REVISION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct AppleAudioSender {
    sender: mpsc::Sender<AudioChunk>,
    failed: Arc<AtomicBool>,
}

impl AppleAudioSender {
    pub fn try_send(&self, chunk: AudioChunk) -> Result<(), mpsc::error::TrySendError<AudioChunk>> {
        self.sender.try_send(chunk).inspect_err(|_| {
            self.failed.store(true, Ordering::Release);
        })
    }
}

pub struct PreparedApple {
    pub sender: AppleAudioSender,
    receiver: mpsc::Receiver<AudioChunk>,
    microphone: Option<SpeechSession>,
    system: Option<SpeechSession>,
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
        let mic = if microphone {
            Some(SpeechSession::start(&config.model).await?)
        } else {
            None
        };
        let sys = if system {
            Some(SpeechSession::start(&config.model).await?)
        } else {
            None
        };
        let (sender, receiver) = mpsc::channel(128);
        Ok(Some(Self {
            sender: AppleAudioSender {
                sender,
                failed: Arc::new(AtomicBool::new(false)),
            },
            receiver,
            microphone: mic,
            system: sys,
        }))
    }

    pub fn spawn<R: Runtime>(self, app: AppHandle<R>, separated: bool) -> JoinHandle<()> {
        // The pipeline owns the only sender after this method, so shutdown closes input.
        let Self {
            sender,
            mut receiver,
            mut microphone,
            mut system,
        } = self;
        let input_failed = sender.failed.clone();
        drop(sender);
        tokio::spawn(async move {
            let mut input_open = true;
            let mut mic_clock = SampleClock::default();
            let mut sys_clock = SampleClock::default();
            let mut mic_final_end = -1.0;
            let mut sys_final_end = -1.0;
            let mut finish_deadline = None;
            let outcome: Result<(), String> = async {
                loop {
                    if microphone.is_none() && system.is_none() {
                        if input_open { return Err("Apple Speech ended before recording stopped.".into()); }
                        break;
                    }
                    tokio::select! {
                        chunk = receiver.recv(), if input_open => match chunk {
                            Some(chunk) => {
                                let (session, clock) = match chunk.device_type {
                                    DeviceType::Microphone => (&microphone, &mut mic_clock),
                                    DeviceType::System => (&system, &mut sys_clock),
                                };
                                if let Some(session) = session {
                                    let timestamp = clock.accept(chunk.data.len(), chunk.sample_rate, chunk.timestamp)?;
                                    session.push(&chunk.data, chunk.sample_rate, timestamp)?;
                                }
                            }
                            None => {
                                if input_failed.load(Ordering::Acquire) {
                                    return Err("Apple Speech fell behind its audio input queue; live transcription has stopped.".into());
                                }
                                input_open = false;
                                for session in [&microphone, &system].into_iter().flatten() { session.finish(); }
                                finish_deadline = Some(tokio::time::Instant::now() + std::time::Duration::from_secs(30));
                            }
                        },
                        event = next_event(&mut microphone), if microphone.is_some() => {
                            if handle_event(&app, event, "microphone", separated, &mut mic_final_end)? {
                                if input_open { return Err("Apple Speech stopped recognizing microphone audio unexpectedly.".into()); }
                                microphone = None;
                            }
                        },
                        event = next_event(&mut system), if system.is_some() => {
                            if handle_event(&app, event, "system", separated, &mut sys_final_end)? {
                                if input_open { return Err("Apple Speech stopped recognizing system audio unexpectedly.".into()); }
                                system = None;
                            }
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
            // Drop both sessions (cancels recognition) before signalling completion.
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

async fn next_event(session: &mut Option<SpeechSession>) -> Option<SpeechEvent> {
    match session {
        Some(s) => s.events.recv().await,
        None => std::future::pending().await,
    }
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
}

fn valid_result(text: &str, start: f64, end: f64) -> bool {
    !text.trim().is_empty() && start.is_finite() && end.is_finite() && start >= 0.0 && end >= start
}

fn handle_event<R: Runtime>(
    app: &AppHandle<R>,
    event: Option<SpeechEvent>,
    source: &str,
    separated: bool,
    final_end: &mut f64,
) -> Result<bool, String> {
    match event {
        Some(SpeechEvent::Result {
            text,
            start,
            end,
            is_final,
        }) => {
            if !valid_result(&text, start, end) || end <= *final_end {
                return Ok(false);
            }
            let text = text.trim().to_owned();
            let (speaker, label) = match (source, separated) {
                ("microphone", true) => ("me", "Me"),
                ("system", _) => ("remote-unknown", "Other party"),
                _ => ("room-unknown", "Speaker"),
            };
            super::worker::emit_speech_detected(app);
            if is_final {
                *final_end = end;
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
            Ok(false)
        }
        Some(SpeechEvent::Finished) => Ok(true),
        Some(SpeechEvent::Error { message }) => Err(message),
        None => Err("Apple Speech disconnected or its result queue overflowed.".into()),
        _ => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn apple_input_overflow_is_not_a_normal_stop() {
        let (sender, mut receiver) = mpsc::channel(1);
        let failed = Arc::new(AtomicBool::new(false));
        let input = AppleAudioSender {
            sender,
            failed: failed.clone(),
        };
        let chunk = AudioChunk {
            data: vec![0.0],
            sample_rate: 48000,
            timestamp: 0.0,
            chunk_id: 0,
            device_type: DeviceType::Microphone,
        };
        input.try_send(chunk.clone()).unwrap();
        assert!(input.try_send(chunk).is_err());
        drop(input);
        assert!(receiver.recv().await.is_some());
        assert!(receiver.recv().await.is_none());
        assert!(failed.load(Ordering::Acquire));

        let (sender, mut receiver) = mpsc::channel(1);
        let failed = Arc::new(AtomicBool::new(false));
        drop(AppleAudioSender {
            sender,
            failed: failed.clone(),
        });
        assert!(receiver.recv().await.is_none());
        assert!(!failed.load(Ordering::Acquire));
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
