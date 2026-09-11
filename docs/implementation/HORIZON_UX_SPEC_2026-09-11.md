# MeetOdds Horizon UX implementation

Base: `main` at `f3db8cee067f859383a75a02db2856241fb1b962`.
Branch: `feat/horizon-ux-spec`.
Source: the supplied `MeetOdds UI mockups` package and Horizon design-system tokens.

## What changed

### Shared Horizon shell

- Replaced the prior blue/green surface language with the Horizon warm-neutral system: paper background, white panels, black text, burnt-orange accent, semantic red recording and green success.
- Space Grotesk is the UI face; JetBrains Mono is used for timestamps, durations, shortcuts and micro-labels.
- Card/control geometry follows the spec's 16px cards and 9–11px controls.
- Sidebar retains the existing navigation/data behavior but now matches the compact Horizon layout: search, Home/Meetings/Actions/Memory/Starred, recent meetings, recording state, orange New meeting CTA, Settings and Ready status.
- The global toolbar now exposes a center portal as well as the existing trailing portal, allowing meeting tabs/live state to occupy the correct macOS chrome instead of adding duplicate bars.

### Home

- Reordered the page to greeting → actions → capture readiness → recent meetings, with attention states below the primary workflow.
- Action preview is capped at three useful items and links directly to the related meeting/moment.
- Capture readiness is a compact four-row card for microphone, system audio, transcription and summary configuration.
- Recent meetings use the mockup's star/title/status/time/duration hierarchy.

### Live meeting

- Recording no longer replaces the whole page with a large transcript document.
- Existing autosaving `NotesEditor` is embedded as the main meeting canvas; its conflict/recovery/save behavior was not replaced.
- Existing virtualized transcript remains the source of truth but is presented as a compact, resizable right-side transcript panel.
- Live meeting title and caption controls occupy the top toolbar. Pop out retains the existing separate notes-window workflow.
- Pause/Stop and elapsed recording time live in a 64px bottom recorder dock. The recording APIs and stop/save flow are unchanged.
- Floating captions retain the existing separate always-on-top Tauri window and translation behavior, restyled to the mockup's translucent black Horizon treatment.

### Meeting detail / post meeting

- Summary / Notes / Transcript are moved into the global toolbar as a segmented control; Share/More use the toolbar's trailing region.
- Meeting title, star, metadata and Open folder sit in a narrow 760px document header.
- Summary-first flow remains authoritative: saved → AI summary & actions → meeting outcome.
- Pre-summary state uses the supplied “Make the meeting useful” composition, with generation above the fold and auto-summary choice beneath it.
- Post-summary outcome and actions remain generated from the saved AI result only; the existing reviewed/edited/done/dismissed persistence behavior remains intact.
- Full editable AI summary stays secondary and collapsed by default.

### Meetings library

- Existing date grouping, virtualized rows, selection, search, sorting, rename/star/delete and status behavior are retained.
- Rows now use the compact Horizon star / title / summary-status / mono-time layout and the page is framed as the supplied All meetings library card.

## Deliberately unchanged

This is a UI implementation. It does not change:

- microphone/system-audio capture;
- VAD/resampling/transcription engines;
- recording persistence/recovery;
- summary provider contracts or summary-first action derivation;
- live translation provider selection;
- meeting database schemas;
- export formats.

## Local/native acceptance for Codex

No CI, deployment or packaging was run for this branch. Before merge:

1. Install/use the repository's pinned dependencies and run changed-file lint plus project typechecking.
2. Run the documented native compile check without packaging placeholders.
3. Verify at 1280×820 and smaller supported windows: Home, Meetings, pre-summary meeting, post-summary meeting, recording, dark floating captions.
4. Record a real meeting: notes must autosave, transcript must update in the right rail, captions must stay above another application, Pause/Resume must work, Stop must save/reopen the recording.
5. Generate a summary with one local provider and connected ChatGPT. Confirm outcome/actions only appear after the saved AI result, and reviewed action state survives regeneration.
6. Exercise keyboard access: sidebar shortcuts, meeting segmented tabs, search, actions, transcript resizing and caption keyboard move/resize.
7. Check dark mode, reduced motion/transparency and multi-display floating-caption restoration.

All implementation commits use `[skip ci]`; Codex owns CI/deployment and final native validation.
