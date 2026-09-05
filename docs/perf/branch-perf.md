# Live transcription — before/after on `perf/live-transcript-cpu-latency`

Same machine, same harness, same synthetic meeting as `baseline-main.md`
(Apple M4, 10 cores, macOS 26.6.2, Parakeet `parakeet-tdt-0.6b-v3-int8`, release).

| | Baseline `cede393` | Branch | Change |
|---|---|---|---|
| Idle CPU (2 VADs, model loaded, 20 s silence) | 98.1 % of one core | **4.0 %** | 25× less |
| Idle peak threads | 48 | 27 | |
| Live CPU (75 s meeting, real-time paced) | 64.6 % of one core | **7.1 %** | 9× less |
| Speech reaching the ASR | 13.1 s (8 segments) | **24.0 s (14 segments)** | normalizer fix |
| Speech end → transcript, median | 937 ms | **289 ms** | |
| Speech end → transcript, p95 | 1017 ms | 319 ms | |
| Decode per segment, median | 80 ms | 86 ms | more speech per segment |
| Batch decode of the 11 s clip, median | 358 ms (RTF 0.033) | 264 ms (RTF 0.024) | no spin-wait contention |

Live CPU rose from the intermediate 5.3 % to 7.1 % only because the normalizer
fix almost doubled the amount of speech actually decoded.

## What changed

1. ONNX Runtime thread pools no longer spin-wait (vendored Silero with one
   thread; Parakeet sequential, spinning off). This is the idle-CPU win.
2. Live Whisper uses greedy decoding with a reused state; inference runs via
   `block_in_place` so it does not stall the audio pipeline task.
3. VAD: redemption 1200 → 300 ms, post-pad 400 → 150 ms, and utterances are
   cut at the first quiet frame after 6 s (hard cut 9 s) so long monologues
   produce text while the speaker is still talking.
4. Microphone loudness target -23 → -16 LUFS. At -23 the normalizer pushed
   speech to a level where Silero missed about half of it — the harness showed
   only 13 s of ~40 s of speech reaching the ASR on the baseline.
5. Core Audio stream yields 1024-sample batches; EBU R128 history capped at 60 s.

## Re-run

```
cd frontend/src-tauri && cargo build --release --example perf_baseline
../../target/release/examples/perf_baseline --engine parakeet --out ../../docs/perf/branch-perf-parakeet.json
```

`--dsp none|hpf|norm|full` isolates the microphone DSP in front of the VAD.
`--redemption-ms` defaults to `audio::pipeline::LIVE_VAD_REDEMPTION_MS`.

## Not covered

- Whisper engine path (no ggml model installed on this machine).
- Real capture (cpal / Core Audio tap) and a real microphone recording in the app.
