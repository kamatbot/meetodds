# Live translation in MeetOdds

MeetOdds can translate live transcript turns into another language while a meeting is being recorded. The original transcript remains the source of truth; translation runs on a separate, bounded pipeline and never blocks audio capture, VAD, speaker detection, or transcription rendering.

## Using live translation

1. Start or open the active transcript screen.
2. Select **Translate** in the transcript toolbar.
3. Enable **Live translation**.
4. Choose a target language and one of the display modes:
   - **Original + translation** keeps both versions visible.
   - **Translation only** replaces the original after a translated result is ready. The original remains visible while translation is pending.

The selected target and display mode are stored locally for the next session. Live translated text itself is an in-memory presentation layer; the canonical transcript stored by MeetOdds is not overwritten.

## Provider behavior

Live translation reuses the summarization provider selected under **Model Settings**. This includes:

- OpenAI Codex through the connected ChatGPT subscription;
- OpenAI Cloud API;
- Claude, Groq, and OpenRouter;
- Ollama and MeetOdds Built-in AI;
- custom OpenAI-compatible servers.

When a cloud provider is selected, only the transcript text needed for the current translation request is sent to that provider. Audio remains in the existing recording/transcription pipeline.

## Low-latency architecture

The transcript UI renders the original turn first. Translation begins afterward through a cancellation-aware queue:

- Final transcript turns enter the queue immediately.
- Partial turns wait for a short debounce window so rapidly changing fragments do not create a request storm.
- A newer revision cancels the older in-flight request for that turn.
- Final turns are prioritized ahead of queued partial turns.
- The frontend queue is bounded and drops stale partial work before dropping final work.
- Repeated text/target combinations use an in-memory result cache.
- The native layer also has a bounded worker pool and a 30-second hard timeout.
- Translation latency and the active provider/model are visible in the translation control.

Cloud translation is allowed limited parallelism for lower wall-clock latency. Local providers are kept single-flight so local generation does not compete aggressively with Whisper or Parakeet for the CPU/GPU budget reserved for meeting transcription.

## Supported target languages

MeetOdds currently offers English, Spanish, French, German, Italian, Portuguese, Dutch, Swedish, Norwegian, Danish, Finnish, Polish, Czech, Romanian, Hungarian, Turkish, Russian, Ukrainian, Arabic, Hebrew, Hindi, Bengali, Urdu, Thai, Vietnamese, Indonesian, Malay, Simplified Chinese, Traditional Chinese, Japanese, and Korean.

Source language is detected automatically by the selected model. Names, product terms, numbers, dates, URLs, and speaker intent are explicitly preserved in the translation instruction.

## Boundaries

Translation quality and end-to-end latency ultimately depend on the selected model, local hardware, network conditions, and provider limits. The queue architecture prevents translation from delaying the transcript, but it cannot make a slow model respond instantly.

Live translation is segment-based rather than audio-to-audio simultaneous interpretation. Very short or incomplete fragments may be revised when the final transcript turn arrives. Overlapping speakers remain subject to the accuracy of the upstream transcription and speaker-attribution pipeline.
