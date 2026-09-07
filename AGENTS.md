# MeetingRecorder / Meetily entry guide

## Read by affected surface

- Start with [CLAUDE.md](CLAUDE.md) for audio routing, Tauri commands/events and development patterns; [architecture](docs/architecture.md) describes the supported desktop architecture.
- The supported implementation is [frontend](frontend/package.json) plus the [Rust core](frontend/src-tauri/Cargo.toml). `backend/` is an unsupported historical archive, not a service to revive.
- Capture and persistence: trace [pipeline](frontend/src-tauri/src/audio/pipeline.rs), [recording manager](frontend/src-tauri/src/audio/recording_manager.rs) and [recording saver](frontend/src-tauri/src/audio/recording_saver.rs) before changing their shared boundaries.
- Preserve the separate mixed recording and VAD-filtered transcription paths. Read [live transcript guidance](docs/STREAMING_LIVE_TRANSCRIPTS.md) for streaming changes.
- Preserve [privacy commitments](PRIVACY_POLICY.md); consult [cloud integration](docs/OPENAI_CLOUD.md) before changes that send meeting content to a provider. Do not expose real recordings or transcripts in diagnostics.
- [Building](docs/BUILDING.md) supplies platform context; current manifests/scripts and the global Node 24 policy take precedence over historical setup commands such as unversioned Homebrew Node.

## Select the smallest check

- Run commands from the repository root unless a working directory is specified. Inspect the affected tests before choosing a test filter.
- Rust core compile check follows [native check CI](.github/workflows/meetodds-native-check.yml):
  `TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":[]}}' cargo check --manifest-path frontend/src-tauri/Cargo.toml --lib --locked`.
- For helper-only changes, use `cargo check -p llama-helper --locked`, targeting the [helper package](llama-helper/Cargo.toml), not the whole workspace.
- For a frontend file, run `pnpm run lint --file src/path/to/changed.tsx` from `frontend/`, substituting the actual changed file. The [package scripts](frontend/package.json) define lint; there is no package test script to assume.
- Compile checks can still compile native dependencies or prepare FFmpeg via [build.rs](frontend/src-tauri/build.rs); they do not establish packaged-sidecar or runtime success.

## Runtime and release evidence

- Capture changes require an actual desktop recording with representative microphone/system input: start, observe live transcription, stop, save, reopen the meeting, and verify playable audio and persisted transcript. Record platform, permissions, input devices and observed result without private content.
- Exercise the affected failure or interruption path as well; compile-only evidence must be labeled incomplete when a device/session is unavailable.
- Distribution is a separate gate. [M5 packaging](frontend/scripts/build-macos-m5.sh) builds and installs the release `llama-helper` sidecar before Tauri packaging; [GPU build](frontend/build-gpu.sh) documents another platform-specific path.
- Select the appropriate existing platform packer and real sidecars for an authorized release. Never carry the compile-only `TAURI_CONFIG` override into a distributable build or substitute placeholder binaries.
- Do not use clean builds, GPU builds, model downloads or app packaging as routine iteration checks. Validate the resulting installed app's recording/save/reopen flow before claiming a release works.
