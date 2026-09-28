# Mac app build handoff — 2026-09-22

Build from a fresh checkout of GitHub `main`, not a feature branch. The next
prepared app version is **0.4.25**. No 0.4.24 app was successfully packaged.
Increment all four version entries before any subsequent app build attempt:
`frontend/package.json`, `frontend/src-tauri/tauri.conf.json`,
`frontend/src-tauri/Cargo.toml`, and the `meetodds` entry in `Cargo.lock`.

## Included on main

- Optional on-device Apple Speech alongside Whisper and Parakeet.
- Native captions-off gating: no new speculative Whisper/Parakeet snapshots or
  decodes, while canonical transcripts, audio saving and final translations continue.
- Pause/stop generation invalidation, reduced PCM copying, unused diagnostic
  collection removed, and fewer idle/hidden-window updates.
- Swift runtime linking through `/usr/lib/swift`, without depending on Xcode at runtime.
- Portable Apple Silicon release defaults, Node 24 enforcement and correct sidecar lookup.
- Release build dependencies are not stripped, avoiding the macOS 27 proc-macro
  loader problem tracked in [rust-lang/rust#157750](https://github.com/rust-lang/rust/issues/157750).
  Shipped binaries remain optimized and stripped.

## Build only the app

Use Apple Silicon, an installed Xcode SDK with SpeechAnalyzer (macOS 26+ SDK),
Rust/Cargo, the project's native build prerequisites, Node **24.x**, and pnpm.
Use a fresh local dependency install; do not copy the old Mac's `target/`,
`node_modules/`, `artifacts/` or partial app bundles. Its SSD disconnected during
compilation. No database, recordings, model downloads, credentials or signing keys
are included in Git.

From the root of the new checkout, after checking `git status` is clean:

```sh
git switch main
git pull --ff-only origin main
git rev-parse HEAD
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --version # must report v24.x
unset RUSTFLAGS LOCAL_CPU_NATIVE TAURI_CONFIG
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend run tauri:build:m5:app
```

The established packer bundles FFmpeg; summaries use Apple Intelligence through the compiled-in Swift bridge.
Do not use source-check `TAURI_CONFIG` overrides that remove bundled resources.
With the default Cargo target directory, the app is
`target/release/bundle/macos/MeetOdds.app`. This command does not build a DMG or updater.
Signing depends on credentials installed on the new Mac; verify signature and
Gatekeeper/notarization status before distributing to another machine.

## Evidence and remaining acceptance

On source `525ff7880d3c2ce7fa977028606f3bceb552fbbc`: 166 frontend tests,
4 SQLite migration tests, 462 Rust library tests and 2 helper tests passed;
4 native/integration tests were ignored. Production Next.js export also passed.
The app package then failed loading a stripped compiler plugin. The build-only
stripping workaround was independently reviewed, but its focused verification was
interrupted by the SSD I/O failure. It still needs verification on the new Mac.

Do not describe this as a successfully tested app release. Verify the resulting
bundle's version, dependencies, signature and launch, then exercise recording,
captions off/on, pause/resume, stop/save, reopening and audio playback. Check with
existing meeting state as well as a fresh profile; preserve the user's data.
Whole-app CPU savings and older-Mac compatibility have not yet been measured.
Use public synthetic speech, not private meeting content, for diagnostics.
Desktop/computer control remains forbidden until the user explicitly reauthorizes it.
