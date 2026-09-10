# Live meeting and floating caption studio

Baseline: `main` at `6cafb5788962ae58bb7ee11d8fb2eda851b0312e`.
Branch: `feat/live-meeting-caption-studio`.
No CI, deployment, release packaging, or workflow changes were performed.

## Experience

During a live meeting, Home becomes a full-width, paper-and-sage conversation workspace rather than squeezing a transcript beside the home dashboard. The existing linked manual-note document and native notes window remain unchanged. Use the Notes button or the existing + beside a transcript turn. Comfortable/compact reading density, copy-original, spoken language, and live translation controls stay available. Pause and Finish still call the existing recorder operations; this is not a replacement recording pipeline.

The Captions button opens a separate, frameless, transparent Tauri webview configured always-on-top and visible on all workspaces. Drag the top handle to place it on the desktop; drag any edge/corner to resize. The −/+ controls adjust text between 18 and 40 px. Appearance controls background opacity. X or Escape hides captions without stopping recording. The main workspace has Reset position. Window position/size and appearance are remembered, without storing caption text. A hidden window is re-clamped to the available monitor geometry when reopened. Positions use physical coordinates while sizes use logical pixels, including mixed-DPI and negative-coordinate monitor layouts.

The floating caption is independent of the transcript drawer and remains owned by the main app across navigation. Opening it does not focus the window or launch another recorder or translator. Text is scrollable; it follows the newest words unless the user scrolls or selects text. There is no typewriter delay or first-two-lines clamp. The recording view is not resized when the caption changes size.

## Translation contract

- Translation off: captions display original recognized speech.
- Translation on: captions display only the selected target language, English by default. The document's bilingual preference does not apply to floating captions.
- Pending/no speech/paused/error are distinct states. A missing or failed translation does not cause an original-language fallback.
- Slow in-flight preview translations may finish while newer overlapping speech revisions coalesce into one pending job. This prevents continuous ASR updates from suppressing every translated result.
- Results from a different source, non-overlapping utterance, previous target language, or previous recording are rejected. The cache is cleared across recording identities; invalidated jobs cannot repopulate it.
- Finalized-turn translations can be displayed briefly when speculative speech has cleared. Saved original transcripts, summaries and exports are not replaced by translated captions.

The `useLiveTranslation` provider-selection logic, native translation endpoints, concurrency limits, and historical backfill contract remain in place. A third optional session identity argument isolates the globally owned live session. `LiveMeetingTranslationProvider` is the single live translator for the main window, shared by the workspace and caption bridge. It listens to the existing settings-update event and rechecks preferences on navigation.

## Implementation map

| Area | Files |
| --- | --- |
| Caption content/geometry/IPC ordering | `frontend/src/lib/live-captions.ts` |
| Lazy native window and restoration | `frontend/src/services/captionWindowService.ts` |
| Display-only route | `frontend/src/app/live-captions/page.tsx`, `frontend/src/components/Captions/CaptionWindow.tsx`, `captions.css` |
| Main-window display bridge | `frontend/src/components/Captions/LiveCaptionBridge.tsx` |
| Shared live translation | `frontend/src/contexts/LiveMeetingTranslationContext.tsx`, `frontend/src/hooks/useLiveTranslation.ts` |
| Live workspace | `frontend/src/components/Meeting/TranscriptDrawer.tsx`, `LiveMeetingBar.tsx`, `live-meeting.css`, `frontend/src/app/page.tsx` |
| Route isolation and permissions | `frontend/src/app/layout.tsx`, `frontend/src-tauri/tauri.conf.json` |
| Legacy subtitle compatibility | `frontend/src/components/LiveTranscriptSubtitle.tsx` |

The caption route intentionally does not mount application recording, recovery, onboarding, analytics, notes, or AI providers. Its frame payload contains current display text, language, speaker, phase, session identity and monotonic sequence/epoch only. No audio, full transcript history, credentials, or provider configuration are sent to the secondary window. Capabilities grant the caption webview events/window geometry, not filesystem or process plugin access. IPC handshake/heartbeat handles webview reload; a dismissal latch prevents late enabled frames reopening a closed caption before the main window acknowledges the dismissal.

No Rust capture, VAD/resampler, recognition scheduler, native transcript persistence, database schema, recovery code, or manual-note persistence files were changed. The performance-fix commit remains the ancestor of all work.

## Local validation performed

`node --test tests/lib/live-captions.test.cjs tests/lib/live-caption-translation.test.cjs` from `frontend/` passes 32 tests. TypeScript must be available from the normal project dependencies; the editing environment used its installed TypeScript via `NODE_PATH`.

The tests cover target-only display, pending/error/pause/language changes, stale IPC, hide/reopen ordering, monitor bounds, mixed-DPI coordinate calculations, slow translation coalescing, source changes, previous-session rejection, and canonical translation after preview clearance. The translation tests execute the actual hook logic in a deterministic mocked-hook/IPC harness; they are not a substitute for React DOM or native end-to-end tests.

Changed TypeScript/TSX files were checked with TypeScript syntax transpilation. Full project typechecking and a Next/Tauri build were not run: the editing environment has no project dependency installation or native macOS runtime. The checks must not be represented as a successful native build.

Eight Chromium design-fixture viewport checks passed: workspace at 1100×700, 1440×900, 760×620, 480×700; captions at 720×210, 340×140, 400×300, 1000×260. The fixture uses the new component markup/styles with mocked application state, simplified inner transcript rows/icons and fictional speech. It checks visible controls, horizontal overflow and selected-language caption text; it does not test OS window stacking or the real virtualizer. Any supplied preview is a browser design fixture, not a native desktop screenshot.

## Codex native acceptance checklist

1. Install the existing lockfile dependencies and run the normal local TypeScript/Next/Tauri checks. Confirm the new route is included in the static frontend output and the named window permissions exist in the pinned Tauri version. There are no new package dependencies.
2. On macOS, start a meeting, enable captions, switch to another application and confirm always-on-top behavior without initial focus theft. Check full-screen meeting apps, separate Spaces, Stage Manager and multiple displays. `visibleOnAllWorkspaces` is an OS request, not proof of behavior across every window manager; adjust native window collection behavior only if the real Mac test demonstrates a need. Existing `macOSPrivateApi: true` is preserved. CSS backdrop blur is optional; actual transparent window compositing is required, not a promise of OS background blur.
3. Drag and resize with mouse and keyboard. Test opacity/text controls, minimum size, long text, RTL targets, large display scaling, and an unplugged external monitor. Reopen and confirm position restoration or safe fallback. Use Reset position after unusual monitor changes.
4. With Spanish or Thai input and English selected, both streaming and completed captions must remain English. Keep the document bilingual and verify the caption stays target-only. Switch target mid-request, disconnect the translation provider, pause, resume, and confirm no original-language or prior-language fallback.
5. Hide/reopen repeatedly during window creation and translation. X/Escape must update the main Captions toggle. Navigate to Settings/library while recording and verify captions continue. Change language in Settings while captions are visible. Reload the caption webview and main webview; ensure there is only one live translator.
6. Scroll/select history while new speech arrives. Test linked notes and their existing save/conflict handling. Finish with a final utterance and run the existing stop/drain/reopen golden flow: the native recording and original transcript must match baseline guarantees.
7. Run an extended meeting with translation enabled and off, measuring event-to-paint latency, main-thread commits, memory, CPU/GPU and thermal behavior on a supported Mac. The editing environment did not measure recognition latency, FPS or native CPU/GPU utilization.

CI and deployment remain with Codex. Do not merge until native acceptance is complete.
