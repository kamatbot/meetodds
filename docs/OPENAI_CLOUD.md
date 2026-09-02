# OpenAI Cloud in MeetOdds

MeetOdds supports OpenAI as an optional cloud summarization provider. Recording and transcription can remain local; when OpenAI is selected, the transcript content needed for the summary request is sent to the OpenAI API.

## Authentication

MeetOdds uses the supported OpenAI API authentication mechanism: an OpenAI API key sent as a Bearer token from the native Tauri backend. The key is stored through MeetOdds' existing provider-key settings path and is not exposed in the rendered transcript UI.

## Why there is no “Use my ChatGPT subscription” OAuth button

As of September 2, 2026, OpenAI documents ChatGPT and API billing as separate systems. “Sign in with ChatGPT” is an identity-provider login for participating applications; it does not independently grant an external application access to ChatGPT subscription usage or API entitlement. Codex is a product-specific exception that OpenAI explicitly supports with ChatGPT-plan sign-in.

MeetOdds therefore does not imitate Codex OAuth or capture ChatGPT session tokens. Doing so would be unsupported, brittle, and misleading.

## Setup

1. Open **Settings → Model Settings**.
2. Select **OpenAI Cloud API**.
3. Use the link in MeetOdds to create/manage an OpenAI API key.
4. Paste the key, choose a model, and save.

The preferred summary model is `gpt-5.6-terra` for a strong quality/cost balance. `gpt-5.6` and `gpt-5.6-luna` are also offered as fallbacks; the app dynamically loads the models available to the supplied API key.

## Compatibility note

The visible product name is MeetOdds, but the existing `com.meetily.ai` Tauri identifier and internal Rust package name are intentionally retained so upgrades continue to use the same application data, settings, database, and recordings.
