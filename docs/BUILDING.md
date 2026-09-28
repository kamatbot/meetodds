# Building Meetily from Source

MeetOdds transcribes with Apple Speech (SpeechAnalyzer), so the supported platform is
**macOS 26 or later on Apple Silicon**. Building needs an Xcode SDK that contains
SpeechAnalyzer (macOS 26 SDK or newer). There are no GPU build variants or speech
models to download at build time; speech language assets are installed by macOS when
the user chooses **Download language** in Settings → Transcription.

Linux and Windows builds still compile capture and storage, but transcription reports
Apple Speech as unavailable there.

## 🍎 Building on macOS

### 1. Install Dependencies

```bash
# Install Homebrew (if not already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install required tools (Node 24 is enforced by the build)
brew install cmake node pnpm
```

Install Xcode (26 or later) and select it with `xcode-select`.

### 2. Build and Run

From `frontend/`:

```bash
# Development mode (with hot reload)
pnpm tauri:dev

# Production build
pnpm tauri:build
```

Release packaging uses `pnpm tauri:build:m5`
(see [M5 packaging](../frontend/scripts/build-macos-m5.sh)).

## Other platforms

Windows (`pnpm tauri:dev` with Visual Studio Build Tools and the C++ workload) and Linux
builds are not supported release targets: they cannot transcribe.
