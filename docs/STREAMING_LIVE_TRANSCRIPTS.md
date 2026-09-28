# Streaming live transcripts

During recording, Apple Speech runs one continuous SpeechAnalyzer session per audio source
(microphone, system audio). Each session produces two kinds of results.

## 1. Final transcript

Finalized results emit `transcript-update`. They carry speaker labels, audio-relative
timestamps and a sequence id, and are the only results written to the recording journal,
`transcripts.json`, SQLite, summaries and exports. This remains the source of truth.

## 2. Provisional captions

Volatile (partial) results emit `live-transcript-preview` for the subtitle-style overlay and
live translation. Nothing in this lane is persisted. When a final result arrives for a source,
the caption for that source is cleared and the transcript row appears.

The native captions preference gates provisional events only; final transcripts and the
recording continue either way. See [the performance correction](perf/captions-off-2026-09.md)
for history and [Apple Speech](APPLE_SPEECH.md) for the session lifecycle.

### Translation

Live Translation V2 receives the same caption text when enabled. It intentionally does not cancel
an in-flight translation on every caption revision; it finishes the current short request and then
jumps directly to the newest caption.

## Expected experience

The overlay is meant to feel like live TV captions: words may revise as more speech arrives. The saved
transcript remains cleaner and sentence-oriented.
