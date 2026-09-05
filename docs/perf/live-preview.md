# Live caption preview lane — CPU cost

Apple M4, 10 cores, macOS 26.6.2, Parakeet `parakeet-tdt-0.6b-v3-int8`, release,
same harness and synthetic meeting as `branch-perf.md` (75 s, 14 canonical
segments, 24.0 s of speech).

| | Preview off | Preview on |
|---|---|---|
| Live CPU (75 s meeting, real-time paced) | 6.82 % of one core | **11.75 %** of one core |
| Peak threads | 28 | 29 |
| Speech end → transcript, median | 293 ms | 287 ms |
| Speech decoded | 24.0 s (14 segments) | 24.0 s (14 segments) |
| Preview decodes | — | 16 |
| Preview decode ms, median / p95 | — | 61.9 / 115.8 |
| Preview window, median | — | 0.7 s |

This is a synthetic Parakeet baseline, not a live microphone result and not a
Whisper measurement. It measured the earlier scheduler; the current scheduler
serializes all local preview and canonical inference, so a canonical decode may
wait for one preview already in progress but the two never contend for the
model at the same time.

## How it stays cheap

- Snapshots offered to the preview decoder at most every 800 ms
  (`LIVE_PREVIEW_INTERVAL`).
- Each snapshot is capped to the last 6 s of the open utterance
  (`LIVE_PREVIEW_MAX_WINDOW_MS`), so a long monologue doesn't grow the decode.
- Preview and canonical decodes share a single fair local-inference permit.
  Canonical work queues ahead of new preview work, and a preview releases the
  permit immediately after its decode. This prevents the two local models from
  competing for CPU or GPU.
- The channel between VAD and preview decoder is a `tokio::sync::watch`: only
  the newest snapshot is ever pending, so a slow preview decode can't build a
  backlog.
- After every preview decode — including empty, stale, or failed results — the
  lane rests for 2x its own decode time. The watch channel drops snapshots that
  arrive during that rest, so it resumes with only the latest audio.
- Nothing in this lane writes to transcripts, notes, or persistence — it only
  emits a display-only `live-transcript-preview` event.

## Re-run

```
cd frontend/src-tauri && cargo build --release --example perf_baseline
../../target/release/examples/perf_baseline --engine parakeet --out ../../docs/perf/branch-preview-off.json
../../target/release/examples/perf_baseline --engine parakeet --preview --out ../../docs/perf/branch-preview-on.json
```
