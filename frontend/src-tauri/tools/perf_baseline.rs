//! Live-transcription performance baseline harness (Apple Speech).
//!
//! Measures the cost of the app's live path (mic DSP -> Apple SpeechAnalyzer sessions)
//! without Tauri, audio hardware, or the UI in the way. The engine lives in
//! `perf_baseline_apple.rs`.
//!
//! Run:
//!   cargo run --release --example perf_baseline -- --engine apple --out ../../docs/perf/baseline-apple.json
//!
//! ponytail: deliberately boring. No bench framework. Everything is measured with
//! getrusage + Instant + `ps -M`.

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use app_lib::audio::audio_processing::{resample_audio, HighPassFilter, LoudnessNormalizer};

#[path = "perf_baseline_apple.rs"]
mod apple;

/// Capture chunk fed per tick, matching a typical cpal callback size.
const CHUNK_SAMPLES: usize = 1024;
const CAPTURE_RATE: u32 = 48_000;
const VAD_RATE: u32 = 16_000;

#[derive(Parser, Debug)]
#[command(about = "Baseline CPU/latency harness for the live transcription path")]
struct Args {
    /// ASR engine to exercise. Only `apple` remains (model = locale, default en_US).
    #[arg(long, default_value = "apple")]
    engine: String,

    /// Apple Speech locale. Defaults to en_US.
    #[arg(long)]
    model: Option<String>,

    /// Where to write the JSON report.
    #[arg(long)]
    out: Option<PathBuf>,

    /// 16 kHz mono WAV fixture used to build the synthetic meeting.
    #[arg(long)]
    wav: Option<PathBuf>,

    /// Number of clip repeats in the synthetic meeting.
    #[arg(long, default_value_t = 6)]
    repeats: usize,

    /// Silence inserted between repeats, ms.
    #[arg(long, default_value_t = 1500)]
    gap_ms: u32,

    /// Seconds of digital silence for the idle-cost measurement.
    #[arg(long, default_value_t = 20)]
    idle_secs: u64,

    /// Mic DSP applied before ASR: full (high-pass + loudness, as the app
    /// does), hpf, norm, or none.
    #[arg(long, default_value = "full")]
    dsp: String,

    /// Apple only: overlay synthetic keyboard typing on the mic track (over speech and
    /// in the gaps) plus typing-only stretches before and after. See `apple::synth_typing`.
    #[arg(long, default_value_t = false)]
    typing: bool,

    /// Apple only: captions off, so sessions request finals only (no volatile results).
    #[arg(long, default_value_t = false)]
    captions_off: bool,
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

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let machine = machine_info();

    println!("=== perf_baseline ===");
    for k in ["cpu", "logical_cores", "memory_bytes", "os", "git_describe", "build_profile", "rustc"] {
        println!("  {:<16} {}", k, machine[k].as_str().unwrap_or("?"));
    }
    println!("  {:<16} {}", "engine", args.engine);

    // Fixture -> synthetic meeting at capture rate.
    let wav_path = find_fixture(args.wav.clone())?;
    let (clip, clip_rate) = read_wav(&wav_path)?;
    let clip_16k = if clip_rate == VAD_RATE { clip.clone() } else { resample_audio(&clip, clip_rate, VAD_RATE) };
    let clip_48k = resample_audio(&clip, clip_rate, CAPTURE_RATE);
    let gap = vec![0f32; (CAPTURE_RATE as u64 * args.gap_ms as u64 / 1000) as usize];
    let period_secs = (clip_48k.len() + gap.len()) as f64 / CAPTURE_RATE as f64;
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

    if args.engine != "apple" {
        return Err(anyhow!("unknown engine '{}'; only 'apple' is supported", args.engine));
    }
    apple::run(&args, machine, meeting, &clip_16k, period_secs, &wav_path).await
}
