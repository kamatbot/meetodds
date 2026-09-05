# Live transcription baseline — main

Reproducible baseline for the live transcription path (mic DSP → Silero VAD →
serial ASR worker), measured with `frontend/src-tauri/tools/perf_baseline.rs`.

Numbers here are the "before" side of the live-transcription optimisation work.
Anyone comparing a branch should re-run the exact commands below on the same
machine and diff against `baseline-main-parakeet.json`.

## Machine and build

| | |
|---|---|
| CPU | Apple M4, 10 logical cores |
| Memory | 16 GiB |
| OS | macOS 26.6.2 (25G83) |
| Baseline commit | `cede393` `fix(meeting): restore open folder action` |
| Harness commit | `99a1fa1` `perf(bench): add live transcription baseline harness` |
| Build profile | release |
| rustc | 1.98.0 (88d9e12ae 2026-08-18) (Homebrew) |
| Engine | Parakeet `parakeet-tdt-0.6b-v3-int8` (the app default), loaded in 620 ms |
| VAD redemption | 1200 ms — the value `AudioPipeline::new` uses on macOS |

> The task brief named `f62dd49` as the baseline commit. This worktree's HEAD is
> `cede393`, which is a **descendant** of `f62dd49` (91 commits ahead, including
> `3ce7dc7 perf(whisper): cap Apple Silicon decoder CPU` and
> `295804b perf(audio): reduce macOS VAD decode frequency`). The numbers below
> are for `cede393`. Re-baseline if a strict `f62dd49` comparison is needed.

## Workload

`backend/whisper.cpp/samples/jfk.wav` (11.0 s, 16 kHz mono) resampled to 48 kHz
and repeated 6× with 1.5 s of silence between repeats → a 74.9 s synthetic
meeting containing ~66 s of speech. Fed in 1024-sample chunks (21.3 ms) paced in
real time, through `HighPassFilter(48 kHz, 80 Hz)` → `LoudnessNormalizer(1, 48 kHz)`
→ `ContinuousVadProcessor::new(48000, 1200)`, exactly as the microphone path
does. Emitted segments are decoded one at a time on a single worker, matching
`NUM_WORKERS == 1` in `audio/transcription/worker.rs`.

## 1. Idle cost — the headline number

Model loaded, two `ContinuousVadProcessor`s (mic + system, as the pipeline runs
them), 20 s of **digital silence** at 48 kHz, real-time paced.

| Metric | Value |
|---|---|
| CPU (user+sys, `getrusage`) | **19.62 s over 20.0 s wall = 98.1 % of one core** |
| Peak process threads | **48** |
| Chunks fed | 937 |

**The app burns roughly one full core doing nothing.** Silence produces no
speech segments and therefore no ASR work, so essentially all of this is VAD
session overhead — ONNX Runtime thread-pool spin-wait across ~48 threads on a
10-core machine. This is the single largest available win and it is independent
of decode speed.

The first run of the harness (same commit, same binary) measured 109.5 % / 48
threads, so treat ~100 % ± 10 as the idle band rather than a precise figure.

## 2. Live simulation

74.9 s of audio, real-time paced, 8 segments emitted and 8 decoded, 13.1 s of
speech actually reaching the ASR.

| Metric | Value |
|---|---|
| Wall time | 74.9 s |
| CPU (user+sys) | 48.39 s = **64.6 % of one core** |
| Peak threads | 46 |
| Segments emitted / decoded | 8 / 8 (no drops in the queue) |

| Stat (ms unless noted) | median | p95 | max |
|---|---|---|---|
| segment audio (s) | 1.42 | 4.39 | 4.39 |
| queue wait | 0.01 | 0.02 | 0.02 |
| decode | 80.2 | 178.1 | 178.1 |
| RTF (decode / audio) | 0.0573 | 0.0596 | 0.0596 |
| VAD close → transcript | 80.3 | 178.1 | 178.1 |
| **speech end → transcript** | **937.2** | **1017.2** | **1017.2** |
| speech start → transcript | 2337.6 | 5407.2 | 5407.2 |

Reading these three latency measures:

- **VAD close → transcript** (~80 ms) is decode plus queueing. Decode is not the
  bottleneck; RTF is ~0.06.
- **speech end → transcript** (~937 ms) is what a user perceives. It is
  dominated by the VAD's redemption timer, not by ASR. Lowering
  `redemption_time` moves this number almost 1:1; nothing else will.
- **speech start → transcript** (2.3 s median, 5.4 s worst) is redemption plus
  the segment's own length.

Live CPU (64.6 %) is *lower* than idle CPU (98.1 %) because the live phase runs
one VAD session while the idle phase runs two — consistent with the idle cost
being per-VAD-session, roughly 50 % of a core each.

## 3. Batch decode (warmup isolation)

The raw 11.0 s clip, decoded 5× back to back.

| Metric | Value |
|---|---|
| decode median | 357.5 ms |
| decode p95 / max | 377.8 ms |
| RTF median | 0.0325 |
| first call | 377.8 ms |
| subsequent mean / max | 356.6 ms / 360.1 ms |
| warmup overhead | 21.1 ms |

Parakeet has essentially no per-call warmup once the model is loaded (~6 % on
the first decode). Model load itself is 620 ms, paid once.

## Anomalies for the optimiser to be aware of

1. **The VAD swallows ~80 % of the speech.** The meeting contains ~66 s of
   speech; only 13.1 s reached the ASR across 8 segments. The transcripts show
   what happened — most segments are the tail fragment of an utterance:

   | # | start→end (ms) | dur (s) | text |
   |---|---|---|---|
   | 0 | 60 → 1630 | 1.57 | `And so my fellow` |
   | 1 | 6210 → 10600 | 4.39 | `can do for you and what you can do for your country.` |
   | 2 | 13560 → 14980 | 1.42 | `My fellow Americans.` |
   | 3 | 19320 → 20380 | 1.06 | `for you.` |
   | 4 | 31350 → 32830 | 1.48 | `can do for you` |
   | 5 | 44280 → 45340 | 1.06 | `for you` |
   | 6 | 56760 → 57790 | 1.03 | `for you` |
   | 7 | 69210 → 70270 | 1.06 | `for you.` |

   Repeats 4–6 produce a single 1-second `for you` each, from an 11-second clip.
   Whatever the cause (VAD thresholds, the EBU R128 normalizer's gain ramp
   interacting with the detector, or `resample_to_16k`), it means the live path
   is losing most of what is said. Any comparison run must check
   `speech_secs_total` and `segments_decoded`, not just latency — a change that
   "improves" latency by emitting even fewer segments is a regression.

2. **CPU numbers vary ~10 % run to run** on this machine. Two runs of the
   identical binary gave 109.5 % and 98.1 % idle CPU. Compare medians of several
   runs before calling a CPU change real.

3. **Redemption is platform-dependent.** `AudioPipeline::new` uses 1200 ms on
   macOS and 400 ms elsewhere. The harness defaults to the platform value and
   records it in the JSON; pass `--redemption-ms` explicitly when comparing
   across platforms.

4. The `speech_end_to_text_ms` measure uses the VAD's own
   `end_timestamp_ms`, which already includes `post_speech_pad` (400 ms). It is
   therefore a slight over-estimate of true acoustic-end-to-text, but it is
   consistent across runs and is the right thing to compare.

## Commands

Build and run (Parakeet, the app default):

```
cd frontend/src-tauri && cargo run --release --example perf_baseline -- \
  --engine parakeet --out ../../docs/perf/baseline-main-parakeet.json
```

Full acceptance check as run for this baseline:

```
cd frontend/src-tauri && cargo build --release --example perf_baseline 2>&1 | tail -3 \
  && cargo run --release --example perf_baseline -- --engine parakeet \
       --out ../../docs/perf/baseline-main-parakeet.json 2>&1 | tail -40 \
  && test -s ../../docs/perf/baseline-main-parakeet.json && echo ACCEPT_OK
```

To compare another branch, write to a different file and diff the JSON:

```
cd frontend/src-tauri && cargo run --release --example perf_baseline -- \
  --engine parakeet --out ../../docs/perf/branch-<name>-parakeet.json
```

Useful flags: `--engine whisper --model small`, `--redemption-ms`, `--repeats`,
`--gap_ms`, `--idle-secs`, `--batch-iters`, `--wav <path>`.

Note: every `cargo` invocation in this repo re-runs the `meetily` build script
and rebuilds `app_lib` (~2 min), because the build script's
`rerun-if-changed` set is always dirty. For repeat measurement runs, invoke the
built binary directly from `frontend/src-tauri` to skip that:

```
cd frontend/src-tauri && ../../target/release/examples/perf_baseline \
  --engine parakeet --out ../../docs/perf/branch-<name>-parakeet.json
```

## Not measured

- **Whisper.** No ggml model is present in
  `~/Library/Application Support/com.meetily.ai/models/`, and the Parakeet run
  (the app default) was the required deliverable. `--engine whisper --model
  small` is implemented and compiles but is **unverified** — it has never been
  executed.
- **Real capture.** The harness feeds synthetic audio; it does not exercise
  cpal, ScreenCaptureKit, the mixer, or the system-audio capture path.
- **The `system` VAD under load.** The live phase runs the mic path only, as the
  fixture is a single channel. The idle phase runs both, which is where the
  two-session cost shows up.
