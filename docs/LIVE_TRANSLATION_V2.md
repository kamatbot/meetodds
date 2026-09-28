# MeetOdds Live Translation V2

## Why V1 felt slow

V1 fixed full-response blocking by streaming tokens, but it still inherited the meeting-summary provider and model. A large reasoning/coding model can have a slow time-to-first-token even when its eventual translation is good. Live interpretation cares more about **time to first translated words** than total completion time.

Transync AI's public materials describe a different product shape: dedicated real-time translation models, continuously updating captions, an average claimed delay below 0.5 seconds, and optional keywords/context for terminology. Its proprietary implementation is not public, so MeetOdds V2 adopts those observable design principles rather than claiming to reproduce private internals.

## V2 architecture

```text
local/system audio
      |
      v
MeetOdds ASR (canonical transcript)
      | immediately
      +--------------> original caption
      |
      v
newest-turn scheduler (3-turn live window)
      |
      +-- small conversational context (0/2/4 prior turns)
      +-- user glossary + meeting hint
      v
adaptive translation router
      |
      +-- Groq / llama-3.1-8b-instant
      +-- OpenAI / gpt-4o-mini
      +-- Claude / claude-haiku-4-5-20251001
      +-- configured summary provider as compatibility fallback
      +-- Apple Translation on this Mac (final fallback / explicit engine)
      |
      v
streamed SSE deltas ----------> translated caption
```

## Latency modes

| Mode | First-word budget | Provider attempt | Total fallback chain |
| --- | ---: | ---: | ---: |
| Instant | 2.8 s (12s Ollama) | 10 s (25s Ollama) | 15 s (30s Ollama) |
| Balanced | 4.5 s (12s Ollama) | 16 s (25s Ollama) | 24 s (30s Ollama) |
| Accurate | 10 s (12s Ollama) | 30 s (25s Ollama) | 35 s (30s Ollama) |

Apple Translation is not an LLM stream: each caption has a 10 s request limit.

A provider that repeatedly misses the first-word budget is temporarily cooled down. The next configured fast provider is attempted automatically.

## Translation-specific routing

Summary quality and live-caption latency are different optimization problems. Auto mode therefore does **not** blindly use the summary model:

- Groq: `llama-3.1-8b-instant`
- OpenAI API: `gpt-4o-mini`
- Anthropic: `claude-haiku-4-5-20251001`
- Current summary provider: compatibility fallback, including ChatGPT/Codex, Ollama, OpenRouter, and custom OpenAI endpoints.
- Apple Translation (on this Mac): last resort, and used directly when nothing else is configured.

Users can explicitly select Apple Translation/Groq/OpenAI/Claude/current-summary-provider and optionally override the model of LLM engines.

## On-device translation

The built-in llama.cpp model is no longer used for translation. The on-device engine is Apple's Translation framework through `apple_translation_bridge.swift` (compiled with the Apple Speech bridge; same numeric-id C ABI) and `apple_translation.rs`. See [LIVE_TRANSLATION.md](LIVE_TRANSLATION.md#apple-translation) for source-language selection and installing languages. Measured on an M-series Mac under heavy load (macOS 27, es→en, 5 short sentences): the first request in a process took 1.1–1.8 s (model load), later requests 0.4–1.0 s whether the session was new or reused (single outliers up to 3.8 s under load); the model load is what prepare's warm-up removes. `cargo run --example apple_translation_check` repeats the measurement on installed pairs only.

## Context and terminology

The translator can receive up to four prior finalized turns as **reference only**. It is explicitly instructed to output only the current utterance. Speaker labels are included in the reference window. Users may also provide keywords/product names and a short meeting-context hint.

## Important remaining latency boundary

MeetOdds' canonical ASR still emits text after its speech segmentation/VAD boundary. Translation V2 can make the **text-to-translation** step much faster and can fail over quickly, but it cannot translate words that ASR has not emitted yet. Products that sustain sub-500ms translation during long uninterrupted speech typically use a streaming ASR or direct streaming audio-translation lane.

OpenAI now exposes `gpt-realtime-translate`, a dedicated streaming speech-to-speech model that returns translation transcript deltas while source audio is still arriving. A future optional cloud-realtime lane can bypass the VAD-finalization wait when an OpenAI API key is configured, while keeping the current local transcript as the canonical meeting record.

## Recommended setup

- Speed: **Instant**
- Engine: **Auto - fastest configured**
- Configure Groq or OpenAI API for the best caption latency
- Context: **2 prior turns**
- Add domain names/terms to Keywords when needed
- Display: Original + translation while evaluating quality

The ChatGPT subscription/Codex provider remains a useful no-extra-key compatibility fallback, but it is not treated as the preferred sub-second caption engine.
