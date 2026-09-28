# Apple Speech vs Parakeet: live transcription on M1 Max

Apple M1 Max (10 cores, 32 GB), macOS 27.0 (26A428), release build, 2026-09-27/28.
Branch `perf/apple-speech`. English (en_US) Apple speech assets were already installed;
nothing was downloaded, no settings were changed and the microphone was not opened.

## Method

`frontend/src-tauri/tools/perf_baseline.rs` (`--engine apple` lives in `perf_baseline_apple.rs`).
Both engines get the same synthetic meeting: `tests/fixtures/jfk.wav` repeated 6 times with
1.5 s gaps (74.9 s), resampled to 48 kHz, 1024-sample chunks, app mic DSP (high-pass +
loudness), fed in real time.

- **Apple**: the app's real `SpeechSession` (compiled Swift bridge, SpeechAnalyzer preset
  `timeIndexedProgressiveTranscription`). Mic session gets the meeting, system session gets
  digital silence, through one bounded 128-chunk queue, as in `audio/transcription/apple.rs`.
- **Parakeet**: `parakeet-tdt-0.6b-v3-int8`, Silero VAD, serial ASR worker, **caption
  preview lane on** (`--preview`), since Apple always produces partials.
- **Idle**: 20 s of digital silence through two sessions (Apple) or two VADs + loaded model (Parakeet).
- **CPU**: getrusage for the harness process, plus `ps` per-process CPU-time deltas for
  Apple's out-of-process recognizer. Counted: `Speech.framework/.../localspeechrecognition`,
  `*speechrecognition*`, `corespeech*`, `aned`; iOS Simulator runtime copies (CoreSimulator paths)
  and text-to-speech services are excluded (fixed in ece580d; run 1 predates the fix, and its
  list holds only `localspeechrecognition` and `aned`, so its numbers are unchanged).
  Both sessions were served by one `localspeechrecognition` instance. `aned` added 0.02 s per run.
- **Ground truth**: speech in the clip runs from 0.34 s to 10.18 s (20 % peak-RMS frames).
  End→final means the clip's last speech frame until the final carrying the last words arrives.
  First partial means speech onset until the first caption. Cadence means the gap between caption
  updates (bursts within 50 ms count as one). WER is measured against the JFK text × 6.

Two runs per engine. Cells show the median of the two runs, with each run's value in parentheses.
Latency percentiles are per run (n = 6 utterances; p95 = max).

## Results

| Metric | Apple Speech | Parakeet (captions on) |
|---|---|---|
| Utterance end → final, median | **530 ms** (528 / 531) | 862 ms (863 / 861) |
| Utterance end → final, p95 = max | 1.50 s (1495 / 1500) | 1.53 s (1456 / 1601) |
| Speech start → first partial, median | **749 ms** (751 / 747) | 992 ms (994 / 989) |
| Caption update interval, median / p95 / max | 960 / 1920 / 1931 ms | 736 / 6166 / 8263 ms |
| App process CPU, live (% of one core) | 2.5 % (2.28 / 2.64) | 23.0 % (24.03 / 22.03) |
| Apple speech services CPU, live | 3.8 % (3.61 / 3.97) | 0 |
| **Total CPU, live** | **6.2 %** | **23.0 %** |
| Idle, 2 silent sessions: app + services | 3.6 % + 4.9 % = **8.5 %** (6.1 / 11.0) | **1.5 %** (1.51 / 1.44) |
| Words / WER vs JFK ×6 | 132/132, **0.0 %** | 128/132, 3.8 % |
| Speech time in finals (reference 59.0 s) | 56.0 s | 49.1 s (VAD segments) |
| Finals | 12 (2 per repeat) | 24 segments |
| Stop: input closed → all sessions finished | 74 / 76 ms | n/a |
| Session start (first / second) | 82–93 ms / 3–4 ms | model load 885 ms |
| Peak threads (harness process) | 19–21 | 29 |

Other observations:

- Apple's timing was almost identical across runs (±5 ms). The 1.5 s p95/max is always
  repeat 1, because Apple put that final's end at 10.68 s, past the true offset. Apple's own
  reported end→final is about 700 ms for sentence-final chunks and about 1040 ms for chunks
  finalized mid-speech.
- Idle cost is at least as high as live cost. Apple analyzes silence as fully as speech.
- The silent system session returned 2 results in run 1 and 1 in run 2. Run 2 counted
  non-empty text: that 1 result was non-empty text from digital zeros. The text was not
  logged. The app would display it as "Other party".
- Parakeet's caption lane has ~6–8 s gaps (p95/max) where Apple updates about every second.

**Caveats (read before quoting numbers).** The machine was shared. Another agent's `rustc`
used about one core (38–75 CPU-s per 75 s run) during Apple runs 1–2 and Parakeet run 2, and
another `perf_baseline` process ran during Parakeet run 1. The 1-minute load average at the end
of each run was 4–9 on 10 cores, and it peaked at 60 earlier in the session. The idle Apple number
(6.1 vs 11.0 %) is the noisiest. `ps` CPU time does not include ANE/GPU work, and energy was not
measured (`powermetrics` needs root). This is a harness, not the packaged app. There was no real
capture device, WebView, or caption rendering.

## Code review: Apple live path (ranked)

1. **Silence is recognized at full cost (largest CPU item in real meetings).**
   `pipeline.rs:937-945` forwards every chunk, and `apple_speech_bridge.swift:172-174` feeds every
   frame to the analyzer. Measured: two silent sessions cost 6–11 % of a core vs 1.5 % for Parakeet's
   VADs. Typically one source is silent most of the time. *Fix:* add Speech's `SpeechDetector` module to
   `SpeechAnalyzer(modules:)` at `bridge.swift:164`, which gates the transcriber on voice activity.
   Alternatively, skip near-zero chunks in Rust before `session.push` at `apple.rs:100-101`. Only the
   first frame carries `bufferStartTime` (`bridge.swift:217`), so after any skipped gap the next frame
   must be re-anchored from the sample clock. *Expected:* service CPU on a silent source drops to near
   zero. This also removes the text returned on digital silence (finding 5). Unverified: measure before and after.
2. **Queue overflow permanently ends live transcription.** The Rust queue holds 128 chunks shared by
   both sources (`apple.rs:57`), which is about 1.4 s per source at 1024 samples / 48 kHz. On overflow
   the sender is dropped (`pipeline.rs:941-944`). Swift allows 128 frames per session
   (`bridge.swift:62`, about 2.7 s), and `.dropped` leads to `fail()` (`bridge.swift:78-81`). Neither
   path restarts, so a 1.4 s stall in the event loop stops captions and the transcript for the rest of
   the meeting. See finding 3 for one source of stalls. No overflow occurred in these runs.
   *Fix:* size both queues by time (for example 10 s, about 470 chunks per source, about 2 MB), and/or
   on overflow start a new session anchored at the sample clock instead of ending. *Expected:* no
   change in normal runs, and a terminal failure mode goes away under load.
3. **Transcript persistence does blocking file I/O inline in the Apple event loop.**
   `app.emit("transcript-update")` (`apple.rs:237`) calls Rust listeners synchronously (tauri 2.11
   `event/listener.rs:196-205`). The listener (`recording_commands.rs:268-291`) re-parses the JSON it
   just serialized, then runs `TranscriptWriter::add_segment` (`recording_saver.rs:159-205`). That call
   does a linear scan of all segments (`:166`), opens the journal per final (`:176-183`), and every
   15 s / 10 segments rewrites the whole snapshot with `sync_all` on the file and its directory
   (`durable_json`, `:47-55`). Meanwhile the same `select!` cannot push audio. *Fix:* hand segments to
   a dedicated writer (`spawn_blocking` or a thread with a channel) that keeps the journal open. Pass the
   struct rather than re-parsing. *Expected:* no multi-ms fsync stalls on the audio feed path, and
   `O(N)` per-final work leaves the loop. Parakeet shares this path.
4. **Volatile results are always requested, then dropped when captions are off.**
   `timeIndexedProgressiveTranscription` (`bridge.swift:160`) requests volatile and fast results.
   `apple.rs:244` discards partials unless `PREVIEW_GATE` is open. There were 162 partials per 75 s:
   each is JSON-encoded in Swift (`bridge.swift:11-15,139`), parsed in Rust
   (`apple_speech.rs:92-93`) and routed through the global `CALLBACKS` mutex (`:98`).
   *Fix:* when captions are off at start, build the transcriber with
   `transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange]` (finals only).
   Captions can be toggled mid-meeting, so keep volatile results on while captions may turn on, or
   restart sessions on toggle. *Expected:* less recognizer work with captions off. The effect on final
   latency is unknown. Unverified.
5. **Bug (low): the silent system session can emit text.** Run 2 returned 1 non-empty result from
   digital zeros. `valid_result` (`apple.rs:187-189`) accepts it, so it is displayed and persisted as
   "Other party". Fixed by finding 1's gating.
6. **Per-chunk copies (low CPU; app process is 2.3–2.6 % including harness DSP).** For each 1024-sample
   chunk and session: Rust passes a slice (no copy), and Swift copies it to `[Float]` (`bridge.swift:72`).
   Swift then allocates an `AVAudioFormat` and `AVAudioPCMBuffer` and copies again (`:192-195`),
   allocates the output buffer (`:204`) and resamples 48→16 kHz. The `AVAudioConverter` is stateful
   and reused (`:198-202`), which is good. *Fix (only if profiling shows it):* cache the input format
   and write directly into the PCM buffer. The converter tail is never flushed at end of input
   (`:206-209` never signals `.endOfStream`), which loses a few ms at stop. Negligible.
7. **No latency added by the app.** The event loop is `select!`-driven (`apple.rs:92-128`), with no
   polling or sleeps. Timeouts are 30 s for start (`apple_speech.rs:163`), 30 s for finish
   (`apple.rs:110`) and 10 min for stop (`recording_commands.rs:634`), plus a harmless 500 ms progress
   ticker (`:616`). Two sessions start serially (`apple.rs:47-56`) in about 85 ms + 4 ms, which is fine.
   Apple's endpointing sets final latency. Stop drains in about 75 ms. The per-session result channel
   (256, `apple_speech.rs:127`) closes on overflow instead of dropping finals. Correct, and far from full
   at about 2 events/s.

## Reproduce

```bash
cd frontend/src-tauri
export CARGO_TARGET_DIR=/Users/mk/Documents/notes/target TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":[]}}'
cargo build --release --locked --example perf_baseline
$CARGO_TARGET_DIR/release/examples/perf_baseline --engine apple --out ../../docs/perf/apple-speech-m1max-apple-run2.json
$CARGO_TARGET_DIR/release/examples/perf_baseline --engine parakeet --preview --out ../../docs/perf/apple-speech-m1max-parakeet-run2.json
```

Data: `apple-speech-m1max-{apple,parakeet}.json` (run 1, harness at 2bcc2e0) and
`apple-speech-m1max-{apple,parakeet}-run2.json` (run 2, harness code of ece580d, run before
it was committed, so the files' `git_commit` field still reads 2bcc2e0).
