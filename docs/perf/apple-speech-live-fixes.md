# Apple Speech live path: silence gate, overflow restart, finals-only captions

Apple M1 Max (10 cores, 32 GB), macOS 27.0, release build, 2026-09-28. Base: 25e5146.
Branch `feat/apple-only-apple-live-fixes`. English (en_US) Apple speech assets were
already installed. Nothing was downloaded and the microphone was not opened.
Follow-up to [apple-speech-m1max.md](apple-speech-m1max.md), findings 1, 2, 4 and 5.

## Changes

1. **Silence gate (`audio/transcription/apple.rs`, `SpeechGate`).** An energy gate runs
   before the recognizer. Audio is fed only around 5 consecutive loud 10 ms frames
   (above -50 dBFS RMS), with 300 ms of pre-roll and 1.5 s of hangover.
   - A keystroke is a click of 15 ms or less, then a gap, then the release. It does not
     light 5 frames in a row, so typing alone does not open the gate or keep it open.
   - Digital zeros never open it, so a silent source costs nothing and cannot produce
     text. Before, the silent system session produced text from digital zeros.
   - Skipped audio is **spliced out** of the session's timeline. The analyzer gets
     contiguous audio, and Rust maps result times back to recording time (`Timeline`).
     Two other designs were measured and rejected:
     - *Anchoring the first buffer after a gap with its true `bufferStartTime`* (the
       original plan): SpeechAnalyzer returned only punctuation for the first utterance
       after 5 of 6 gaps. WER was 0.189 (107/132 words).
     - *A fresh session per speech burst*: accuracy was perfect, but every burst behaved
       like a cold session. End→final was 1332 ms and first partial was 1523 ms.
   - Apple's `SpeechDetector` module was also tried (`SpeechAnalyzer(modules: [detector,
     transcriber])`). Idle service CPU was 5.4 % vs 7.1 %, which is within noise on this
     loaded machine. App-side cost did not change (audio is still converted and sent), so
     the detector was not used.
2. **Overflow does not end live transcription.** Both queues are bounded by audio time:
   10 s per source.
   - Rust queue: `AppleAudioSender` sets a per-source budget. A full queue skips the chunk
     for transcription only, and the next chunk carries the dropped duration. The sample
     clock advances by that duration and the gap is spliced.
   - Swift queue: it is unbounded by frame count and capped at 10 s of queued audio.
     `md_speech_push` returns 0 (accepted), 1 (full) or 2 (closed).
   - When the Swift queue is full, that source's session finishes in the background.
     Its queued audio is still finalized. A new session continues at the sample clock and
     takes the same buffer.
   - Both cases show the existing non-blocking "Transcription performance warning"
     banner (`chunk-drop-warning`) at most every 30 s. Recording saving is independent
     of this path.
3. **Finals only when captions are off.** A session starts with finals only when the
   captions preference (`PREVIEW_GATE.enabled()`, synced before start) is off.
   - Finals-only means `reportingOptions: [.fastResults]` with no `volatileResults`.
   - Toggling captions mid-meeting restarts that source's session at the sample clock.
     The old session finishes its audio (no loss, no duplicate finals: each session keeps
     its own watermark), and its stale partials are dropped.
   - `.fastResults` is kept deliberately. Without it, end→final went from 564 ms to 1556 ms
     (p95 3552 ms).

## Method

Harness: `perf_baseline --engine apple`, the same synthetic meeting as the evaluation.
`tests/fixtures/jfk.wav` is repeated 6 times, resampled to 48 kHz and fed in real time as
1024-sample chunks with the app's mic DSP. The mic source gets the meeting and the system
source gets digital silence. The "after" harness drives the app's own
`transcription::apple::Source` (gate, clock, timeline and restarts). The "before" harness
is the same code with the typing overlay, built against 25e5146.

- **(a)** Meeting with 1.5 s gaps, captions on. It also supplies **(c)**: 20 s idle with
  2 silent sessions.
- **(b)** The same meeting with captions off (`--captions-off`). Before the fix, the
  recognizer did the same work as in (a), because partials were produced and then
  dropped, so the (a) "before" column applies.
- **(d)** `--typing --gap-ms 4000`: synthetic keyboard typing over the whole mic track,
  during speech and in the gaps, plus 6 s of typing only before and after.
  - The typing is deterministic xorshift, from the earlier typing work: 2–8 keys per word
    at 80–250 ms, a press of 5–15 ms of decaying noise plus a 150–400 Hz thock, and a
    release 60–130 ms later at 40 %.
  - Key peaks are 0.35–0.7× the speech peak.
  - The 4 s gaps make the gate close between repeats.

Recognizer CPU is `localspeechrecognition`, from `ps` CPU-time deltas. `aned` is shared
with other clients (for example mediaanalysisd) and is ≤ 0.1 % in every run below.
One run was made per cell.

## Results

| Metric | (a) before | (a) after | (b) after | (d) before | (d) after |
|---|---|---|---|---|---|
| App CPU (harness process), live | 4.44 % | 4.44 % | **3.86 %** | 4.55 % | **3.94 %** |
| `localspeechrecognition` CPU, live | 5.48 % | **4.21 %** | **3.85 %** | 5.46 % | **3.28 %** |
| Audio fed to recognizer (mic / system) | all / all | 74.9 s / **0 s** | 74.9 s / **0 s** | all / all | **78.8 s of 101.9** / **0 s** |
| Utterance end → final, median (p95) | 531 (1507) ms | 564 (1535) ms | 571 (1537) ms | 1091 (1360) ms | **1010** (1362) ms |
| Speech start → first partial, median | 756 ms | 767 ms | none (captions off) | 1270 ms | **892 ms** |
| Words / WER | 132/132, 0.0 % | 132/132, 0.0 % | 132/132, 0.0 % | 132/132, 0.0 % | 132/132, 0.0 % |
| Speech time in finals | 56.1 s | 56.1 s | 56.1 s | 50.6 s | **56.1 s** |
| Partials delivered | 162 | 162 | **0** | 163 | 162 |
| False results (text from the silent source or outside speech) | **1** | 0 | 0 | **1** | 0 |
| Finals per utterance, mean (max) | 2.0 (2) | 2.0 (2) | 2.0 (2) | 2.5 (4) | **1.83** (3) |
| **(c) Idle, 2 silent sessions: app + recognizer** | 3.34 + 4.10 = **7.4 %** | 0.97 + 0.00 = **1.0 %** | | | |
| Load average at end of run (10 cores) | 163 | 3.8 | 3.4 | 93 | 5.4 |

Notes:

- The (a) p95/max of about 1.5 s is repeat 1, a cold session, as in the evaluation.
- In (a), the gate never closes, because 1.5 s gaps plus the clip's trailing room noise
  are within the hangover. The live saving there is the silent system source.
- The remaining idle app CPU (about 1 %) is the harness (pacing, thread sampling). The
  recognizer receives nothing.
- (d) gate behavior, from the fed runs in the JSON:
  - The gate opened once during the 6 s typing-only lead, for 1.8 s at 0.43 s, with no
    text. It extended once, by about 0.7 s, after a clip.
  - Otherwise it opened at each clip's onset and closed 1.5 s after the clip's room noise
    ended.
  - The first (d) final starts at 6.347 s. True speech onset is 6.34 s, so splicing keeps
    timestamps aligned with the recording.
- Latency, WER and fragmentation reproduced within a few ms across repeated runs of the
  same build. CPU did not: the machine was shared with other agents' `rustc` builds, and
  the load average ranged from 4 to 163 during the session. Treat CPU deltas under about
  1 point as noise.
- The finals-only variant without `.fastResults` (JSON `...-after-captions-off-no-fastresults`)
  cut recognizer CPU further (2.36 %). Final latency tripled, so that variant was rejected.

## Not verified

- No real microphone or system capture, packaged app, WebView or caption UI.
- The mid-meeting captions toggle and the warning banner are exercised only by code
  paths and unit tests, not in the GUI.
- Room noise above -50 dBFS after the mic's loudness normalization keeps the gate open,
  so there is no saving (`ponytail:` in `SpeechGate`). No real room was measured.
- The overflow restart is covered by the ignored native test
  `apple_native_full_queue_restarts_without_ending`, which pushes 30 s at once. It never
  triggers at real-time pace in the harness.
- Energy was not measured.

## Reproduce

```bash
cd frontend/src-tauri
export CARGO_TARGET_DIR=$PWD/../../target TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":[]}}'
cargo build --release --locked --example perf_baseline
B=$CARGO_TARGET_DIR/release/examples/perf_baseline
$B --engine apple --out ../../docs/perf/apple-speech-live-fixes-after-meeting.json
$B --engine apple --captions-off --idle-secs 5 --out ../../docs/perf/apple-speech-live-fixes-after-captions-off.json
$B --engine apple --typing --gap-ms 4000 --idle-secs 5 --out ../../docs/perf/apple-speech-live-fixes-after-typing.json
```

The "before" JSONs come from the same harness (without `--captions-off`, which did not
exist at the base) built against 25e5146.
