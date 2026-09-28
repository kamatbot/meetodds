//! `--engine apple` for perf_baseline, plus the ground-truth metrics shared with the
//! Parakeet run.
//!
//! Drives the app's real `app_lib::apple_speech::SpeechSession` (the compiled Swift
//! bridge) the way `audio/transcription/apple.rs` does: one continuous session per
//! source, a bounded 128-chunk input queue fed with `try_send`, sample-clock
//! timestamps, partials = `live-transcript-preview`, finals = `transcript-update`.
//! Recognition runs partly out of process, so besides getrusage this also diffs
//! per-process CPU time (`ps`) across each phase.
//!
//! ponytail: the event loop mirrors apple.rs instead of calling `PreparedApple::spawn`,
//! which needs a live Tauri `AppHandle`. Keep the two in step.

use super::*;
use app_lib::apple_speech::{SpeechEvent, SpeechSession};
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
// apple phases
// ---------------------------------------------------------------------------

async fn start(locale: &str) -> Result<(SpeechSession, f64)> {
    let t = Instant::now();
    let s = SpeechSession::start(locale, true).await.map_err(|e| anyhow!("Apple Speech start: {}", e))?;
    Ok((s, t.elapsed().as_secs_f64() * 1000.0))
}

async fn next_event(session: &mut Option<SpeechSession>) -> Option<SpeechEvent> {
    match session {
        Some(s) => s.events.recv().await,
        None => std::future::pending().await,
    }
}

/// Finish and wait for `Finished` on every session (30 s, as apple.rs).
async fn drain(sessions: Vec<SpeechSession>) -> Result<()> {
    for mut s in sessions {
        s.finish();
        loop {
            match tokio::time::timeout(Duration::from_secs(30), s.events.recv()).await {
                Ok(Some(SpeechEvent::Finished)) => break,
                Ok(Some(SpeechEvent::Error { message })) => return Err(anyhow!(message)),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => return Err(anyhow!("Apple Speech did not finish")),
            }
        }
    }
    Ok(())
}

/// Two sessions (mic + system) fed digital silence, real-time paced.
async fn idle_phase(locale: &str, secs: u64) -> Result<Value> {
    let (mic, mic_ms) = start(locale).await?;
    let (sys, sys_ms) = start(locale).await?;
    let mut sessions = vec![mic, sys];
    let silence = vec![0f32; CHUNK_SAMPLES];
    let chunk_dur = Duration::from_secs_f64(CHUNK_SAMPLES as f64 / CAPTURE_RATE as f64);
    let ticks = (secs as f64 / chunk_dur.as_secs_f64()) as usize;
    let mut results = 0usize;

    let ps0 = ps_cpu();
    let watcher = ThreadWatcher::start();
    let (u0, s0) = cpu_time();
    let t0 = Instant::now();
    for i in 0..ticks {
        let ts = (i * CHUNK_SAMPLES) as f64 / CAPTURE_RATE as f64;
        for s in sessions.iter_mut() {
            s.push(&silence, CAPTURE_RATE, ts).map_err(|e| anyhow!(e))?;
            while let Ok(ev) = s.events.try_recv() {
                match ev {
                    SpeechEvent::Result { .. } => results += 1,
                    SpeechEvent::Error { message } => return Err(anyhow!(message)),
                    _ => {}
                }
            }
        }
        tokio::time::sleep_until((t0 + chunk_dur * (i as u32 + 1)).into()).await;
    }
    let wall = t0.elapsed().as_secs_f64();
    let (u1, s1) = cpu_time();
    let peak_threads = watcher.stop();
    let services = cpu_deltas(&ps0, wall);
    drain(sessions).await?;
    let cpu = (u1 - u0) + (s1 - s0);
    Ok(json!({
        "wall_secs": wall,
        "cpu_user_secs": u1 - u0,
        "cpu_sys_secs": s1 - s0,
        "cpu_secs": cpu,
        "cpu_percent_of_one_core": cpu / wall * 100.0,
        "peak_threads": peak_threads,
        "chunks_fed": ticks,
        "sessions": 2,
        "session_start_ms": [mic_ms, sys_ms],
        "results_on_silence": results,
        "other_processes": services,
    }))
}

/// Mic session fed the synthetic meeting (same DSP and pacing as `live_phase`), plus a
/// system session fed silence, through the app's bounded queue and event loop.
async fn live_phase(locale: &str, meeting: Vec<f32>, dsp: String) -> Result<(Value, Vec<Final>, Vec<(f64, f64)>)> {
    let audio_secs = meeting.len() as f64 / CAPTURE_RATE as f64;
    let (mic, mic_ms) = start(locale).await?;
    let (sys, sys_ms) = start(locale).await?;
    let (mut mic, mut sys) = (Some(mic), Some(sys));
    // audio/transcription/apple.rs:57 — one bounded queue for both sources.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<(bool, Vec<f32>)>(128);

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
            // Pipeline uses try_send: overflow ends Apple transcription (pipeline.rs:941).
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
    let (mut mic_clock, mut sys_clock) = (0usize, 0usize);
    let mut input_open = true;
    let mut input_closed_ms = f64::NAN;
    let mut final_end = -1.0;
    let mut finals: Vec<Final> = Vec::new();
    let mut partials: Vec<(f64, f64)> = Vec::new();
    let mut partial_texts: Vec<String> = Vec::new();
    let mut sys_results = 0usize;
    // Non-empty text from a session fed digital silence would be a hallucination.
    let mut sys_text_results = 0usize;
    let mut deadline = None;
    while mic.is_some() || sys.is_some() {
        tokio::select! {
            chunk = rx.recv(), if input_open => match chunk {
                Some((is_mic, data)) => {
                    let (session, clock) = if is_mic { (&mic, &mut mic_clock) } else { (&sys, &mut sys_clock) };
                    if let Some(s) = session {
                        s.push(&data, CAPTURE_RATE, *clock as f64 / CAPTURE_RATE as f64).map_err(|e| anyhow!(e))?;
                    }
                    *clock += data.len();
                }
                None => {
                    input_open = false;
                    input_closed_ms = ms(Instant::now());
                    for s in [&mic, &sys].into_iter().flatten() { s.finish(); }
                    deadline = Some(tokio::time::Instant::now() + Duration::from_secs(30));
                }
            },
            ev = next_event(&mut mic), if mic.is_some() => match ev {
                Some(SpeechEvent::Result { text, start, end, is_final }) => {
                    let now = ms(Instant::now());
                    // Same acceptance as audio/transcription/apple.rs:205.
                    let valid = !text.trim().is_empty() && start.is_finite() && end >= start && end > final_end;
                    if valid && is_final {
                        final_end = end;
                        finals.push((start * 1000.0, end * 1000.0, now, text.trim().to_owned(), !input_open));
                    } else if valid {
                        partials.push((now, end * 1000.0));
                        if partial_texts.len() < 5 { partial_texts.push(text.trim().to_owned()); }
                    }
                }
                Some(SpeechEvent::Finished) => mic = None,
                Some(SpeechEvent::Error { message }) => return Err(anyhow!("mic: {}", message)),
                None => return Err(anyhow!("mic session disconnected or its result queue overflowed")),
                _ => {}
            },
            ev = next_event(&mut sys), if sys.is_some() => match ev {
                Some(SpeechEvent::Result { text, .. }) => {
                    sys_results += 1;
                    sys_text_results += !text.trim().is_empty() as usize;
                }
                Some(SpeechEvent::Finished) => sys = None,
                Some(SpeechEvent::Error { message }) => return Err(anyhow!("system: {}", message)),
                None => return Err(anyhow!("system session disconnected or its result queue overflowed")),
                _ => {}
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
    println!("  {:<16} Apple Speech {} (SpeechAnalyzer, bridge preset timeIndexedProgressiveTranscription)\n", "engine", locale);

    println!("[1/2] idle cost: {}s of silence through 2 Apple sessions...", args.idle_secs);
    let idle = idle_phase(&locale, args.idle_secs).await?;

    println!("[2/2] live simulation ({:.0}s of audio, real-time paced, mic + silent system session)...", meeting.len() as f64 / CAPTURE_RATE as f64);
    let (mut live, finals, partials) = live_phase(&locale, meeting, args.dsp.clone()).await?;
    live["ground_truth"] = gt_metrics(&finals, &partials, args.repeats, period_secs, clip_speech_bounds(clip_16k));

    let report = json!({
        "generated_at": chrono::Utc::now().to_rfc3339(),
        "machine": machine,
        "config": {
            "engine": "apple",
            "model": locale,
            "preset": "timeIndexedProgressiveTranscription (volatileResults, fastResults, audioTimeRange)",
            "dsp": args.dsp,
            "capture_rate_hz": CAPTURE_RATE,
            "chunk_samples": CHUNK_SAMPLES,
            "fixture": wav.display().to_string(),
            "repeats": args.repeats,
            "gap_ms": args.gap_ms,
            "idle_secs": args.idle_secs,
        },
        "idle": idle,
        "live": live,
    });

    let f = |v: &Value| v.as_f64().unwrap_or(f64::NAN);
    let (idle, live, gt) = (&report["idle"], &report["live"], &report["live"]["ground_truth"]);
    println!("IDLE (2 Apple sessions, {} s of silence)", args.idle_secs);
    println!("  App CPU:        {:.3} s over {:.1} s wall = {:.2}% of one core", f(&idle["cpu_secs"]), f(&idle["wall_secs"]), f(&idle["cpu_percent_of_one_core"]));
    println!("  Speech svcs:    {:.2}% of one core", f(&idle["other_processes"]["speech_services_cpu_percent_of_one_core"]));
    println!("  Peak threads:   {}   results on silence: {}", idle["peak_threads"], idle["results_on_silence"]);
    println!("\nLIVE SIMULATION");
    println!("  Audio:          {:.1} s   Wall: {:.1} s   Finals: {} ({} after input closed)   Partials: {}",
        f(&live["audio_secs"]), f(&live["wall_secs"]), live["finals"], live["finals_after_input_closed"], live["partials"]);
    println!("  Session start:  {} ms", live["session_start_ms"]);
    println!("  Speech final:   {:.1} s   words {}/{}   WER {:.3}", f(&live["speech_secs_total"]), gt["words_hyp"], gt["words_ref"], f(&gt["wer"]));
    println!("  App CPU:        {:.3} s over {:.1} s wall = {:.2}% of one core", f(&live["cpu_secs"]), f(&live["wall_secs"]), f(&live["cpu_percent_of_one_core"]));
    println!("  Speech svcs:    {:.3} s = {:.2}% of one core  {}", f(&live["other_processes"]["speech_services_cpu_secs"]),
        f(&live["other_processes"]["speech_services_cpu_percent_of_one_core"]), live["other_processes"]["speech_services"]);
    println!("  Peak threads:   {}", live["peak_threads"]);
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
