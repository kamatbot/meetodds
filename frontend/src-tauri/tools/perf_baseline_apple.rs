//! `--engine apple` for perf_baseline, plus the ground-truth metrics shared with the
//! Parakeet run.
//!
//! Drives the app's real per-source logic, `audio::transcription::apple::Source` (energy
//! gate, sample clock, session restarts) over the compiled Swift bridge, the way
//! `audio/transcription/apple.rs` does: a bounded input queue (~10 s per source) fed with
//! `try_send`, `Step::Partial` = `live-transcript-preview` (none with --captions-off:
//! finals-only sessions), `Step::Final` = `transcript-update`.
//! Recognition runs partly out of process, so besides getrusage this also diffs
//! per-process CPU time (`ps`) across each phase.
//!
//! ponytail: the event loop mirrors `PreparedApple::spawn` (which needs a live Tauri
//! `AppHandle`) around the shared `Source`. Keep the two in step.

use super::*;
use app_lib::apple_speech::SpeechSession;
use app_lib::audio::transcription::apple::{Source, SpeechGate, Step};
use app_lib::audio::{AudioChunk, RecordingDeviceType as DeviceType};
use futures_util::FutureExt;
use std::collections::HashMap;

const REFERENCE: &str =
    "And so my fellow Americans ask not what your country can do for you ask what you can do for your country";

/// (start_ms, end_ms, ready_ms, text, arrived_after_input_closed)
pub type Final = (f64, f64, f64, String, bool);

// ---------------------------------------------------------------------------
// whole-machine CPU
// ---------------------------------------------------------------------------

/// pid -> (cumulative CPU secs, command) for every process.
pub fn ps_cpu() -> HashMap<u32, (f64, String)> {
    sh("ps", &["-Ao", "pid=,time=,comm="])
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            // "MMM:SS.ss" (or "H:MM:SS.ss").
            let secs = it.next()?.split(':').try_fold(0.0, |acc, p| p.parse::<f64>().ok().map(|v| acc * 60.0 + v))?;
            Some((pid, (secs, it.collect::<Vec<_>>().join(" "))))
        })
        .collect()
}

/// Apple on-device recognition: Speech.framework XPCServices/localspeechrecognition does the
/// work; corespeechd, the embedded-ASR stack and aned (Neural Engine daemon) are included for
/// completeness. Observed on macOS 27. Text-to-speech/Siri services are not recognition.
fn is_speech_service(comm: &str) -> bool {
    let c = comm.to_lowercase();
    // iOS Simulator runtimes ship their own copies of these daemons; they are not this Mac's.
    if c.contains("coresimulator") || c.contains(".simruntime/") {
        return false;
    }
    c.contains("/speech.framework/") || c.contains("speechrecognition") || c.contains("corespeech") || c.ends_with("/aned")
}

/// Per-process CPU consumed between two snapshots, excluding this process.
pub fn cpu_deltas(before: &HashMap<u32, (f64, String)>, wall: f64) -> Value {
    let after = ps_cpu();
    let me = std::process::id();
    let mut rows: Vec<(f64, u32, String)> = after
        .into_iter()
        .filter(|(pid, _)| *pid != me)
        .map(|(pid, (t, comm))| {
            let t0 = before.get(&pid).filter(|(_, c)| *c == comm).map_or(0.0, |b| b.0);
            (t - t0, pid, comm)
        })
        .filter(|r| r.0 > 0.0)
        .collect();
    rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    let fmt = |r: &(f64, u32, String)| json!({"pid": r.1, "comm": r.2, "cpu_secs": r.0});
    let speech: Vec<_> = rows.iter().filter(|r| is_speech_service(&r.2)).collect();
    let speech_secs = speech.iter().fold(0.0, |a, r| a + r.0);
    json!({
        "speech_services_cpu_secs": speech_secs,
        "speech_services_cpu_percent_of_one_core": speech_secs / wall * 100.0,
        "speech_services": speech.iter().map(|r| fmt(r)).collect::<Vec<_>>(),
        "top_processes": rows.iter().take(12).map(fmt).collect::<Vec<_>>(),
        // Other agents build on this machine; record how busy it was.
        "loadavg_at_end": sh("sysctl", &["-n", "vm.loadavg"]),
    })
}

// ---------------------------------------------------------------------------
// ground truth
// ---------------------------------------------------------------------------

/// Speech onset/offset of the clip in seconds: first/last 20 ms frame above 20 % of peak RMS.
/// (jfk.wav: 0.34 s / 10.18 s; 10 % would count the crowd noise in its last 0.3 s as speech.)
pub fn clip_speech_bounds(clip_16k: &[f32]) -> (f64, f64) {
    let f = (VAD_RATE / 50) as usize;
    let rms: Vec<f32> = clip_16k.chunks(f).map(|c| (c.iter().map(|x| x * x).sum::<f32>() / c.len() as f32).sqrt()).collect();
    let peak = rms.iter().cloned().fold(0.0, f32::max);
    let on = rms.iter().position(|v| *v > peak * 0.2).unwrap_or(0);
    let off = rms.iter().rposition(|v| *v > peak * 0.2).unwrap_or(0) + 1;
    (on as f64 * 0.02, (off as f64 * 0.02).min(clip_16k.len() as f64 / VAD_RATE as f64))
}

fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

/// Word error rate (Levenshtein over words) of `hyp` against `reference`.
fn wer(hyp: &[String], reference: &[String]) -> f64 {
    let mut prev: Vec<usize> = (0..=hyp.len()).collect();
    for (i, r) in reference.iter().enumerate() {
        let mut cur = vec![i + 1; hyp.len() + 1];
        for (j, h) in hyp.iter().enumerate() {
            cur[j + 1] = (prev[j] + (r != h) as usize).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[hyp.len()] as f64 / reference.len().max(1) as f64
}

/// Engine-independent metrics against the fixture's known speech boundaries.
/// `partials` are (arrival_ms, reported_end_ms); use NaN when the engine reports no range.
pub fn gt_metrics(finals: &[Final], partials: &[(f64, f64)], repeats: usize, period_secs: f64, bounds: (f64, f64)) -> Value {
    let (mut end_lat, mut first_partial, mut first_text, mut cadence) = (vec![], vec![], vec![], vec![]);
    let mut missing_final = 0;
    for r in 0..repeats {
        let o = (r as f64 * period_secs + bounds.0) * 1000.0;
        let e = (r as f64 * period_secs + bounds.1) * 1000.0;
        // The final that carries the repeat's last words.
        match finals.iter().filter(|f| f.1 > e - 500.0 && f.0 < e).map(|f| f.2).reduce(f64::min) {
            Some(ready) => end_lat.push(ready - e),
            None => missing_final += 1,
        }
        // A burst of partials within 50 ms is one visible caption update.
        let mut ps: Vec<f64> = Vec::new();
        for (a, end) in partials {
            if *a > o && *a < e + 1000.0 && (end.is_nan() || *end > o) && ps.last().map_or(true, |l| a - l > 50.0) {
                ps.push(*a);
            }
        }
        if let Some(p) = ps.first() {
            first_partial.push(p - o);
        }
        cadence.extend(ps.windows(2).map(|w| w[1] - w[0]));
        let ff = finals.iter().filter(|f| f.0 >= o - 200.0).map(|f| f.2).fold(f64::INFINITY, f64::min);
        let t = ff.min(ps.first().copied().unwrap_or(f64::INFINITY));
        if t.is_finite() {
            first_text.push(t - o);
        }
    }
    let hyp = words(&finals.iter().map(|f| f.3.as_str()).collect::<Vec<_>>().join(" "));
    let reference = words(&vec![REFERENCE; repeats].join(" "));
    json!({
        "speech_onset_in_clip_secs": bounds.0,
        "speech_offset_in_clip_secs": bounds.1,
        "utterance_end_to_final_ms": summarize(&end_lat),
        "utterances_without_final": missing_final,
        "speech_start_to_first_partial_ms": summarize(&first_partial),
        "speech_start_to_first_text_ms": summarize(&first_text),
        "caption_update_interval_ms": summarize(&cadence),
        "words_hyp": hyp.len(),
        "words_ref": reference.len(),
        "wer": wer(&hyp, &reference),
    })
}

// ---------------------------------------------------------------------------
// synthetic keyboard typing (--typing)
// ---------------------------------------------------------------------------

/// Keystroke peak relative to the speech clip's peak (each key 0.5-1.0x of this).
const TYPING_LEVEL: f32 = 0.7;
/// Typing-only stretch before the first clip and after the last one.
const TYPING_ONLY_SECS: f64 = 6.0;

/// xorshift with a fixed seed: the typing track is identical across runs.
struct Rng(u64);
impl Rng {
    fn f(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.f()
    }
}

/// One keystroke: 5-15 ms of white noise under a 1.5-4 ms exponential decay (the
/// broadband click) plus a 150-400 Hz damped "thock". Peak is roughly `amp`.
fn add_click(out: &mut [f32], at: usize, amp: f32, rng: &mut Rng) {
    let rate = CAPTURE_RATE as f32;
    let n = (rng.range(5.0, 15.0) * rate / 1000.0) as usize;
    let tau = rng.range(1.5, 4.0) / 1000.0;
    let freq = rng.range(150.0, 400.0);
    for i in 0..n {
        let Some(s) = out.get_mut(at + i) else { break };
        let t = i as f32 / rate;
        let click = rng.range(-1.0, 1.0) * (-t / tau).exp();
        let thock = 0.5 * (std::f32::consts::TAU * freq * t).sin() * (-t / (2.0 * tau)).exp();
        *s += amp * (click + thock);
    }
}

/// Synthetic laptop typing at 48 kHz (no recordings of people). Words of 2-8 keys at
/// 80-250 ms spacing, 250-700 ms between words and a 1-2.5 s pause 15 % of the time.
/// Each key is a press at `peak` x U(0.5, 1.0) and a release 60-130 ms later at 40 %.
pub fn synth_typing(len: usize, peak: f32) -> Vec<f32> {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let ms = |x: f32| (x * CAPTURE_RATE as f32 / 1000.0) as usize;
    let mut out = vec![0f32; len];
    let mut at = ms(rng.range(0.0, 300.0));
    while at < len {
        for _ in 0..2 + (rng.f() * 7.0) as usize {
            let amp = peak * rng.range(0.5, 1.0);
            add_click(&mut out, at, amp, &mut rng);
            let release = at + ms(rng.range(60.0, 130.0));
            add_click(&mut out, release, amp * 0.4, &mut rng);
            at += ms(rng.range(80.0, 250.0));
        }
        at += ms(if rng.f() < 0.15 { rng.range(1000.0, 2500.0) } else { rng.range(250.0, 700.0) });
    }
    out
}

/// Finals outside every clip span (typing-only / silent stretches), and finals per clip.
fn fragmentation(finals: &[Final], clips: &[(f64, f64)]) -> Value {
    let overlaps = |f: &Final, c: &(f64, f64)| f.0 < c.1 && c.0 < f.1;
    let per_clip: Vec<f64> = clips.iter().map(|c| finals.iter().filter(|f| overlaps(f, c)).count() as f64).collect();
    json!({
        "finals_outside_speech": finals.iter().filter(|f| !clips.iter().any(|c| overlaps(f, c))).count(),
        "finals_per_utterance": summarize(&per_clip),
    })
}

// ---------------------------------------------------------------------------
// apple phases
// ---------------------------------------------------------------------------

async fn start(locale: &str, partials: bool) -> Result<(SpeechSession, f64)> {
    let t = Instant::now();
    let s = SpeechSession::start(locale, partials).await.map_err(|e| anyhow!("Apple Speech start: {}", e))?;
    Ok((s, t.elapsed().as_secs_f64() * 1000.0))
}

async fn next_event(source: &mut Option<Source>) -> (Option<app_lib::apple_speech::SpeechEvent>, Option<usize>) {
    match source {
        Some(s) => s.next_event().await,
        None => std::future::pending().await,
    }
}

/// A capture chunk as the pipeline delivers it; `index` counts chunks of this source.
fn chunk(data: Vec<f32>, index: usize, device_type: DeviceType) -> AudioChunk {
    let end = ((index + 1) * CHUNK_SAMPLES) as f64 / CAPTURE_RATE as f64;
    AudioChunk { data, sample_rate: CAPTURE_RATE, timestamp: end, chunk_id: index as u64, device_type }
}

/// Shadow copy of the app's gate (deterministic) to record which audio was fed, in ms.
fn track_runs(gate: &mut SpeechGate, data: &[f32], ts: f64, runs: &mut Vec<(f64, f64)>) {
    if !gate.process(data.to_vec(), ts, CAPTURE_RATE) {
        return;
    }
    for (samples, at) in gate.pending.drain(..) {
        let (start, end) = (at * 1000.0, (at + samples.len() as f64 / CAPTURE_RATE as f64) * 1000.0);
        match runs.last_mut() {
            Some(run) if (run.1 - start).abs() < 0.01 => run.1 = end,
            _ => runs.push((start, end)),
        }
    }
}

fn fed_secs(runs: &[(f64, f64)]) -> f64 {
    runs.iter().map(|r| (r.1 - r.0) / 1000.0).sum()
}

/// Two sources (mic + system) fed digital silence, real-time paced.
async fn idle_phase(locale: &str, secs: u64, partials: bool) -> Result<Value> {
    let (mic, mic_ms) = start(locale, partials).await?;
    let (sys, sys_ms) = start(locale, partials).await?;
    let mut sources = [Source::new("microphone", mic, partials), Source::new("system", sys, partials)];
    let silence = vec![0f32; CHUNK_SAMPLES];
    let chunk_dur = Duration::from_secs_f64(CHUNK_SAMPLES as f64 / CAPTURE_RATE as f64);
    let ticks = (secs as f64 / chunk_dur.as_secs_f64()) as usize;
    let mut results = 0usize;
    let (mut gate, mut runs) = (SpeechGate::new(), vec![]);

    let ps0 = ps_cpu();
    let watcher = ThreadWatcher::start();
    let (u0, s0) = cpu_time();
    let t0 = Instant::now();
    for i in 0..ticks {
        track_runs(&mut gate, &silence, (i * CHUNK_SAMPLES) as f64 / CAPTURE_RATE as f64, &mut runs);
        for (source, device) in sources.iter_mut().zip([DeviceType::Microphone, DeviceType::System]) {
            source.accept(locale, chunk(silence.clone(), i, device), 0.0, partials).await.map_err(|e| anyhow!(e))?;
            while let Some((event, from)) = source.next_event().now_or_never() {
                if let Step::Final { .. } | Step::Partial { .. } = source.on_event(event, from).map_err(|e| anyhow!(e))? {
                    results += 1;
                }
            }
        }
        tokio::time::sleep_until((t0 + chunk_dur * (i as u32 + 1)).into()).await;
    }
    let wall = t0.elapsed().as_secs_f64();
    let (u1, s1) = cpu_time();
    let peak_threads = watcher.stop();
    let services = cpu_deltas(&ps0, wall);
    for mut source in sources {
        source.finish();
        while !source.is_done() {
            let (event, from) = tokio::time::timeout(Duration::from_secs(30), source.next_event()).await?;
            source.on_event(event, from).map_err(|e| anyhow!(e))?;
        }
    }
    let cpu = (u1 - u0) + (s1 - s0);
    Ok(json!({
        "wall_secs": wall,
        "cpu_user_secs": u1 - u0,
        "cpu_sys_secs": s1 - s0,
        "cpu_secs": cpu,
        "cpu_percent_of_one_core": cpu / wall * 100.0,
        "peak_threads": peak_threads,
        "chunks_per_session": ticks,
        "secs_fed_to_recognizer_per_session": fed_secs(&runs),
        "sessions": 2,
        "session_start_ms": [mic_ms, sys_ms],
        "results_on_silence": results,
        "other_processes": services,
    }))
}

/// Mic session fed the synthetic meeting (same DSP and pacing as `live_phase`), plus a
/// system session fed silence, through the app's bounded queue and event loop.
async fn live_phase(locale: &str, meeting: Vec<f32>, dsp: String, partials_requested: bool) -> Result<(Value, Vec<Final>, Vec<(f64, f64)>)> {
    let audio_secs = meeting.len() as f64 / CAPTURE_RATE as f64;
    let (mic, mic_ms) = start(locale, partials_requested).await?;
    let (sys, sys_ms) = start(locale, partials_requested).await?;
    let (mut mic, mut sys) = (Some(Source::new("microphone", mic, partials_requested)), Some(Source::new("system", sys, partials_requested)));
    let (mut mic_gate, mut sys_gate) = (SpeechGate::new(), SpeechGate::new());
    let (mut mic_runs, mut sys_runs) = (vec![], vec![]);
    let mut restarts = [0u32; 2];
    // apple.rs bounds each source to ~10 s of queued audio (470 x 1024-sample chunks).
    let (tx, mut rx) = tokio::sync::mpsc::channel::<(bool, Vec<f32>)>(2 * 470);

    let ps0 = ps_cpu();
    let watcher = ThreadWatcher::start();
    let (u0, s0) = cpu_time();
    let t0 = Instant::now();

    let feeder = tokio::task::spawn_blocking(move || -> Result<()> {
        let mut hpf = HighPassFilter::new(CAPTURE_RATE, 80.0);
        let mut norm = LoudnessNormalizer::new(1, CAPTURE_RATE).map_err(|e| anyhow!("normalizer: {}", e))?;
        let chunk_dur = Duration::from_secs_f64(CHUNK_SAMPLES as f64 / CAPTURE_RATE as f64);
        for (i, chunk) in meeting.chunks(CHUNK_SAMPLES).enumerate() {
            let processed = match dsp.as_str() {
                "none" => chunk.to_vec(),
                "hpf" => hpf.process(chunk),
                "norm" => norm.normalize_loudness(chunk),
                _ => norm.normalize_loudness(&hpf.process(chunk)),
            };
            let n = processed.len();
            // The pipeline uses try_send; the app skips and re-anchors on overflow, never seen here.
            tx.try_send((true, processed)).map_err(|_| anyhow!("input queue overflow at chunk {}", i))?;
            tx.try_send((false, vec![0f32; n])).map_err(|_| anyhow!("input queue overflow at chunk {}", i))?;
            let deadline = t0 + chunk_dur * (i as u32 + 1);
            if let Some(d) = deadline.checked_duration_since(Instant::now()) {
                std::thread::sleep(d);
            }
        }
        Ok(())
    });

    let ms = |t: Instant| t.duration_since(t0).as_secs_f64() * 1000.0;
    let (mut mic_chunks, mut sys_chunks) = (0usize, 0usize);
    let mut input_open = true;
    let mut input_closed_ms = f64::NAN;
    let mut finals: Vec<Final> = Vec::new();
    let mut partials: Vec<(f64, f64)> = Vec::new();
    let mut partial_texts: Vec<String> = Vec::new();
    let mut sys_results = 0usize;
    let mut sys_text_results = 0usize;
    let mut deadline = None;
    while mic.is_some() || sys.is_some() {
        tokio::select! {
            input = rx.recv(), if input_open => match input {
                Some((is_mic, data)) => {
                    let (source, index, gate, runs, device) = if is_mic {
                        (&mut mic, &mut mic_chunks, &mut mic_gate, &mut mic_runs, DeviceType::Microphone)
                    } else {
                        (&mut sys, &mut sys_chunks, &mut sys_gate, &mut sys_runs, DeviceType::System)
                    };
                    track_runs(gate, &data, (*index * CHUNK_SAMPLES) as f64 / CAPTURE_RATE as f64, runs);
                    if let Some(s) = source {
                        s.accept(locale, chunk(data, *index, device), 0.0, partials_requested).await.map_err(|e| anyhow!(e))?;
                    }
                    *index += 1;
                }
                None => {
                    input_open = false;
                    input_closed_ms = ms(Instant::now());
                    for s in [&mic, &sys].into_iter().flatten() { s.finish(); }
                    deadline = Some(tokio::time::Instant::now() + Duration::from_secs(30));
                }
            },
            (ev, from) = next_event(&mut mic), if mic.is_some() => {
                let src = mic.as_mut().unwrap();
                match src.on_event(ev, from).map_err(|e| anyhow!("mic: {}", e))? {
                    Step::Final { text, start, end } => finals.push((start * 1000.0, end * 1000.0, ms(Instant::now()), text, !input_open)),
                    Step::Partial { text, end, .. } => {
                        partials.push((ms(Instant::now()), end * 1000.0));
                        if partial_texts.len() < 5 { partial_texts.push(text); }
                    }
                    Step::Ended if input_open => return Err(anyhow!("mic session ended early")),
                    Step::Ended | Step::Nothing => {}
                }
                if src.is_done() { restarts[0] = src.restarts; mic = None; }
            },
            (ev, from) = next_event(&mut sys), if sys.is_some() => {
                let src = sys.as_mut().unwrap();
                match src.on_event(ev, from).map_err(|e| anyhow!("system: {}", e))? {
                    // Non-empty text from a source fed digital silence would be a hallucination.
                    Step::Final { .. } | Step::Partial { .. } => { sys_results += 1; sys_text_results += 1; }
                    Step::Ended if input_open => return Err(anyhow!("system session ended early")),
                    Step::Ended | Step::Nothing => {}
                }
                if src.is_done() { restarts[1] = src.restarts; sys = None; }
            },
            _ = tokio::time::sleep_until(deadline.unwrap_or_else(tokio::time::Instant::now)), if deadline.is_some() => {
                return Err(anyhow!("Apple Speech did not finish within 30 s of end of input"));
            }
        }
    }
    feeder.await.map_err(|e| anyhow!("feeder join: {}", e))??;
    let wall = t0.elapsed().as_secs_f64();
    let (u1, s1) = cpu_time();
    let peak_threads = watcher.stop();
    let services = cpu_deltas(&ps0, wall);
    let cpu = (u1 - u0) + (s1 - s0);

    let se: Vec<f64> = finals.iter().map(|f| f.2 - f.1).collect();
    let ss: Vec<f64> = finals.iter().map(|f| f.2 - f.0).collect();
    let live = json!({
        "audio_secs": audio_secs,
        "wall_secs": wall,
        "sessions": 2,
        "session_start_ms": [mic_ms, sys_ms],
        "input_closed_ms": input_closed_ms,
        "stop_drain_ms": wall * 1000.0 - input_closed_ms,
        "finals": finals.len(),
        "finals_after_input_closed": finals.iter().filter(|f| f.4).count(),
        "partials": partials.len(),
        "partials_requested": partials_requested,
        "secs_fed_to_recognizer": {"microphone": fed_secs(&mic_runs), "system": fed_secs(&sys_runs)},
        "microphone_fed_runs_ms": mic_runs,
        "session_restarts": {"microphone": restarts[0], "system": restarts[1]},
        "system_session_results_on_silence": sys_results,
        "system_session_text_results_on_silence": sys_text_results,
        "speech_secs_total": finals.iter().map(|f| (f.1 - f.0) / 1000.0).sum::<f64>(),
        "cpu_user_secs": u1 - u0,
        "cpu_sys_secs": s1 - s0,
        "cpu_secs": cpu,
        "cpu_percent_of_one_core": cpu / wall * 100.0,
        "peak_threads": peak_threads,
        "stats": {
            "speech_end_to_text_ms": summarize(&se),
            "speech_start_to_text_ms": summarize(&ss),
            "segment_audio_secs": summarize(&finals.iter().map(|f| (f.1 - f.0) / 1000.0).collect::<Vec<_>>()),
        },
        "segments": finals.iter().map(|f| json!({
            "start_ms": f.0, "end_ms": f.1, "ready_ms": f.2, "after_input_closed": f.4,
            "speech_end_to_text_ms": f.2 - f.1, "speech_start_to_text_ms": f.2 - f.0, "text": f.3,
        })).collect::<Vec<_>>(),
        "partial_texts": partial_texts,
        "other_processes": services,
    });
    Ok((live, finals, partials))
}

pub async fn run(args: &Args, machine: Value, meeting: Vec<f32>, clip_16k: &[f32], period_secs: f64, wav: &Path) -> Result<()> {
    let locale = args.model.clone().unwrap_or_else(|| "en_US".into());
    let partials = !args.captions_off;
    let preset = if partials {
        "timeIndexedProgressiveTranscription (volatileResults, fastResults, audioTimeRange)"
    } else {
        "finals only (audioTimeRange)"
    };
    println!("  {:<16} Apple Speech {} (SpeechAnalyzer, {})\n", "engine", locale, preset);

    println!("[1/2] idle cost: {}s of silence through 2 Apple sessions...", args.idle_secs);
    let idle = idle_phase(&locale, args.idle_secs, partials).await?;

    // --typing: typing-only lead and tail, keystrokes over the whole mic track.
    let lead_secs = if args.typing { TYPING_ONLY_SECS } else { 0.0 };
    let mut meeting = meeting;
    if args.typing {
        let pad = vec![0f32; (TYPING_ONLY_SECS * CAPTURE_RATE as f64) as usize];
        meeting = [pad.as_slice(), &meeting, &pad].concat();
        let peak = clip_16k.iter().fold(0f32, |m, x| m.max(x.abs()));
        let keys = synth_typing(meeting.len(), peak * TYPING_LEVEL);
        for (m, k) in meeting.iter_mut().zip(keys) {
            *m = (*m + k).clamp(-1.0, 1.0);
        }
    }
    let clip_ms = clip_16k.len() as f64 * 1000.0 / VAD_RATE as f64;
    let clips: Vec<(f64, f64)> = (0..args.repeats)
        .map(|r| ((lead_secs + r as f64 * period_secs) * 1000.0, (lead_secs + r as f64 * period_secs) * 1000.0 + clip_ms))
        .collect();

    println!("[2/2] live simulation ({:.0}s of audio, real-time paced, mic + silent system session)...", meeting.len() as f64 / CAPTURE_RATE as f64);
    let (mut live, finals, partials) = live_phase(&locale, meeting, args.dsp.clone(), partials).await?;
    live["fragmentation"] = fragmentation(&finals, &clips);
    // Ground truth is on the clip grid; shift the typing-only lead out.
    let lead_ms = lead_secs * 1000.0;
    let shifted: Vec<Final> = finals.iter().map(|f| (f.0 - lead_ms, f.1 - lead_ms, f.2 - lead_ms, f.3.clone(), f.4)).collect();
    let shifted_partials: Vec<(f64, f64)> = partials.iter().map(|p| (p.0 - lead_ms, p.1 - lead_ms)).collect();
    live["ground_truth"] = gt_metrics(&shifted, &shifted_partials, args.repeats, period_secs, clip_speech_bounds(clip_16k));

    let report = json!({
        "generated_at": chrono::Utc::now().to_rfc3339(),
        "machine": machine,
        "config": {
            "engine": "apple",
            "model": locale,
            "preset": preset,
            "captions_off": args.captions_off,
            "dsp": args.dsp,
            "capture_rate_hz": CAPTURE_RATE,
            "chunk_samples": CHUNK_SAMPLES,
            "fixture": wav.display().to_string(),
            "repeats": args.repeats,
            "gap_ms": args.gap_ms,
            "idle_secs": args.idle_secs,
            "typing": args.typing,
            "typing_level": if args.typing { TYPING_LEVEL } else { 0.0 },
            "typing_only_secs_each_end": lead_secs,
        },
        "idle": idle,
        "live": live,
    });

    let f = |v: &Value| v.as_f64().unwrap_or(f64::NAN);
    let (idle, live, gt) = (&report["idle"], &report["live"], &report["live"]["ground_truth"]);
    println!("IDLE (2 Apple sessions, {} s of silence)", args.idle_secs);
    println!("  App CPU:        {:.3} s over {:.1} s wall = {:.2}% of one core", f(&idle["cpu_secs"]), f(&idle["wall_secs"]), f(&idle["cpu_percent_of_one_core"]));
    println!("  Speech svcs:    {:.2}% of one core", f(&idle["other_processes"]["speech_services_cpu_percent_of_one_core"]));
    println!("  Peak threads:   {}   results on silence: {}   secs fed per session: {}", idle["peak_threads"], idle["results_on_silence"], idle["secs_fed_to_recognizer_per_session"]);
    println!("\nLIVE SIMULATION");
    println!("  Audio:          {:.1} s   Wall: {:.1} s   Finals: {} ({} after input closed)   Partials: {}",
        f(&live["audio_secs"]), f(&live["wall_secs"]), live["finals"], live["finals_after_input_closed"], live["partials"]);
    println!("  Session start:  {} ms", live["session_start_ms"]);
    println!("  Speech final:   {:.1} s   words {}/{}   WER {:.3}", f(&live["speech_secs_total"]), gt["words_hyp"], gt["words_ref"], f(&gt["wer"]));
    println!("  App CPU:        {:.3} s over {:.1} s wall = {:.2}% of one core", f(&live["cpu_secs"]), f(&live["wall_secs"]), f(&live["cpu_percent_of_one_core"]));
    println!("  Speech svcs:    {:.3} s = {:.2}% of one core  {}", f(&live["other_processes"]["speech_services_cpu_secs"]),
        f(&live["other_processes"]["speech_services_cpu_percent_of_one_core"]), live["other_processes"]["speech_services"]);
    println!("  Peak threads:   {}", live["peak_threads"]);
    println!("  Secs fed:       {}   restarts: {}   mic runs (ms): {}", live["secs_fed_to_recognizer"], live["session_restarts"], live["microphone_fed_runs_ms"]);
    println!("  Fragmentation:  finals outside speech {}   finals per utterance {}   system text results on silence {}",
        live["fragmentation"]["finals_outside_speech"], live["fragmentation"]["finals_per_utterance"], live["system_session_text_results_on_silence"]);
    println!("  latencies (ms):");
    for k in ["speech_end_to_text_ms", "speech_start_to_text_ms"] {
        println!("{}", row(k, &live["stats"][k], 1));
    }
    for k in ["utterance_end_to_final_ms", "speech_start_to_first_partial_ms", "speech_start_to_first_text_ms", "caption_update_interval_ms"] {
        println!("{}", row(k, &gt[k], 1));
    }

    if let Some(out) = &args.out {
        if let Some(dir) = out.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(out, serde_json::to_string_pretty(&report)?)?;
        println!("\nwrote {}", out.display());
    }
    Ok(())
}
