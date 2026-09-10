# MeetOdds

**Private, local-first AI meeting notes — with optional ChatGPT intelligence.**

MeetOdds records meetings, transcribes them on your computer, turns conversations into structured notes, and helps you leave with clear decisions and action items.

Your default workflow can stay fully local. When you want stronger AI reasoning, you can optionally connect your ChatGPT account for summaries without configuring a separate OpenAI API key.

[Website](https://meetodds.kamatbot.com) · [Latest release](https://github.com/kamatbot/meetodds/releases/latest) · [Issues](https://github.com/kamatbot/meetodds/issues) · [Source](https://github.com/kamatbot/meetodds)

---

## Why MeetOdds

Most meeting assistants send audio or transcripts to a cloud service. MeetOdds is designed so that you do not have to.

### Fully local when you want it

- Record microphone and system audio on your computer.
- Transcribe locally with Whisper or Parakeet.
- Generate summaries locally with the built-in `llama.cpp`-based helper or Ollama.
- Keep recordings, transcripts, notes, and meeting history on your device.
- Work without a cloud AI account after the required local models have been downloaded.

### Optional ChatGPT intelligence

MeetOdds can also use the **OpenAI Codex (ChatGPT subscription)** provider built into the app.

- Sign in with an eligible ChatGPT account.
- No separate OpenAI API key is required for this mode.
- Recording and transcription remain local.
- Only the transcript text required for the requested summary or translation is sent to OpenAI.
- OpenAI account availability, usage limits, and service terms apply.

This is intentionally separate from the fully local workflow. If a meeting must never leave your computer, use Built-in Local AI or Ollama instead.

MeetOdds also supports the OpenAI API and other configurable AI providers for users who prefer them.

See [OpenAI in MeetOdds](docs/OPENAI_CLOUD.md) for the exact provider and privacy boundaries.

---

## Core features

### Local meeting capture

MeetOdds captures both microphone and system audio directly from the desktop app. It does not need to join your call as a meeting bot.

### Live local transcription

- Whisper and Parakeet transcription engines
- Apple Silicon acceleration on macOS
- Voice activity detection
- Separate recording and transcription paths so the saved recording is not dependent on transcript processing

### Docked meeting notes

Keep MeetOdds beside Zoom, Google Meet, Microsoft Teams, Slack, an IDE, or an in-person conversation without constantly switching windows.

Each meeting gets its own notes document, with local persistence and timestamped note breaks.

### AI summaries and action items

Turn a transcript into useful meeting output such as:

- concise summaries
- key topics
- decisions
- follow-ups
- action items
- structured notes

Choose between fully local AI and optional cloud intelligence depending on the sensitivity of the meeting.

### Professional exports

Export meeting content as:

- PDF
- Microsoft Word (`.docx`)
- Markdown
- JSON

### Open source and inspectable

MeetOdds is open source. You can inspect how recording, transcription, storage, and AI-provider routing work, modify the application, or build it yourself.

---

## Download

### macOS — Apple Silicon

Download the latest signed release from:

**[MeetOdds Releases →](https://github.com/kamatbot/meetodds/releases/latest)**

Current public release: **MeetOdds 0.4.19**.

1. Download the `.dmg`.
2. Open it.
3. Drag **MeetOdds** to Applications.
4. Launch MeetOdds and grant the microphone/system-audio permissions required for recording.

Windows and Linux build paths are also present in the source repository. Check the release page for currently published binaries.

---

## Build from source

MeetOdds is a Tauri desktop application with a Rust core and a Next.js/TypeScript UI.

### Requirements

- Rust toolchain
- Node.js 24
- `pnpm`
- platform-specific native dependencies described in [docs/BUILDING.md](docs/BUILDING.md)

### Clone

```bash
git clone https://github.com/kamatbot/meetodds.git
cd meetodds
```

### Frontend / desktop development

```bash
cd frontend
pnpm install
pnpm run tauri:dev
```

For platform-specific build and packaging instructions, see [docs/BUILDING.md](docs/BUILDING.md).

---

## Privacy model

MeetOdds distinguishes between **local processing** and **optional external AI processing**.

| Capability | Fully local mode | ChatGPT account mode |
| --- | --- | --- |
| Audio recording | On device | On device |
| Transcription | On device | On device |
| Meeting storage | On device | On device |
| Summary generation | On device | OpenAI |
| Transcript sent to cloud | No | Only when requesting cloud AI processing |
| Separate OpenAI API key | No | No for ChatGPT subscription mode |

If you configure another external provider, data sent to that provider is subject to its own terms and privacy practices.

Always inform participants and obtain any consent required by the laws and policies that apply to your meeting.

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for more detail.

---

## Architecture

The supported application consists of:

- **Tauri 2 / Rust** for desktop integration, audio capture, persistence, transcription orchestration, and native functionality
- **Next.js / React / TypeScript** for the user interface
- **Whisper / Parakeet** for local transcription
- **llama.cpp / Ollama** for local AI summaries
- optional external AI providers, including ChatGPT-account access through the OpenAI Codex integration

The historical Python/FastAPI backend in this repository is retained only as an archive and is not part of the supported runtime.

See [docs/architecture.md](docs/architecture.md) for the detailed architecture.

---

## Contributing

Issues and pull requests are welcome.

Before making changes, read:

- [AGENTS.md](AGENTS.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [docs/BUILDING.md](docs/BUILDING.md)

Please preserve the project's privacy boundary: meeting content must not be sent to an external service unless the user explicitly chooses that provider or workflow.

---

## Original project and license

MeetOdds is derived from the open-source **[Meetily](https://github.com/Zackriya-Solutions/meetily)** project created by **Zackriya Solutions**. Meetily provided the original foundation for the desktop meeting assistant and is an important upstream reference for this project.

The original Meetily source is distributed under the **MIT License**. MeetOdds preserves the original copyright notice and license terms and includes additional MeetOdds contributor copyright notices.

See [LICENSE.md](LICENSE.md) for the complete license text.

MeetOdds is an independent derivative project and is not presented as the official Meetily distribution.
