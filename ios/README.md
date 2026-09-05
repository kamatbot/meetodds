# MeetOdds for iPhone and iPad

Native SwiftUI app, built from `main` at `f261e10e1f6ec58c5ce8fb1dbc3e06fb61250b55` on branch `feat/native-ios-meetodds`. This is a separate iOS client, not a Tauri webview and not a desktop rewrite. No desktop data contracts or services are replaced.

## The experience

Choose **On iPhone** or **ChatGPT**, select a template, and record. A quiet recording screen shows elapsed time, the real microphone level, the latest transcript and private notes. Pause/resume and Finish stay within thumb reach. A lock-screen/Dynamic Island Live Activity shows state and duration without exposing meeting content. After recording, review the transcript and produce a versioned summary. Notes are excluded from AI input and sharing unless explicitly selected.

The app reuses all five actual desktop JSON templates: Meeting Notes, Daily Standup, Mayur Product Review, Mayur Decision Review and Mayur PM One-to-One. They are bundled from `../frontend/src-tauri/templates`, not maintained as a divergent iOS copy.

### Model choices mean different summary routes

| Choice | Transcription | Summary |
| --- | --- | --- |
| On iPhone | Apple SpeechAnalyzer / SpeechTranscriber, on device | Apple Foundation Models, on device |
| ChatGPT | The same on-device speech path | Selected text to an explicitly paired Mac, then OpenAI through that Mac's official Codex app-server ChatGPT session |

**ChatGPT mode currently requires the companion Mac to be awake and reachable.** It is not standalone ChatGPT OAuth on iOS and does not convert a subscription into API credits. No private ChatGPT API, password scraping, copied OAuth token or API-key fallback is used. Subscription/model availability and workspace policies still apply.

Local summaries require an Apple Intelligence-capable device with its model enabled and ready. The UI explains unavailability; recording remains usable without a summary model. On-device speech availability/languages are discovered at runtime. Before an important first meeting, use **Settings → Prepare transcription for offline use** while online. Downloads contain speech assets, not your meeting audio.

## Build

Requirements: macOS with **Xcode 26**, iOS/iPadOS **26 or later**, Swift 6 toolchain, and XcodeGen. The app uses stable iOS 26 APIs, not iOS 27 beta APIs.

```sh
# Repository root
brew install xcodegen
cd ios
make project
open MeetOdds.xcodeproj
```

Choose your Apple development team for the app and extension, adjust the bundle identifiers as needed, select your iPhone and Run. The defaults are `com.meetodds.ios` and `com.meetodds.ios.liveactivity`; no team ID, certificate, provisioning profile or signing secret is committed. Project and Info.plist files are generated from `project.yml`.

```sh
# Compile app + Live Activity for Simulator without signing
make build
# Portable storage/evidence tests and Node companion boundary tests
make test
```

A production App Store/TestFlight submission still needs signing, app-icon/marketing assets, an actual privacy-policy URL and the appropriate store disclosures. This branch does not publish a release or charge an account.

## Pair ChatGPT once

The companion uses Node 22+, OpenSSL and the official Codex CLI on your Mac. Install/sign in under your own account. A dedicated Codex home keeps this integration separate from your coding-agent configuration.

```sh
# From repository root; replace the hostname with your Mac's actual LAN/VPN name.
node ios/companion/server.mjs init https://your-mac.local:9417
node ios/companion/server.mjs login
# Explicitly opt in to listening on your LAN. Default is loopback only.
node ios/companion/server.mjs serve 0.0.0.0
```

`init` prints pairing JSON. Paste it directly into **MeetOdds → Settings → ChatGPT subscription → Pair Mac**. It contains a secret: do not post it in issues, chat logs or screenshots. The iOS client verifies the pinned SHA-256 certificate and its hostname/validity before sending the pairing token. The token is stored in the iOS Keychain as device-only; Codex's login uses the Mac credential store. Certificates expire after a year; rotate by initializing a new private directory and pairing again.

Override the local configuration directory with `MEETODDS_COMPANION_HOME=/private/path` when needed. Never point it at your normal Codex home. The default `.private` folder is ignored by Git and protected with owner-only permissions. Initialization refuses to overwrite an existing pairing identity.

Use a trusted LAN or private VPN. Do not publish the port to the public Internet or place it behind an unreviewed HTTP relay. Forgetting the Mac in iOS removes the local pairing credential; to revoke a lost iPhone, rotate the companion pairing token/identity and re-pair trusted devices.

### Deliberately narrow companion

The HTTPS surface exposes only authenticated `GET /v1/status` and `POST /v1/summary`. It rejects browser origins, arbitrary paths, audio uploads, extra request fields, unknown templates, oversized inputs and overlapping jobs. The app explicitly reviews selected transcript/notes before each cloud send. The companion discovers real account models, rejects API-key accounts, and never silently substitutes a retired requested model.

Each summary has a separate ephemeral app-server thread and empty working directory. API-key/base-URL environment overrides are not inherited. Shell, unified execution, images, apps, hooks, web search and MCP integrations are disabled; turns request restricted read access with no readable roots. Unexpected tool/approval activity aborts the job. This relies on the installed official Codex version implementing its documented controls; unsupported ephemeral sessions fail before meeting text is sent. Use an up-to-date CLI and complete the account smoke test before relying on it for sensitive work.

The companion does not log meeting content. OpenAI account/workspace data policies still apply to the selected text. A Node fake-protocol test is not proof of successful authentication against your particular subscription; no live account login is performed by CI.

## Capture and performance design

The audio callback copies into a bounded 12-buffer writer queue. CAF writes happen on a dedicated serial queue; ASR is on a separate bounded stream. Transcription falling behind stops the preview path, not recording. Audio is segmented every 30 seconds; file synchronization and metadata checkpoints are requested periodically. A recorder is never called successful merely because a spinner finished.

The main screen reads small meeting headers instead of audio/full transcripts. The microphone meter is throttled to about 8 updates per second; Live Activity updates are throttled to 20 seconds and use a system-rendered timer between updates. Rendering uses native SwiftUI and lazy meeting/transcript lists, without a bundled browser or JavaScript runtime in the app.

Local summaries run serially after recording, not against the live audio engine. Long inputs are processed in conservative Unicode-safe chunks, reduced and summarized per template section. A failed reduction/context operation remains an error rather than silently dropping the rest of the meeting. Summaries can still omit or misinterpret evidence: review important claims against the transcript.

These are implementation choices, **not measured latency, battery, word-error-rate or crash-loss guarantees**. Cold asset downloads and Apple Intelligence availability are explicitly separate from warm performance.

## Platform and recovery boundaries

- The app captures its microphone only. It does not intercept another iOS app's Zoom/Teams/phone-call audio. Capture participants' permission before recording.
- The audio background mode supports an ongoing authorized recording while locked/backgrounded; a Live Activity itself is not a background execution entitlement. Force-quitting the app stops capture.
- Pauses exclude new audio. Previously captured speech may still finalize. An interruption pauses; a route change ends and retains the current session instead of silently switching microphones.
- On relaunch, unfinished sessions are marked interrupted. Retained CAF segments can rebuild the transcript. The last unflushed or malformed audio segment may be unrecoverable; no zero-loss claim is made.
- Only finalized speech enters summaries. Incomplete/interrupted transcripts must be rebuilt before generation. Original recordings and previous summary versions are preserved on cancellation/failure.
- Files use iOS data protection allowing an already-started recording to continue after lock, and are excluded from device backup. This is not an additional application-level encrypted vault or cross-device sync.
- Deleting a meeting removes all its local recordings, transcript, notes and summaries. Removing the app removes its local library. No automatic retention/deletion timer is enabled.
- Live Activities contain only a meeting UUID, phase and duration. They become stale without refresh and tell the user to open the app to verify; tapping opens controls rather than performing hidden mutations.

## Verification

`MeetOddsCore` has 11 executable Swift tests for revision-safe persistence, interrupted recovery, finalized transcript handling, explicit note inclusion, Unicode-safe chunking, pairing validation and desktop-template compatibility.

The companion has 12 executable Node tests for authentication boundaries, model discovery, input limits, rejection of API accounts, denied approvals, early stream-completion races, ephemeral-session checks and the actual HTTP route boundary. The latter uses a loopback HTTP harness; production transport is HTTPS with native certificate pinning.

The iOS workflow compiles the actual app and Live Activity extension, then runs three native XCUITests for model/template selection, meeting notes/transcript navigation and explicit ChatGPT send approval. Tests seed a new isolated local directory in Debug only; they never record audio, sign into a real account or touch user meetings. Result bundles retain screenshots for review.

Before distribution, test on the target iPhone: actual mic and Bluetooth routes, first model download, airplane-mode transcription and summaries, lock-screen/background recording, calls/interruptions, forced termination/recovery, low storage, long meetings, local-model cancellation, a real ChatGPT subscription, expired/mismatched pins, Dynamic Type, VoiceOver, reduced motion and light/dark appearance. Simulator compilation and scripted navigation do not certify these hardware behaviors.

## Primary API references

- Apple SpeechAnalyzer: https://developer.apple.com/documentation/speech/speechanalyzer
- Apple Foundation Models: https://developer.apple.com/documentation/foundationmodels
- Apple ActivityKit: https://developer.apple.com/documentation/activitykit
- OpenAI app-server: https://developers.openai.com/codex/app-server
- OpenAI authentication: https://developers.openai.com/codex/auth
- OpenAI configuration: https://developers.openai.com/codex/config-reference
