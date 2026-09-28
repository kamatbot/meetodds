# Live caption preview lane — CPU cost

Apple M4, 10 cores, macOS 26.6.2, Parakeet `parakeet-tdt-0.6b-v3-int8`, release,
same harness and synthetic meeting as `branch-perf.md` (75 s, 14 canonical
segments, 24.0 s of speech).

| | Preview off | Preview on |
|---|---|---|
| Live CPU (75 s meeting, real-time paced) | 6.82 % of one core | **12.66 %** of one core |
| Peak threads | 28 | 29 |
| Speech end → transcript, median | 293 ms | 274 ms |
| Speech decoded | 24.0 s (14 segments) | 24.0 s (14 segments) |
| Preview decodes | — | 26 |
| Preview decode ms, median / p95 | — | 60.6 / 81.6 |
| Preview window, median | — | 0.5 s |

This is a synthetic Parakeet baseline, not a live microphone result and not a
Whisper measurement. It measured the earlier scheduler; the current scheduler
serializes all local preview and canonical inference, so the two never contend
for the model at the same time.

### Apple M1 Max, current scheduler (`perf/asr-lane`)

Same harness, now driving the app's own permit, canonical guard, preview call
and `preview_rest` pacing. 75 s meeting, 24 segments, 49.1 s of speech.
Base = `c9dbbea` (harness only), after = caption preemption + VAD trim.

| | Base | After |
|---|---|---|
| Live CPU, captions on / off | 23.5 % / 8.8 % | 27.5 % / 10.7 % |
| Speech end → transcript, median / max | 377 / 502 ms | 377 / 461 ms |
| Canonical wait for the permit, p95 / max | 48 / 67 ms | 23 / 80 ms |
| Preview decodes (aborted for canonical) | 68 (0) | 68 (4) |
| Speech start → first caption, median / p95 | 979 / 2925 ms | 954 / 2866 ms |
| Caption staleness (between updates), median / p95 | 635 / 1289 ms | 632 / 1250 ms |
| Caption audio lag (emit − snapshot end), median | 79 ms | 65 ms |

CPU moved within run-to-run noise (other builds were running; idle ranged
1.4-4.7 % across repeated runs of one binary). Raw data:
`m1max-asr-lane-base-preview-{on,off}.json`, `m1max-asr-lane-preview-{on,off}.json`.

## How it stays cheap

- Snapshots offered to the preview decoder at most every 600 ms
  (`LIVE_PREVIEW_INTERVAL`).
- Each snapshot is capped to the last 6 s of the open utterance
  (`LIVE_PREVIEW_MAX_WINDOW_MS`), so a long monologue doesn't grow the decode.
- Preview and canonical decodes share a single fair local-inference permit.
  Canonical work queues ahead of new preview work, and a preview releases the
  permit immediately after its decode. This prevents the two local models from
  competing for CPU or GPU.
- A canonical decode counts as busy from the moment it queues. A running preview
  polls that and gives up: Whisper through a whisper.cpp abort callback (checked
  after each encoder/decoder graph), Parakeet after the encoder and before each
  decoder step. So a final transcript waits for at most one encoder pass.
- The channel between VAD and preview decoder is a `tokio::sync::watch`: only
  the newest snapshot is ever pending, so a slow preview decode can't build a
  backlog.
- After every preview decode — including empty, stale, or failed results — the
  lane rests for half its own decode time, clamped to 100-350 ms
  (`live_preview.rs::preview_rest`). The watch channel keeps only the newest
  snapshot that arrived during that rest, so it resumes with the latest audio.
  With ~70 ms Parakeet decodes that means nearly every 600 ms snapshot is
  decoded; captions refresh about every 0.6 s while someone is speaking.
- Nothing in this lane writes to transcripts, notes, or persistence — it only
  emits a display-only `live-transcript-preview` event.

## Re-run

```
cd frontend/src-tauri && cargo build --release --example perf_baseline
../../target/release/examples/perf_baseline --engine parakeet --out ../../docs/perf/branch-preview-off.json
../../target/release/examples/perf_baseline --engine parakeet --preview --out ../../docs/perf/branch-preview-on.json
# --preview also reports speech_start_to_first_caption_ms, caption_staleness_ms,
# caption_audio_lag_ms and canonical_permit_wait_ms.
```
