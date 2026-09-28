# Apple Speech (macOS)

Apple Speech is an optional on-device transcription engine alongside Whisper and Parakeet.
It requires macOS 26+ and compatible Apple Silicon hardware; availability and language
support are queried from the running OS rather than hard-coded. Existing engine choices
are not migrated or replaced. No account or API key is used and there is no cloud fallback.

## Setup

In Settings → Transcription, select **Apple Speech (on-device)**, choose the spoken
language, and use **Download language** if the system speech assets are missing.
Asset installation happens only on that explicit action. Recording start checks readiness
without downloading. English is the initial Apple selection; automatic language detection
is not exposed. Translation settings remain independent of the spoken-language selection.

Imported audio and meeting re-transcription continue to offer Whisper and Parakeet.
Language-practice short utterances can use the Apple provider, but that practice language
must be prepared before listening. An unavailable language fails explicitly before opening
the microphone; it never substitutes English.

## Live path

The existing microphone/system capture and mixed-audio recording writer remain in place.
When Apple is selected, source-separated PCM goes to persistent SpeechAnalyzer sessions
through queues bounded to ~10 s of audio per source. The Silero VAD processors and repeated
preview/final model passes are not used in this path. Whisper and Parakeet retain their
existing VAD and preview behavior.

- An energy gate (`SpeechGate`) feeds the recognizer only around sustained sound (300 ms
  pre-roll, 1.5 s hangover); silence and keystrokes alone are not recognized. Skipped
  audio is spliced out of the session timeline and result times are mapped back to
  recording time. See [live fixes](perf/apple-speech-live-fixes.md).
- With captions off, sessions request finals only; toggling captions restarts the
  session at the sample clock without losing or duplicating finals.

- `live-transcript-preview` carries provisional text for the existing caption and translation UI.
- Only finalized results emit `transcript-update` and enter the existing recording journal.
- Microphone/system labels are retained. Apple mode labels system audio as “Other party”;
  it does not claim to identify individual remote speakers or perform voice clustering.
- Capture discards paused audio; the ASR clock advances by accepted samples, not paused time.
- Stop closes the input queue, drains accepted audio, finalizes the analyzers, and waits
  for final results before the transcript persistence listener is removed.
- Queue overflow skips audio for transcription only (the Rust queue) or restarts that
  source's session at the sample clock (the Swift queue) and shows a non-blocking warning;
  live transcription continues. Recognition errors are surfaced, while the separate audio
  recording remains available for recovery. No silent model fallback or fabricated
  transcript is used.

## Native integration

`apple_speech_bridge.swift` is compiled into the native application, not an executable
sidecar. It exposes a small numeric-ID C ABI. Rust copies callback payloads immediately;
no Rust-owned context pointer is retained by Swift. Requests and session result queues
are bounded and timed. The bridge is compiled for the existing deployment floor with
runtime guards for newer Speech APIs; the app's minimum macOS version is not raised.

Build-time dependency: an installed Xcode SDK containing SpeechAnalyzer (macOS 26+).
No SDK, model, or executable is downloaded by the bridge build step. Non-macOS builds
return an unavailable capability response and retain the other transcription engines.

## Focused validation and release boundary

`frontend/src-tauri/tools/apple-speech/run-harness.sh` tests the native ABI without
opening the microphone or launching the app. The Rust `apple` test filter covers callback
contracts, lifecycle cleanup, timestamp validation, and pause/sample-clock behavior.
The explicitly ignored `apple_native_empty_session_uses_rust_callback_route` test
also checks the real Swift bridge from the Rust-linked executable; run it only on
a compatible Mac with English assets already installed. It does not download assets.

Implementation validation (2026-09-22, Apple M4, macOS 27):

- Native public-speech fixture produced provisional text before input finalization,
  final text on finish, and clean repeated/empty/cancelled sessions. Two simultaneous
  English sessions also produced partials, finals, and clean completion independently.
- 13 focused Rust tests passed, including the native callback smoke check, input
  overflow detection, and final journal writes while the recording manager is extracted.
- Node 24 focused settings TypeScript/lint checks passed. The transcript-context
  lint check retains its pre-existing effect-dependency warning.
- Independent review's shutdown-persistence and overload-notification findings
  were corrected and the corrective delta was accepted.

These checks did not launch the packaged app, exercise real microphone/system capture,
verify an older OS, or measure CPU/energy. No release artifact was produced.

Before distributing a release, test the packaged app on a supported Mac: select/prepare
the language, start with microphone and system audio, observe partial captions before a
sentence ends, pause/resume, stop, then reopen and verify audio plus final transcript.
Also verify launch on an older supported macOS version and unavailable/missing assets.
Measure whole-machine CPU/energy (including Apple speech services) and latency using
the same input before making performance claims. Synthetic checks are not those gates.
