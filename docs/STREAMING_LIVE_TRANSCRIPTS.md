# Streaming live transcripts

MeetOdds now has two deliberately separate speech-to-text paths during recording.

## 1. Canonical transcript

The existing VAD boundary, speaker attribution, sentence structure, persistence, copy/export,
summaries, and recording history are unchanged. A canonical sentence is decoded only after
VAD closes the utterance. This remains the source of truth.

## 2. Speculative subtitle preview

While VAD is still inside an utterance, the audio pipeline takes a non-destructive rolling
snapshot of the active speech buffer roughly every 450 ms after at least 700 ms of speech.
Only the newest snapshot is retained. A separate preview task decodes a capped ~2.8 second
rolling window and emits `live-transcript-preview` events.

The frontend renders those events in a subtitle-style overlay even when translation is off.
Nothing in this lane is written to IndexedDB, SQLite, `transcripts.json`, summaries, exports,
or the recording saver. When the canonical sentence finishes, the preview is cleared and the
normal transcript row appears.

### Priority and resource protection

- The canonical worker marks final ASR as busy; speculative decoding does not start while it is busy.
- Preview snapshots use a `watch` channel, so stale audio is dropped rather than queued.
- Whisper preview uses greedy search, one segment, a short output cap, and at most two decoder threads.
- Long-running preview results more than two snapshot revisions behind are discarded.
- The preview task is aborted before stop-recording waits for final transcript work.

### Translation

Live Translation V2 receives the same preview text when enabled. It intentionally does not cancel
an in-flight translation on every ASR revision; it finishes the current short request and then jumps
directly to the newest preview. This prevents the 450 ms subtitle cadence from starving a translation
provider whose first token takes longer than one preview interval.

## Expected experience

The overlay is meant to feel like live TV captions: words may revise as more speech arrives. The saved
transcript remains cleaner and sentence-oriented. This separation is intentional—the preview optimizes
perceived latency, while the canonical transcript optimizes correctness and durable meeting notes.
