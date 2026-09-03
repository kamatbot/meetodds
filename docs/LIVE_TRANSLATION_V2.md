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
      |
      v
streamed SSE deltas ----------> translated caption
```

## Latency modes

| Mode | First-word budget | Provider attempt | Total fallback chain |
| --- | ---: | ---: | ---: |
| Instant | 1.8 s | 8 s | 12 s |
| Balanced | 3.2 s | 15 s | 22 s |
| Accurate | 10 s | 30 s | 32 s |

A provider that repeatedly misses the first-word budget is temporarily cooled down. The next configured fast provider is attempted automatically.

## Translation-specific routing

Summary quality and live-caption latency are different optimization problems. Auto mode therefore does **not** blindly use the summary model:

- Groq: `llama-3.1-8b-instant`
- OpenAI API: `gpt-4o-mini`
- Anthropic: `claude-haiku-4-5-20251001`
- Current summary provider: final fallback for compatibility, including ChatGPT/Codex, Ollama, Built-in AI, OpenRouter, and custom OpenAI endpoints.

Users can explicitly select Groq/OpenAI/Claude/current-summary-provider and optionally override the model.

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
