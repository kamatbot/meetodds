//! Live-transcription performance baseline harness.
//!
//! Measures the cost of the app's live path (mic DSP -> Silero VAD -> serial ASR worker)
//! without Tauri, audio hardware, or the UI in the way.
//!
//! Run:
//!   cargo run --release --bin perf_baseline -- --engine parakeet --out ../../docs/perf/baseline-main-parakeet.json
//!   cargo run --release --bin perf_baseline -- --engine whisper --model small --out ../../docs/perf/baseline-main-whisper-small.json
//!
//! ponytail: deliberately boring. No bench framework, no abstractions beyond the one
//! engine enum. Everything is measured with getrusage + Instant + `ps -M`.

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use app_lib::audio::audio_processing::{resample_audio, HighPassFilter, LoudnessNormalizer};
use app_lib::audio::vad::{ContinuousVadProcessor, SpeechSegment};
use app_lib::config::DEFAULT_PARAKEET_MODEL;
use app_lib::parakeet_engine::parakeet_engine::ParakeetEngine;
use app_lib::whisper_engine::whisper_engine::WhisperEngine;

/// Capture chunk fed per tick, matching a typical cpal callback size.
const CHUNK_SAMPLES: usize = 1024;
const CAPTURE_RATE: u32 = 48_000;
const VAD_RATE: u32 = 16_000;

/// Mirrors `AudioPipeline::new` on macOS (400 elsewhere). Overridable so a
/// comparison run on another branch can pin the same value.
const DEFAULT_REDEMPTION_MS: u32 = app_lib::audio::pipeline::LIVE_VAD_REDEMPTION_MS;

#[derive(Parser, Debug)]
#[command(about = "Baseline CPU/latency harness for the live transcription path")]
struct Args {
    /// ASR engine to exercise.
    #[arg(long, default_value = "parakeet")]
    engine: String,

    /// Model name. Defaults to the app default for the chosen engine.
    #[arg(long)]
    model: Option<String>,

    /// Where to write the JSON report.
    #[arg(long)]
    out: Option<PathBuf>,

    /// 16 kHz mono WAV fixture used to build the synthetic meeting.
    #[arg(long)]
    wav: Option<PathBuf>,

    /// VAD redemption time, ms. Default matches the app for this platform.
    #[arg(long, default_value_t = DEFAULT_REDEMPTION_MS)]
    redemption_ms: u32,

    /// Number of clip repeats in the synthetic meeting.
    #[arg(long, default_value_t = 6)]
    repeats: usize,

    /// Silence inserted between repeats, ms.
    #[arg(long, default_value_t = 1500)]
    gap_ms: u32,

    /// Seconds of digital silence for the idle-cost measurement.
    #[arg(long, default_value_t = 20)]
    idle_secs: u64,

    /// Batch micro-benchmark iterations.
    #[arg(long, default_value_t = 5)]
    batch_iters: usize,

    /// Mic DSP applied before the VAD: full (high-pass + loudness, as the app
    /// does), hpf, norm, or none.
    #[arg(long, default_value = "full")]
    dsp: String,
}

// ---------------------------------------------------------------------------
// process metrics
// ---------------------------------------------------------------------------

/// (user, system) CPU seconds consumed by this process so far.
fn cpu_time() -> (f64, f64) {
    unsafe {
        let mut ru: libc::rusage = std::mem::zeroed();
        libc::getrusage(libc::RUSAGE_SELF, &mut ru);
        let s = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
        (s(ru.ru_utime), s(ru.ru_stime))
    }
}

fn thread_count() -> usize {
    // ponytail: `ps -M` forks, but children don't pollute RUSAGE_SELF.
    let pid = std::process::id();
    std::process::Command::new("ps")
        .args(["-M", &pid.to_string()])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().count().saturating_sub(1))
        .unwrap_or(0)
}

/// Samples thread count in the background until stopped; returns the peak.
struct ThreadWatcher {
    stop: Arc<AtomicBool>,
    peak: Arc<AtomicUsize>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl ThreadWatcher {
    fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let peak = Arc::new(AtomicUsize::new(0));
        let (s, p) = (stop.clone(), peak.clone());
        let handle = std::thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                let n = thread_count();
                p.fetch_max(n, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(500));
            }
        });
        Self { stop, peak, handle: Some(handle) }
    }

    fn stop(mut self) -> usize {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        self.peak.load(Ordering::Relaxed)
    }
}

fn sh(cmd: &str, args: &[&str]) -> String {
    std::process::Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn machine_info() -> Value {
    json!({
        "cpu": sh("sysctl", &["-n", "machdep.cpu.brand_string"]),
        "logical_cores": sh("sysctl", &["-n", "hw.logicalcpu"]),
        "physical_cores": sh("sysctl", &["-n", "hw.physicalcpu"]),
        "memory_bytes": sh("sysctl", &["-n", "hw.memsize"]),
        "os": format!("macOS {} ({})", sh("sw_vers", &["-productVersion"]), sh("sw_vers", &["-buildVersion"])),
        "git_commit": sh("git", &["rev-parse", "HEAD"]),
        "git_describe": sh("git", &["log", "-1", "--pretty=%h %s"]),
        "build_profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "rustc": sh("rustc", &["--version"]),
    })
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

/// Minimal 16-bit PCM WAV reader. Returns (mono f32 samples, sample rate).
fn read_wav(path: &Path) -> Result<(Vec<f32>, u32)> {
    let b = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err(anyhow!("{} is not a RIFF/WAVE file", path.display()));
    }
    let u16at = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
    let u32at = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);

    let (mut channels, mut rate, mut bits) = (0u16, 0u32, 0u16);
    let mut data: Option<(usize, usize)> = None;
    let mut p = 12usize;
    while p + 8 <= b.len() {
        let id = &b[p..p + 4];
        let len = u32at(p + 4) as usize;
        let body = p + 8;
        if id == b"fmt " && body + 16 <= b.len() {
            channels = u16at(body + 2);
            rate = u32at(body + 4);
            bits = u16at(body + 14);
        } else if id == b"data" {
            data = Some((body, len.min(b.len().saturating_sub(body))));
        }
        p = body + len + (len & 1);
    }
    let (off, len) = data.ok_or_else(|| anyhow!("no data chunk in {}", path.display()))?;
    if bits != 16 {
        return Err(anyhow!("only 16-bit PCM supported, got {} bits", bits));
    }
    let ch = channels.max(1) as usize;
    let frames = len / 2 / ch;
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let mut acc = 0f32;
        for c in 0..ch {
            let i = off + (f * ch + c) * 2;
            acc += i16::from_le_bytes([b[i], b[i + 1]]) as f32 / 32768.0;
        }
        out.push(acc / ch as f32);
    }
    Ok((out, rate))
}

fn find_fixture(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(p) = explicit {
        return if p.exists() { Ok(p) } else { Err(anyhow!("{} not found", p.display())) };
    }
    // Relative to frontend/src-tauri, then the primary checkout (fixture is untracked there).
    let candidates = [
        "../../frontend/src-tauri/tests/fixtures/jfk.wav",
        "/Volumes/SSD/MeetingRecorder/frontend/src-tauri/tests/fixtures/jfk.wav",
    ];
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
        .ok_or_else(|| anyhow!("jfk.wav fixture not found; pass --wav"))
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

enum Engine {
    Parakeet(ParakeetEngine),
    Whisper(WhisperEngine),
}

impl Engine {
    async fn transcribe(&self, samples: Vec<f32>) -> Result<String> {
        match self {
            Engine::Parakeet(e) => e.transcribe_audio(samples).await,
            Engine::Whisper(e) => e
                .transcribe_audio_with_confidence(samples, Some("en".to_string()))
                .await
                .map(|(text, _, _)| text),
        }
    }
}

fn models_root() -> Result<PathBuf> {
    // Matches the app: Tauri app_data_dir == ~/Library/Application Support/com.meetily.ai
    Ok(dirs::data_dir()
        .ok_or_else(|| anyhow!("no data dir"))?
        .join("com.meetily.ai")
        .join("models"))
}

async fn load_engine(kind: &str, model: Option<String>) -> Result<(Engine, String)> {
    let root = models_root()?;
    match kind {
        "parakeet" => {
            let name = model.unwrap_or_else(|| DEFAULT_PARAKEET_MODEL.to_string());
            let engine = ParakeetEngine::new_with_models_dir(Some(root))?;
            engine.discover_models().await?;
            if engine.load_model(&name).await.is_err() {
                eprintln!("model {} not ready; downloading (this is large)...", name);
                engine.download_model(&name, None).await?;
                engine.discover_models().await?;
                engine.load_model(&name).await?;
            }
            Ok((Engine::Parakeet(engine), name))
        }
        "whisper" => {
            let name = model.unwrap_or_else(|| app_lib::config::DEFAULT_WHISPER_MODEL.to_string());
            let engine = WhisperEngine::new_with_models_dir(Some(root))?;
            engine.discover_models().await?;
            engine.load_model(&name).await?;
            Ok((Engine::Whisper(engine), name))
        }
        other => Err(anyhow!("unknown engine '{}'", other)),
    }
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let i = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[i]
}

fn summarize(vals: &[f64]) -> Value {
    let mut v = vals.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    json!({
        "n": v.len(),
        "min": v.first().copied().unwrap_or(f64::NAN),
        "median": pct(&v, 0.5),
        "p95": pct(&v, 0.95),
        "max": v.last().copied().unwrap_or(f64::NAN),
        "mean": if v.is_empty() { f64::NAN } else { v.iter().sum::<f64>() / v.len() as f64 },
    })
}

fn row(label: &str, s: &Value, prec: usize) -> String {
    let g = |k: &str| s[k].as_f64().unwrap_or(f64::NAN);
    format!(
        "  {:<34} n={:<3} median={:>9.*}  p95={:>9.*}  max={:>9.*}",
        label,
        s["n"].as_u64().unwrap_or(0),
        prec,
        g("median"),
        prec,
        g("p95"),
        prec,
        g("max")
    )
}

// ---------------------------------------------------------------------------
// phases
// ---------------------------------------------------------------------------

/// Feed digital silence through two VADs, paced in real time, exactly as the
/// pipeline does with a mic + system stream. Isolates idle thread-pool cost.
fn idle_phase(redemption_ms: u32, secs: u64) -> Result<Value> {
    let mut mic = ContinuousVadProcessor::new(CAPTURE_RATE, redemption_ms)?;
    let mut sys = ContinuousVadProcessor::new(CAPTURE_RATE, redemption_ms)?;
    let silence = vec![0f32; CHUNK_SAMPLES];
    let chunk_dur = Duration::from_secs_f64(CHUNK_SAMPLES as f64 / CAPTURE_RATE as f64);
    let ticks = (secs as f64 / chunk_dur.as_secs_f64()) as usize;

    let watcher = ThreadWatcher::start();
    let (u0, s0) = cpu_time();
    let t0 = Instant::now();
    for i in 0..ticks {
        mic.process_audio(&silence)?;
        sys.process_audio(&silence)?;
        let deadline = t0 + chunk_dur * (i as u32 + 1);
        if let Some(d) = deadline.checked_duration_since(Instant::now()) {
            std::thread::sleep(d);
        }
    }
    let wall = t0.elapsed().as_secs_f64();
    let (u1, s1) = cpu_time();
    let peak_threads = watcher.stop();

    let cpu = (u1 - u0) + (s1 - s0);
    Ok(json!({
        "wall_secs": wall,
        "cpu_user_secs": u1 - u0,
        "cpu_sys_secs": s1 - s0,
        "cpu_secs": cpu,
        "cpu_percent_of_one_core": cpu / wall * 100.0,
        "peak_threads": peak_threads,
        "chunks_fed": ticks,
        "vad_sessions": 2,
    }))
}

struct Seg {
    idx: usize,
    samples: Vec<f32>,
    audio_secs: f64,
    start_ms: f64,
    end_ms: f64,
    emitted_at: Instant,
}

/// Feed the synthetic meeting through the mic DSP chain + VAD in real time,
/// decoding emitted segments serially on a worker task (NUM_WORKERS == 1).
async fn live_phase(
    engine: Arc<Engine>,
    meeting_48k: Vec<f32>,
    redemption_ms: u32,
    dsp: String,
) -> Result<Value> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Seg>();
    let audio_secs = meeting_48k.len() as f64 / CAPTURE_RATE as f64;

    let watcher = ThreadWatcher::start();
    let (u0, s0) = cpu_time();
    let t0 = Instant::now();

    // Feeder: blocking DSP + VAD, real-time paced.
    let feeder = tokio::task::spawn_blocking(move || -> Result<usize> {
        let mut hpf = HighPassFilter::new(CAPTURE_RATE, 80.0);
        let mut norm = LoudnessNormalizer::new(1, CAPTURE_RATE)
            .map_err(|e| anyhow!("normalizer: {}", e))?;
        let mut vad = ContinuousVadProcessor::new(CAPTURE_RATE, redemption_ms)?;
        let chunk_dur = Duration::from_secs_f64(CHUNK_SAMPLES as f64 / CAPTURE_RATE as f64);
        let mut idx = 0usize;

        let emit = |segs: Vec<SpeechSegment>, idx: &mut usize| {
            for s in segs {
                let audio_secs = s.samples.len() as f64 / VAD_RATE as f64;
                let _ = tx.send(Seg {
                    idx: *idx,
                    samples: s.samples,
                    audio_secs,
                    start_ms: s.start_timestamp_ms,
                    end_ms: s.end_timestamp_ms,
                    emitted_at: Instant::now(),
                });
                *idx += 1;
            }
        };

        for (i, chunk) in meeting_48k.chunks(CHUNK_SAMPLES).enumerate() {
            let processed = match dsp.as_str() {
                "none" => chunk.to_vec(),
                "hpf" => hpf.process(chunk),
                "norm" => norm.normalize_loudness(chunk),
                _ => norm.normalize_loudness(&hpf.process(chunk)),
            };
            emit(vad.process_audio(&processed)?, &mut idx);
            let deadline = t0 + chunk_dur * (i as u32 + 1);
            if let Some(d) = deadline.checked_duration_since(Instant::now()) {
                std::thread::sleep(d);
            }
        }
        emit(vad.flush()?, &mut idx);
        Ok(idx)
    });

    // Worker: serial FIFO decode, mirroring audio/transcription/worker.rs.
    let mut records: Vec<Value> = Vec::new();
    let mut vad_close_ms = Vec::new();
    let mut speech_end_ms = Vec::new();
    let mut speech_start_ms = Vec::new();
    let mut decode_ms = Vec::new();
    let mut rtfs = Vec::new();
    let mut queue_ms = Vec::new();

    while let Some(seg) = rx.recv().await {
        let picked_up = Instant::now();
        let d0 = Instant::now();
        let text = engine
            .transcribe(seg.samples)
            .await
            .unwrap_or_else(|e| format!("<error: {}>", e));
        let decode = d0.elapsed().as_secs_f64() * 1000.0;
        let ready = t0.elapsed().as_secs_f64() * 1000.0;

        let vc = ready - seg.emitted_at.duration_since(t0).as_secs_f64() * 1000.0;
        let se = ready - seg.end_ms;
        let ss = ready - seg.start_ms;
        let q = picked_up.duration_since(seg.emitted_at).as_secs_f64() * 1000.0;
        let rtf = decode / 1000.0 / seg.audio_secs;

        vad_close_ms.push(vc);
        speech_end_ms.push(se);
        speech_start_ms.push(ss);
        decode_ms.push(decode);
        queue_ms.push(q);
        rtfs.push(rtf);

        records.push(json!({
            "index": seg.idx,
            "audio_secs": seg.audio_secs,
            "vad_start_ms": seg.start_ms,
            "vad_end_ms": seg.end_ms,
            "queue_wait_ms": q,
            "decode_ms": decode,
            "rtf": rtf,
            "vad_close_to_text_ms": vc,
            "speech_end_to_text_ms": se,
            "speech_start_to_text_ms": ss,
            "text": text,
        }));
    }

    let emitted = feeder.await.map_err(|e| anyhow!("feeder join: {}", e))??;
    let wall = t0.elapsed().as_secs_f64();
    let (u1, s1) = cpu_time();
    let peak_threads = watcher.stop();
    let cpu = (u1 - u0) + (s1 - s0);

    Ok(json!({
        "audio_secs": audio_secs,
        "wall_secs": wall,
        "segments_emitted": emitted,
        "segments_decoded": records.len(),
        "speech_secs_total": records.iter().filter_map(|r| r["audio_secs"].as_f64()).sum::<f64>(),
        "cpu_user_secs": u1 - u0,
        "cpu_sys_secs": s1 - s0,
        "cpu_secs": cpu,
        "cpu_percent_of_one_core": cpu / wall * 100.0,
        "peak_threads": peak_threads,
        "stats": {
            "vad_close_to_text_ms": summarize(&vad_close_ms),
            "speech_end_to_text_ms": summarize(&speech_end_ms),
            "speech_start_to_text_ms": summarize(&speech_start_ms),
            "queue_wait_ms": summarize(&queue_ms),
            "decode_ms": summarize(&decode_ms),
            "rtf": summarize(&rtfs),
            "segment_audio_secs": summarize(&records.iter().filter_map(|r| r["audio_secs"].as_f64()).collect::<Vec<_>>()),
        },
        "segments": records,
    }))
}

/// Decode the raw clip N times back to back: isolates warmup vs steady state.
async fn batch_phase(engine: &Engine, clip_16k: &[f32], iters: usize) -> Result<Value> {
    let audio_secs = clip_16k.len() as f64 / VAD_RATE as f64;
    let mut times = Vec::new();
    let mut text = String::new();
    for _ in 0..iters {
        let t = Instant::now();
        text = engine.transcribe(clip_16k.to_vec()).await?;
        times.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let rest = &times[1.min(times.len())..];
    let mean = |v: &[f64]| if v.is_empty() { f64::NAN } else { v.iter().sum::<f64>() / v.len() as f64 };
    Ok(json!({
        "clip_secs": audio_secs,
        "iterations": iters,
        "decode_ms_all": times,
        "decode_ms": summarize(&times),
        "rtf": summarize(&times.iter().map(|t| t / 1000.0 / audio_secs).collect::<Vec<_>>()),
        "first_call_ms": times.first().copied().unwrap_or(f64::NAN),
        "subsequent_mean_ms": mean(rest),
        "subsequent_max_ms": rest.iter().cloned().fold(f64::NAN, f64::max),
        "warmup_overhead_ms": times.first().copied().unwrap_or(f64::NAN) - mean(rest),
        "text": text,
    }))
}

// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let machine = machine_info();

    println!("=== perf_baseline ===");
    for k in ["cpu", "logical_cores", "memory_bytes", "os", "git_describe", "build_profile", "rustc"] {
        println!("  {:<16} {}", k, machine[k].as_str().unwrap_or("?"));
    }
    println!("  {:<16} {}", "engine", args.engine);
    println!("  {:<16} {} ms", "redemption", args.redemption_ms);

    // Fixture -> synthetic meeting at capture rate.
    let wav_path = find_fixture(args.wav.clone())?;
    let (clip, clip_rate) = read_wav(&wav_path)?;
    let clip_16k = if clip_rate == VAD_RATE { clip.clone() } else { resample_audio(&clip, clip_rate, VAD_RATE) };
    let clip_48k = resample_audio(&clip, clip_rate, CAPTURE_RATE);
    let gap = vec![0f32; (CAPTURE_RATE as u64 * args.gap_ms as u64 / 1000) as usize];
    let mut meeting = Vec::new();
    for _ in 0..args.repeats {
        meeting.extend_from_slice(&clip_48k);
        meeting.extend_from_slice(&gap);
    }
    println!(
        "  {:<16} {} ({:.1}s @ {} Hz) -> meeting {:.1}s @ {} Hz",
        "fixture",
        wav_path.display(),
        clip.len() as f64 / clip_rate as f64,
        clip_rate,
        meeting.len() as f64 / CAPTURE_RATE as f64,
        CAPTURE_RATE
    );

    let load_t = Instant::now();
    let (engine, model_name) = load_engine(&args.engine, args.model.clone()).await?;
    let model_load_ms = load_t.elapsed().as_secs_f64() * 1000.0;
    println!("  {:<16} {} (loaded in {:.0} ms)\n", "model", model_name, model_load_ms);

    println!("[1/3] idle cost: {}s of silence through 2 VAD sessions...", args.idle_secs);
    let idle = idle_phase(args.redemption_ms, args.idle_secs)?;

    println!("[2/3] live simulation ({:.0}s of audio, real-time paced)...", meeting.len() as f64 / CAPTURE_RATE as f64);
    let engine = Arc::new(engine);
    let live = live_phase(engine.clone(), meeting, args.redemption_ms, args.dsp.clone()).await?;

    println!("[3/3] batch decode x{}...\n", args.batch_iters);
    let batch = batch_phase(&engine, &clip_16k, args.batch_iters).await?;

    let report = json!({
        "generated_at": chrono::Utc::now().to_rfc3339(),
        "machine": machine,
        "config": {
            "engine": args.engine,
            "model": model_name,
            "model_load_ms": model_load_ms,
            "redemption_ms": args.redemption_ms,
            "dsp": args.dsp,
            "capture_rate_hz": CAPTURE_RATE,
            "chunk_samples": CHUNK_SAMPLES,
            "fixture": wav_path.display().to_string(),
            "repeats": args.repeats,
            "gap_ms": args.gap_ms,
            "idle_secs": args.idle_secs,
            "batch_iters": args.batch_iters,
        },
        "idle": idle,
        "live": live,
        "batch": batch,
    });

    // ---- human table ----
    println!("IDLE (VADs running, model loaded, {} s of silence)", args.idle_secs);
    println!("  CPU:            {:.3} s over {:.1} s wall = {:.2}% of one core",
        idle["cpu_secs"].as_f64().unwrap(), idle["wall_secs"].as_f64().unwrap(),
        idle["cpu_percent_of_one_core"].as_f64().unwrap());
    println!("  Peak threads:   {}", idle["peak_threads"]);

    println!("\nLIVE SIMULATION");
    println!("  Audio:          {:.1} s   Wall: {:.1} s   Segments: {} emitted / {} decoded",
        live["audio_secs"].as_f64().unwrap(), live["wall_secs"].as_f64().unwrap(),
        live["segments_emitted"], live["segments_decoded"]);
    println!("  Speech decoded: {:.1} s", live["speech_secs_total"].as_f64().unwrap());
    println!("  CPU:            {:.3} s over {:.1} s wall = {:.2}% of one core",
        live["cpu_secs"].as_f64().unwrap(), live["wall_secs"].as_f64().unwrap(),
        live["cpu_percent_of_one_core"].as_f64().unwrap());
    println!("  Peak threads:   {}", live["peak_threads"]);
    println!("  latencies (ms unless noted):");
    for k in ["segment_audio_secs", "queue_wait_ms", "decode_ms", "rtf",
              "vad_close_to_text_ms", "speech_end_to_text_ms", "speech_start_to_text_ms"] {
        println!("{}", row(k, &live["stats"][k], if k == "rtf" { 4 } else { 1 }));
    }

    println!("\nBATCH DECODE ({:.1} s clip x{})", batch["clip_secs"].as_f64().unwrap(), args.batch_iters);
    println!("{}", row("decode_ms", &batch["decode_ms"], 1));
    println!("{}", row("rtf", &batch["rtf"], 4));
    println!("  first call: {:.1} ms   subsequent mean: {:.1} ms   max: {:.1} ms   warmup overhead: {:.1} ms",
        batch["first_call_ms"].as_f64().unwrap(), batch["subsequent_mean_ms"].as_f64().unwrap(),
        batch["subsequent_max_ms"].as_f64().unwrap(), batch["warmup_overhead_ms"].as_f64().unwrap());
    println!("  text: {}", batch["text"].as_str().unwrap_or(""));

    if let Some(out) = args.out {
        if let Some(dir) = out.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&out, serde_json::to_string_pretty(&report)?)?;
        println!("\nwrote {}", out.display());
    }
    Ok(())
}
