# OpenAI in MeetOdds

MeetOdds offers two distinct OpenAI providers for meeting summaries. Recording and transcription remain local unless you explicitly choose a cloud summary provider.

## 1. OpenAI Codex — ChatGPT subscription

Choose **OpenAI Codex (ChatGPT subscription)** to use the Codex allowance available to your ChatGPT Plus/Pro account. MeetOdds follows the same architecture used by Hermes Agent: OpenAI's Codex device-code OAuth flow, followed by the ChatGPT Codex Responses backend. No OpenAI API key is needed for this mode.

The sign-in flow opens `https://auth.openai.com/codex/device`, stores MeetOdds' own rotating access/refresh token pair in the application's data directory, and sends summary requests to the Codex backend. Tokens are never written to the meeting database or rendered in the UI. On Unix, the token file is created with owner-only permissions.

MeetOdds deliberately does **not** import `~/.codex/auth.json`. Refresh tokens rotate, so sharing the same refresh credential between MeetOdds and Codex CLI/VS Code could invalidate one of the sessions. MeetOdds owns and refreshes only the session it created.

Available Codex models are loaded from your signed-in account. The fallback catalog includes `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.4`, `gpt-5.3-codex`, and `gpt-5.3-codex-spark`; the live account response is authoritative. `-pro` model variants are excluded because consumer ChatGPT Codex accounts may reject them.

Subscription usage and limits are enforced by OpenAI. A 429 response is presented as a Codex usage-limit condition rather than as an API-key authentication failure.

## 2. OpenAI Cloud API — API billing

Choose **OpenAI Cloud API** when you want to use an OpenAI Platform API key. This mode calls `api.openai.com` and is billed separately from ChatGPT subscriptions. MeetOdds dynamically loads the API models available to your key and currently prefers the GPT-5.6 family.

## Privacy boundary

Audio capture and transcription can remain entirely on-device. When either OpenAI cloud provider is selected, the transcript text needed to generate or translate a meeting summary is sent to the selected OpenAI service. Local Built-in AI and Ollama remain available when no cloud processing is desired.

## Compatibility

The visible application name is **MeetOdds**, while the existing `com.meetily.ai` Tauri identifier and internal Rust package name remain unchanged so upgrades continue using the existing settings, database, recordings, and model files.
