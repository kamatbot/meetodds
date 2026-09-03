# MeetOdds UX Redesign Spec

**Status:** Proposed · v1 · September 2026
**Audience:** the engineer/agent implementing the redesign (Codex), and reviewers.
**Companion docs:** [COMPETITIVE_BENCHMARK.md](COMPETITIVE_BENCHMARK.md) (what Granola and peers do) · [mockups/meetodds-redesign.html](mockups/meetodds-redesign.html) (wireframes of every primary screen, open in a browser).

This document is written to be implemented directly. Every screen section ends with **Acceptance criteria**. Section 13 gives a phased build order and Section 15 maps every existing setting and action to its new home so nothing is lost.

---

## 1. Why redesign

The app works but the experience fights the user. From a full audit of `frontend/src` (September 2026):

| Problem | Evidence in code |
|---|---|
| **Settings are in three places** that drift. | `app/settings/page.tsx` (5 tabs), the Home-screen modal stack in `app/_components/SettingsModal.tsx` (6 modals duplicating provider/model, devices, transcription), and the dead `components/SettingTabs.tsx`. Transcription language lives *only* in a Home modal. "Show confidence indicators" lives *only* in the model-selector modal footer. Live-translation settings live in a popover in the transcript toolbar. |
| **Past meetings are hard to find.** | The sidebar is one flat, ungrouped list under a static "Meeting Notes" header. No dates, no duration, no sort, no folders. Titles are machine-generated (`Meeting 03_09_26_10_58_12`) and can only be renamed from a sidebar hover-pencil modal; the detail-page title editor is commented out. |
| **Export is hidden.** | Export is a dropdown inside `SummaryUpdaterButtonGroup`, only on the detail page, only once a summary exists, summary-only. Transcript export as a file does not exist. No share surface. |
| **Home is blank.** | Idle `app/page.tsx` shows an empty transcript column and a floating record pill. No recent meetings, no state, no next step. |
| **No audio playback.** | `components/AudioPlayer.tsx` is a 0-byte file even though recordings are saved. |
| **No native feel.** | Zero-height `MainNav`, no toolbar, no ⌘ shortcuts beyond editor defaults, no `⌘,` settings window, dark-mode tokens defined in `globals.css` but never used; components hard-code `bg-gray-50`, `bg-blue-600`, `bg-red-500`. |
| **Dead surfaces confuse the IA.** | `app/notes/[id]` (static mock), `AISummary/*`, `SettingTabs`, `ConsoleToggle`, `DatabaseImport/*`, `molecules/form-components/*`, `useAudioPlayer`, `MainNav`. |

## 2. Design goals

1. **Find any meeting in under 5 seconds.** Date-grouped library, global search (⌘K), editable titles, AI-suggested titles.
2. **One settings surface.** A dedicated Settings window (⌘,) with a sidebar of sections. Contextual controls in the app are *shortcuts into* that surface, never a second copy.
3. **Share and export are one click from any meeting.** A `Share` button in the toolbar of every meeting, with Copy-as-Markdown as the first item.
4. **Notes-first capture** (the Granola model): during a meeting the user types rough notes; the transcript is a side panel; AI enhances after. Transcript-first remains available for people who don't type.
5. **Own the local-first advantages Granola cannot offer:** audio kept and playable, re-transcribe, capture-health warnings, model provenance always visible, offline, no account.
6. **Feel like a Mac app.** Sidebar + toolbar + content, system font, standard shortcuts, menu bar item, light and dark.

### Non-goals for v1
Calendar integration, auto meeting detection, chat-with-meeting ("Ask"), People/Companies views and cloud sync are **Phase 3 or later**. The spec reserves space for them (Section 6.2 "Upcoming", Section 6.5 "Ask bar") but they are not required to ship the redesign.

---

## 3. Benchmark takeaways (details in the benchmark doc)

- **Granola** wins on calm: a document editor, a transcript toggle, and a top-right **Share** button (`Copy notes` as Markdown, `Copy link`) with integrations under `⋯`. Home shows "Coming up" then recent notes. Settings is a sidebar of sections (Profile, Calendar, Integrations, Templates, Notifications, Language). Its biggest complaints: no audio playback, silent capture failures, unreliable speaker labels.
- **Notion / Fireflies / Otter** converge on **Notes | Summary | Transcript** as the post-meeting structure and a floating recording controller while the user is in another app.
- **Fathom** puts `Copy Summary` on every call page; **Otter** exports TXT/DOCX/PDF/SRT from a `⋯` on the transcript.
- **Native Mac references** (Things, Bear, Craft): 13 px body, 8 px grid, translucent sidebar, ⌘1…⌘9 to switch views, `⌘,` settings window with toolbar or sidebar sections.

What MeetOdds adopts: Granola's home/sidebar/share/settings structure and notes-first model; the Notes/Summary/Transcript tabs; a floating recorder; Otter's transcript export formats. What MeetOdds adds: audio playback + re-transcribe, capture health, provenance chips, bulk Markdown export.

---

## 4. Information architecture

### 4.1 Windows
| Window | Purpose | Tauri label |
|---|---|---|
| **Main** | Shell: sidebar + toolbar + content. Single instance. Closing hides to menu bar (existing behaviour). | `main` |
| **Settings** | Separate window, `⌘,`. Titled "MeetOdds Settings", 760×560, not resizable below that, no zoom button. | `settings` |
| **Recorder** (Phase 3) | Small always-on-top floating panel shown when recording and the main window is not focused. | `recorder` |

### 4.2 Routes (Next.js app router, static export, so dynamic segments stay as query params)
| Route | Screen |
|---|---|
| `/` | Home (Section 6.2) |
| `/meetings` | Library (Section 6.3) |
| `/meeting?id=<id>` | Meeting: live while recording, detail afterwards (Sections 6.4, 6.5) |
| `/settings?section=<key>` | Settings content, loaded only inside the `settings` window (Section 6.8) |

Delete `/meeting-details` (redirect old links to `/meeting?id=`) and `/notes/[id]`.

### 4.3 Sidebar (main window)
```
┌──────────────────────────┐
│ ⌘K  Search…              │  search field, opens command palette
├──────────────────────────┤
│ ● Recording · 12:04      │  only while recording; click → live meeting
├──────────────────────────┤
│ ⌂  Home              ⌘1  │
│ ☰  Meetings          ⌘2  │
│ ☆  Starred           ⌘3  │
├──────────────────────────┤
│ RECENT                   │
│   Sprint planning        │  last 8 meetings, title + relative time
│   Client call – Acme     │
│   …                      │
│   Show all →             │
├──────────────────────────┤
│ Folders (Phase 2)        │
├──────────────────────────┤
│ [ ● New meeting     ⌘N ] │  primary button
│ ⚙ Settings  ·  ● Ready   │  gear opens Settings window; status dot = engine health
└──────────────────────────┘
```
- Width 260 px, min 220, max 360, user-resizable, persisted.
- Toggle with `⌃⌘S` or the toolbar sidebar button. When hidden, content spans the window (no icon rail; matches Finder/Notes).
- Background uses a translucent material on macOS (`backdrop-filter` + `--sidebar-bg` token); solid on other platforms.

### 4.4 Toolbar (main window)
The window uses Tauri `titleBarStyle: "Overlay"` + `hiddenTitle: true` on macOS so traffic lights sit inside our toolbar. The toolbar row is 52 px, `data-tauri-drag-region`, and has three zones:

- **Leading:** sidebar toggle, back/forward (browser-style history).
- **Center:** context (page title, or the meeting title editor + segmented control on the meeting screen).
- **Trailing:** page actions (`Share`, `⋯`, or `New meeting`).

---

## 5. Visual system

### 5.1 Principles
Calm, document-like, high contrast text, one accent colour, red reserved for recording state. Nothing decorative that does not carry state.

### 5.2 Typography
- Font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Source Sans 3", sans-serif`. Keep Source Sans 3 loaded as the cross-platform fallback; drop it as the primary face.
- Scale (px / line-height): display 22/28 semibold (page titles), title 17/22 semibold (meeting title), body 14/20 (editor and transcript use 15/24), UI 13/18 (sidebar, toolbar, settings), caption 12/16, mono 12/16 (timestamps, paths).
- Editor and transcript: max line width 68ch, centred.

### 5.3 Spacing and shape
- 8 px grid; component padding 8/12/16; page gutters 24 (content) and 12 (sidebar).
- Radii: control 6, card 10, popover 12, window sheet 14.
- Borders: hairline `1px` `--border`; elevation via `0 0 0 0.5px rgb(0 0 0/.08), 0 8px 24px rgb(0 0 0/.12)` for popovers.

### 5.4 Colour tokens (replace the unused shadcn HSL set in `globals.css`)
| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F7F7F5` | `#1C1C1E` | window ground |
| `--surface` | `#FFFFFF` | `#232326` | cards, editor, settings content |
| `--sidebar-bg` | `rgba(242,242,240,.85)` | `rgba(30,30,32,.85)` | sidebar material |
| `--border` | `#E6E6E3` | `#333336` | hairlines |
| `--text` | `#1B1B1B` | `#EDEDED` | primary text |
| `--text-2` | `#6B6B6B` | `#A1A1A6` | secondary |
| `--text-3` | `#9A9A9A` | `#6E6E73` | captions, timestamps |
| `--accent` | `#3B6EF6` | `#5B8CFF` | links, selection, primary buttons, focus ring |
| `--accent-soft` | `#E8EFFF` | `#22304F` | selected rows, chips |
| `--record` | `#E5484D` | `#FF6369` | recording state only |
| `--success` | `#2E9E5B` | `#4CC37A` | engine ready, saved |
| `--warn` | `#D98D0B` | `#F2B23E` | capture health, model missing |
| `--danger` | `#D92D20` | `#F26B62` | destructive |

Dark mode follows the system (`prefers-color-scheme`) with an override in Settings → General (System / Light / Dark). Implementation: set `data-theme` on `<html>`; all components must use tokens, never Tailwind grey/blue/red literals. Map the tokens into `tailwind.config.js` (`bg-surface`, `text-2`, etc.) and delete `tailwind.config.ts`.

### 5.5 Iconography and motion
- Lucide icons at 16 px in UI, 20 px in the recorder. Stroke 1.75.
- Motion: 150 ms ease-out for hover/selection, 250 ms for panels (transcript drawer, sidebar). Respect `prefers-reduced-motion`. No random-height "audio bars"; use the real level meter.

---

## 6. Screens

### 6.1 App shell
Described in 4.3–4.4. Additional rules:
- Every toolbar action has a menu-bar equivalent (Section 9) and a shortcut (Section 10).
- The sidebar `RECENT` list is the single quick-access list. Full browsing is the Library.
- Engine status dot (bottom of sidebar): green = transcription engine loaded and summary provider reachable; amber = a model is downloading or a provider is unconfigured; red = missing transcription model. Click → Settings on the relevant section.

**Acceptance criteria**
- Sidebar hides/shows with `⌃⌘S`, width persists across launches.
- Traffic lights are inside the toolbar on macOS and the toolbar is draggable.
- No component in `src/` uses `bg-gray-*`, `text-gray-*`, `bg-blue-*`, `bg-red-*` literals; tokens only. Dark mode renders every screen.

### 6.2 Home (`/`)
Purpose: answer "what do I do now" and "what did I just do".

Layout (content column max 760 px, centred):
1. **Greeting row** – "Good morning" + date on the left; **`● New meeting`** primary button on the right (same as ⌘N).
2. **Capture readiness card** – one line per input with a live status: `Microphone · MacBook Pro Microphone`, `System audio · Ready` (or `Needs permission → Fix`), `Transcription · Parakeet v3 (on-device)`, `Summary · Ollama · llama3.1:8b`. Each row is a chip that opens the matching Settings section. This replaces the Home toolbar's Model/Devices/Language buttons and the permission-warning card.
3. **Needs attention** (only when non-empty) – recovered transcripts waiting, meetings without a summary, model download in progress, update available. Each with one action button.
4. **Upcoming** (Phase 3, calendar) – hidden until a calendar is connected.
5. **Recent meetings** – the last 10 as rows (see 6.3 row anatomy). "See all meetings →" goes to the Library.

**Empty state** (no meetings yet): illustration-free card: "Your meetings will appear here. Start one, or drop an audio file to import it." with `New meeting` and `Import audio…` buttons.

**Acceptance criteria**
- Home never shows a live transcript; starting a meeting navigates to `/meeting?id=`.
- Readiness card reflects real state within 1 s of a device or model change.
- Drag-and-drop of an audio file anywhere on Home opens the import sheet (no longer beta-gated; see Section 15).

### 6.3 Library (`/meetings`)
Purpose: browse and manage every meeting.

- **Toolbar:** title "Meetings"; trailing: search-in-list field (filters as you type, also `⌘F`), sort menu (Newest, Oldest, Longest, Title A–Z), `Select` (multi-select mode).
- **Groups:** Today, Yesterday, This week, Last week, then by month ("August 2026"). Sticky group headers.
- **Row anatomy:** `[star] Title` (semibold) · `10:58 am · 24 min` · summary status glyph (✓ summarised, ○ not yet, ⟳ generating) · participants hint if known ("Me + 2") · folder/tag chips (Phase 2). Right-click / `⋯` menu: Open, Rename (inline), Star, Move to folder, Share…, Export…, Reveal recording in Finder, Delete.
- **Inline rename:** double-click or `↩` on a selected row edits the title in place (Finder behaviour). Remove the "Edit Meeting Title" modal.
- **Multi-select:** `Select` or `⇧`/`⌘`-click. Action bar appears at the bottom: `Export Markdown (n)`, `Move to folder`, `Delete`. Bulk Markdown export writes one `.md` per meeting plus the audio path into a chosen folder (Obsidian-friendly).
- **Keyboard:** `↑/↓` move selection, `↩` open, `⌘⌫` delete (with undo toast, 8 s), `⌘D` star.

**Acceptance criteria**
- 1,000 meetings render without jank (virtualised list; reuse `@tanstack/react-virtual`).
- Search matches title and transcript body and shows a snippet under the row, as the current sidebar does.
- Delete is undoable from the toast; the deletion is only committed after the toast expires.

### 6.4 Live meeting (`/meeting?id=` while recording)
Purpose: let the user stay present. Notes in the middle, transcript beside, controls at the bottom.

```
┌ toolbar ───────────────────────────────────────────────────────────┐
│ ◧  ‹ ›   [ Name this meeting…            ]   Notes | Transcript  ⧉ │
├────────────────────────────────────────────┬───────────────────────┤
│                                            │ Transcript      ⋯  ✕ │
│  Notes editor (BlockNote)                  │ 10:58  Me   Let's…    │
│  – rough bullets typed by the user         │ 10:59  Them Sure, …   │
│  – "/" opens template picker               │ ● Listening…          │
│                                            │ [translate ▾]         │
├────────────────────────────────────────────┴───────────────────────┤
│  ●  12:04   ▁▃▅▂▁ mic  ▁▁▂▁▁ system    ⏸ Pause   ■ Stop   ⚠ health│
└────────────────────────────────────────────────────────────────────┘
```

- **Title field** in the toolbar centre. Default value: `Meeting · Wed 3 Sep, 10:58` (localised). It is focused with the placeholder "Name this meeting…" for the first 5 s after start, then defocuses. Blur or `↩` saves. Rename is `⌘⇧R` anywhere on the meeting screen.
- **Notes editor** is the default focus. It is the user's own notes (new `notes_markdown` field, Section 8). Autosaves every 2 s and on blur.
- **Transcript panel** (right, 360 px, resizable, toggle `⌘T`) shows the live transcript with speaker label (`Me` / `Them` from mic vs system channel; named speakers when diarisation lands), timestamps, confidence shading if enabled. Panel header `⋯` menu: Copy transcript, Language, Live translation (opens the translation popover, unchanged controls), Show confidence.
- **Recorder bar** is docked at the bottom of the content area (not floating over text). Contents: recording dot + elapsed time; two real level meters (mic, system); `Pause` (`⌘⇧P`), `Stop` (`⌘⇧S`, confirm if under 10 s); **capture health** slot.
- **Capture health** rules (answers Granola's "silent failure" complaint):
  - System audio silent for 30 s while mic is active → amber `No system audio · Check` (opens device popover).
  - Mic silent 30 s → amber `No microphone signal`.
  - Device disconnected → red `Microphone disconnected · Switched to Built-in` with undo.
  - Transcription backlog > 20 s → amber `Transcription is behind` (replaces `chunkDropWarning` modal).
- **Stop flow:** `Stop` → bar shows `Saving… ▸ Transcribing remaining audio ▸ Generating summary` as an inline progress strip (replaces `StatusOverlays` full-screen states). The page switches to detail mode in place; no navigation, no "View meeting" toast.
- **Leaving the screen** while recording keeps the sidebar `● Recording · 12:04` chip; clicking it returns.

**Acceptance criteria**
- Typing starts within 100 ms of the page appearing; the recorder never steals focus from the editor.
- Transcript panel state (open/closed, width) persists.
- Every health condition above has a visible state and is testable by muting the corresponding device.

### 6.5 Meeting detail (`/meeting?id=` after recording)

```
┌ toolbar ───────────────────────────────────────────────────────────┐
│ ◧ ‹ ›   Sprint planning ✎        Summary | Notes | Transcript   [Share ▾] ⋯ │
├──────────────────────────────────────────────────────────────────────────┤
│  Wed 3 Sep 2026 · 10:58–11:22 · 24 min · Me + 2 · ☆ · Folder: Product     │
│                                                                          │
│  (tab content)                                                           │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  ▶ 03:41 / 24:10  ──────●─────────────────────  1× ▾   ↻ 15   ⤓         │  audio bar (Transcript tab, or pinned)
└──────────────────────────────────────────────────────────────────────────┘
```

- **Header meta row:** date, time range, duration, participants, star, folder chip. All editable in place where applicable.
- **Tabs** (segmented control in toolbar centre, `⌘1/2/3` while on this screen are *not* used, use `⌃1/2/3`):
  - **Summary** – the AI output in BlockNote, editable. A **template chip** on the tab (`Standard meeting ▾`) regenerates with another template (Granola's "Enhanced ▾" pattern). Toolbar of the tab: `Regenerate`, `Add context` (collapsible textarea; this is today's "Add context for AI summary" box, moved out of the transcript column), summary language picker, provenance line `Generated with Ollama · llama3.1:8b · 12 s ago`. Empty state: `Generate summary` primary button + template picker; if no provider is configured, `Set up a summary model →` opens Settings → AI Summary.
  - **Notes** – the user's own notes from the live screen. `Enhance with AI` merges notes and transcript into the Summary tab (notes-first model). Unchanged if the user never typed.
  - **Transcript** – full transcript, virtualised, speaker labels, timestamps as buttons that seek the audio. Find-in-transcript (`⌘F`). Header actions: `Copy`, `Export ▾` (TXT, SRT, Markdown), `Re-transcribe…` (the current "Enhance"/Retranscribe dialog, no longer beta-gated), `Speakers` (rename `Them` → name, applies to whole transcript).
- **Audio bar** appears on the Transcript tab and can be pinned across tabs. Play/pause `Space` when the transcript has focus, `←/→` seek 5 s, speed menu 0.75–2×, download icon = reveal file in Finder. Highlights the transcript segment currently playing. If the recording was not saved (auto-save off) the bar shows `No audio saved for this meeting · Change in Settings`.
- **Ask bar** (Phase 3): a text input pinned above the audio bar, "Ask about this meeting…". Reserve the layout slot; do not build in v1.
- **`⋯` menu:** Rename, Star, Move to folder, Duplicate summary as new note, Reveal recording in Finder, Regenerate title, Delete meeting.
- **AI title suggestion:** after the first summary generates, if the title is still the auto default, show an inline chip under the title: `Suggested: "Sprint planning – Q4 scope"  Use · Dismiss`.

**Acceptance criteria**
- Title edits from the header persist and update the sidebar within one render.
- Clicking any transcript timestamp seeks the audio to ±0.5 s.
- Summary regenerate with a different template keeps the previous version reachable via `⌘Z` in the editor or a "Restore previous" item in the tab chip menu.
- Delete is only available from `⋯` and the Library, with the same undo toast.

### 6.6 Share and export
The `Share ▾` button is in the trailing toolbar zone of **every** meeting screen, live or finished. Menu, in order:

```
Copy as Markdown            ⌘⇧C     (summary if present, else notes, else transcript)
Copy summary
Copy transcript
──────────────
Export…                     ⌘E      opens the Export sheet
Reveal recording in Finder
──────────────
Email…                              opens mailto: with Markdown body (Phase 2)
Send to Obsidian / Notion / Slack   (Phase 3, disabled with "Coming soon" tooltip until then)
```

**Export sheet** (modal sheet attached to the window):
- Content checkboxes: Summary, Notes, Transcript, Audio file.
- Format radio: Markdown (`.md`), PDF, Word (`.docx`), Plain text (`.txt`), Subtitles (`.srt`, transcript only), JSON (everything, machine-readable).
- Destination: `Downloads` (default) / `Choose folder…` (remembered), filename preview using `YYYY-MM-DD Title.ext`.
- `Export` button; success toast with `Show in Finder`.
- Reuses `lib/meeting-export.ts` and `meeting-export-formats.ts`; add TXT/SRT/JSON serialisers and a transcript renderer for PDF/DOCX.

**Acceptance criteria**
- `Copy as Markdown` works during a live recording (copies notes + transcript so far).
- The Export sheet is reachable in two clicks from Home (open meeting → Share → Export) and one shortcut (`⌘E`) from any meeting.
- Bulk export from the Library produces one file per meeting with the same naming rule.

### 6.7 Search and command palette (`⌘K`)
One palette, two modes:
- **Typing text** searches meeting titles, summaries, notes and transcript bodies (existing `searchTranscripts` plus title/summary). Results grouped: Meetings, Transcript matches (with snippet and timestamp; selecting opens the meeting on the Transcript tab and scrolls to the hit).
- **Typing `>`** lists commands: New meeting, Import audio, Open Settings…, Toggle transcript, Export…, Switch summary model…, Change microphone…, Check for updates. Each shows its shortcut.
- The sidebar search field and the toolbar search icon both open the palette. `⌘F` on Library and Transcript is local find, not the palette.

**Acceptance criteria**
- Results appear within 150 ms for a 200-meeting database (debounce 80 ms, SQLite FTS if needed).
- `⌘K` works from any screen including Settings.

### 6.8 Settings window (`⌘,`)
Separate window, sidebar of sections on the left (200 px), scrolling content on the right (max 520 px form width). Every section is a flat form: setting label left, control right, one-line description under the label. No cards-in-cards, no tabs-in-tabs. Search field at the top of the sidebar filters settings by label (Phase 2).

| Section | Contents (source of truth for each; see Section 15 for where it came from) |
|---|---|
| **General** | Appearance (System/Light/Dark) · Launch at login · Keep running in menu bar when window closes · Show meeting start/stop notifications · Language of the app UI (future) · Check for updates automatically + `Check now` |
| **Recording** | Microphone (select + level meter + `Test`) · System audio (select) · Audio capture method (the `AudioBackendSelector` list, with its explainer) · Save audio recordings (toggle) · Recording folder (path + `Change…` + `Open`) · Warn when no audio detected (toggle, default on) |
| **Transcription** | Engine (Parakeet on-device / Whisper on-device; cloud engines when re-enabled) · Model manager for the selected engine (download/delete with progress; the existing `ParakeetModelManager` / `WhisperModelManager`) · Spoken language (the `LanguageSelection` control, Whisper only) · Show confidence indicators · Speaker labels (Me/Them; named diarisation when available) |
| **AI Summary** | Provider (Built-in, Ollama, Claude, OpenAI, OpenRouter, Groq, Custom server, OpenAI Codex) · Model (searchable) · API key / endpoint / advanced (max tokens, temperature, top-p) for the provider · `Test connection` · Generate summary automatically after recording · Default template · Default summary language + quick-switch languages · Suggest a title after summarising (toggle) |
| **Templates** | List of built-in and custom templates with preview; `New template…`, `Import JSON…`, `Open templates folder`. (Custom templates already load from app data; this gives them a UI.) |
| **Live translation** | Defaults for the translation popover: enabled, speed, engine, target language, context turns, display mode, model override. The in-meeting popover reads and writes the same store. |
| **Privacy & data** | Storage locations (database, models, recordings) each with `Open` · Usage analytics toggle + user id + `Preview data` · Retention: delete audio after N days (off by default) · `Import legacy database…` (surfaces the existing `DatabaseImport` components) |
| **Labs** | Beta flags from `types/betaFeatures.ts`, with the warning banner |
| **About** | Version, `Check for updates`, links (privacy policy, licence), the positioning copy from `About.tsx`, `Show diagnostics` (the console toggle) |

Behaviour:
- Opened by `⌘,`, the app menu, the sidebar gear, the menu-bar item, any readiness chip (deep-links via `?section=recording`), and the command palette.
- Changes apply immediately (no Save button) except API keys and endpoints, which have an inline `Save` and `Test`.
- Window remembers the last section.

**Acceptance criteria**
- `app/_components/SettingsModal.tsx` and `components/SettingTabs.tsx` are deleted; no setting exists in two components.
- Changing the microphone in Settings changes the Home readiness card without reload.
- Every section is reachable with `⌘,` then `↑/↓` in the section list.

### 6.9 Menu bar item and floating recorder
- **Menu bar (tray) item** keeps the existing items and gains: a header line with state (`Idle` / `Recording · 12:04 · Sprint planning`), `Start meeting` / `Pause` / `Stop`, the last three meetings (open on click), `Open MeetOdds`, `Settings…`, `Check for updates`, `Quit`. Icon shows a red dot while recording.
- **Floating recorder** (Phase 3): 280×56 always-on-top panel with dot, elapsed time, level meter, pause, stop, and a `↗` to bring the main window forward. Appears when recording and the main window loses focus; draggable; position persisted. Mirrors Granola's right-edge indicator and Otter's controller.

### 6.10 Onboarding
Keep the four existing steps and restyle them with the token system. Changes:
- Step 1 adds a choice: `I take notes while I talk` / `I just want a transcript` → sets whether the Notes editor or the Transcript panel is focused on a new meeting (stored in General).
- Final step lands on **Home** with the readiness card fully green and a `Start your first meeting` button; no `window.location.reload()`.
- If a download is still running, Home's **Needs attention** shows it; the user can still start a transcript-only meeting if the transcription model is ready.

### 6.11 States
- **Loading:** skeleton rows (Library, Recent) and a skeleton editor; never a spinner larger than 20 px inline.
- **Errors:** inline, next to the thing that failed, with one action. Recording-stopped-by-error becomes a banner at the top of the meeting screen ("Recording stopped: microphone was disconnected. Audio up to 12:04 is saved."), not a modal.
- **Empty:** every list has a one-sentence empty state with a primary action.
- **Toasts:** bottom-centre (Sonner, existing), max one at a time, 5 s, with undo where applicable.

---

## 7. Component inventory

**New**
- `AppShell` (`Sidebar`, `Toolbar`, `ContentArea`), `SidebarNavItem`, `RecentMeetingItem`, `EngineStatusDot`
- `MeetingRow`, `MeetingGroupHeader`, `MeetingListVirtualized`, `BulkActionBar`
- `MeetingHeader` (title editor + meta row), `MeetingTabs` (segmented control), `TemplateChip`
- `NotesEditor` (BlockNote instance for user notes), `SummaryEditor` (existing `BlockNoteSummaryView`, renamed)
- `TranscriptPanel` (live, docked right), `TranscriptView` (detail tab; keep `VirtualizedTranscriptView` internals), `SpeakerLabel`, `TranscriptFindBar`
- `RecorderBar`, `LevelMeter` (reuse `AudioLevelMeter`), `CaptureHealthBadge`, `StopProgressStrip`
- `ShareMenu`, `ExportSheet`
- `CommandPalette`
- `ReadinessCard`, `AttentionList`
- `AudioBar` + a real `useAudioPlayer` (the file exists, empty)
- `SettingsWindow`, `SettingsSidebar`, `SettingsSection`, `SettingRow` (label + description + control)
- `TitleSuggestionChip`

**Changed**
- `Sidebar/index.tsx` → rewritten as `AppShell/Sidebar.tsx`; `SidebarProvider` keeps meeting list state but drops title-modal state.
- `RecordingControls` → `RecorderBar` (docked, no random bars, no JS-centred margin).
- `SummaryGeneratorButtonGroup` / `SummaryUpdaterButtonGroup` → dissolved into `MeetingTabs` actions and `ShareMenu`.
- `TranscriptButtonGroup` → transcript tab header.
- `LiveTranslationControl` → unchanged controls, hosted in the transcript panel `⋯` menu and in Settings → Live translation.
- `ModelSettingsModal` (1,457 lines) → split into `SummaryProviderSettings` (Settings → AI Summary) and a small `ModelQuickSwitch` popover used by the template chip's "model" item; both read the same config store.
- `DeviceSelection`, `LanguageSelection`, `AudioBackendSelector`, `WhisperModelManager`, `ParakeetModelManager`, `BuiltInModelManager`, `AnalyticsConsentSwitch`, `SummaryLanguageSettings`, `BetaSettings`, `About` → restyled with `SettingRow`, mounted only in Settings.
- `ImportAudioDialog` → sheet, not beta-gated. `RetranscribeDialog` → "Re-transcribe…", not beta-gated.
- `PermissionWarning` → a row in `ReadinessCard`.
- `TranscriptRecovery` → an item in `AttentionList` (no auto-opening dialog).

**Removed**
- `app/_components/SettingsModal.tsx`, `SettingTabs.tsx`, `ConsoleToggle.tsx` (folded into About → diagnostics), `MainNav`, `app/notes/[id]`, `AISummary/{index,Block,Section}.tsx`, `molecules/form-components/*`, `BlockNoteEditor/BasicBlockNoteTest`, `StatusOverlays` (replaced by `StopProgressStrip`), `EmptyStateSummary` (replaced by the Summary tab empty state), `tailwind.config.ts`.

---

## 8. Data model changes (SQLite via the Rust core)

Add to the meeting record (new Tauri commands `update_meeting_fields`, `list_meetings_paged`):

| Field | Type | Notes |
|---|---|---|
| `notes_markdown` | TEXT | user's own notes from the live screen |
| `summary_template_id` | TEXT | template used for the current summary |
| `summary_provider`, `summary_model`, `summary_generated_at` | TEXT | provenance line |
| `title_source` | TEXT | `auto` / `user` / `ai` — drives the suggestion chip |
| `starred` | INTEGER | |
| `folder_id` | TEXT NULL | Phase 2 |
| `participants` | TEXT (JSON) | Phase 3, from calendar; v1 stores speaker names the user assigns |
| `duration_ms` | INTEGER | computed at stop; needed for list rows |
| `audio_path` | TEXT NULL | explicit, instead of deriving from `folder_path` |

Add a `speakers` table (`meeting_id`, `channel_key`, `display_name`) for the Me/Them rename feature, and an FTS5 virtual table over transcript text if search latency exceeds the 150 ms target.

---

## 9. Native / Tauri changes

- `tauri.conf.json` main window: `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `minWidth: 900`, `minHeight: 600`, `theme` unset (follow system). Add the `settings` window definition (`visible: false`, created on demand). Add `core:window:allow-*` capabilities needed for creating/focusing windows and `data-tauri-drag-region`.
- **App menu** (macOS): `MeetOdds` (About, Settings… `⌘,`, Quit), `File` (New meeting `⌘N`, Import audio… `⌘⇧I`, Export… `⌘E`, Close `⌘W`), `Edit` (standard), `Meeting` (Rename `⌘⇧R`, Star `⌘D`, Pause/Resume `⌘⇧P`, Stop `⌘⇧S`, Regenerate summary `⌘⇧G`, Re-transcribe…), `View` (Home `⌘1`, Meetings `⌘2`, Starred `⌘3`, Toggle sidebar `⌃⌘S`, Toggle transcript `⌘T`, Summary/Notes/Transcript `⌃1/2/3`), `Window`, `Help`.
- **Tray** per 6.9. Emit `recording-state` with elapsed time so the tray title can show it.
- **Deep links** from the tray/readiness chips: `open_settings(section)` command that creates/focuses the settings window with `?section=`.
- Notifications keep using the existing plugin; the "recording started" notification includes a `Stop` action where the platform allows it.

---

## 10. Keyboard shortcuts

| Action | Shortcut |
|---|---|
| New meeting | `⌘N` |
| Stop recording | `⌘⇧S` |
| Pause / resume | `⌘⇧P` |
| Command palette / search | `⌘K` |
| Find in list / transcript | `⌘F` |
| Home / Meetings / Starred | `⌘1` / `⌘2` / `⌘3` |
| Summary / Notes / Transcript tab | `⌃1` / `⌃2` / `⌃3` |
| Toggle sidebar | `⌃⌘S` |
| Toggle transcript panel (live) | `⌘T` |
| Rename meeting | `⌘⇧R` |
| Star | `⌘D` |
| Copy as Markdown | `⌘⇧C` |
| Export… | `⌘E` |
| Import audio… | `⌘⇧I` |
| Regenerate summary | `⌘⇧G` |
| Settings | `⌘,` |
| Play / pause audio (transcript focused) | `Space` |
| Seek ±5 s | `←` / `→` |
| Delete meeting (list) | `⌘⌫` |

---

## 11. Copy guidelines
- Use "meeting", never "note" or "recording", for the object in lists (audio is "the recording").
- Verbs on buttons: `New meeting`, `Stop`, `Generate summary`, `Copy as Markdown`, `Export…`. Ellipsis when a dialog follows.
- Status copy states the fact and the fix: "No system audio for 30 s · Check devices".
- No emoji in menus or labels (current tray uses ⏸ ⏹ 🔄; replace with plain text).

## 12. Accessibility
- All interactive elements reachable by keyboard with a visible focus ring (`--accent`, 2 px).
- Transcript timestamps are buttons with `aria-label="Jump to 3:41"`.
- Level meters have `role="meter"`. Recording state announced via `aria-live="polite"` on start/stop/health changes.
- Minimum contrast 4.5:1 for text on all tokens in both themes (the token table above satisfies this).
- Reduced motion honoured; no information conveyed by colour alone (health badges carry icons and text).

---

## 13. Implementation plan

Each phase is shippable on its own. Do not start a later phase's screens early; do land the token system first because every screen depends on it.

**Phase 0 – Foundation (1 week)**
- Token system in `globals.css` + `tailwind.config.js`; theme switch; delete `tailwind.config.ts`.
- `AppShell` with new sidebar, toolbar, overlay title bar, `⌃⌘S`, routes `/`, `/meetings`, `/meeting`.
- Remove dead code listed in Section 7. Redirect `/meeting-details`.
- Acceptance: app boots into the new shell with the old page bodies mounted inside; dark mode works.

**Phase 1 – Find and manage meetings (1–2 weeks)**
- Library with grouping, virtualisation, inline rename, star, sort, multi-select, undoable delete.
- Home with readiness card, attention list, recent meetings, empty state.
- Command palette with search and commands.
- Data model: `duration_ms`, `starred`, `title_source`, paged list command.
- Acceptance: Sections 6.2, 6.3, 6.7 criteria.

**Phase 2 – Meeting screen, share, export, audio (2 weeks)**
- `MeetingHeader`, tabs, Summary/Notes/Transcript, template chip, provenance, title suggestion.
- Live layout with `NotesEditor`, docked `TranscriptPanel`, `RecorderBar`, capture health, `StopProgressStrip`.
- `ShareMenu`, `ExportSheet`, TXT/SRT/JSON serialisers, bulk export.
- `AudioBar` + `useAudioPlayer`, timestamp seek, speaker rename.
- Data model: `notes_markdown`, summary provenance fields, `audio_path`, `speakers`.
- Acceptance: Sections 6.4, 6.5, 6.6 criteria.

**Phase 3 – Settings window and native polish (1 week)**
- `settings` Tauri window, all sections from 6.8, deep links, delete the Home modal stack and `SettingTabs`.
- App menu, shortcuts table, tray rewrite, onboarding restyle.
- Acceptance: Section 6.8 criteria; every shortcut in Section 10 works.

**Phase 4 – Later**
- Folders, settings search, email share, floating recorder window, calendar and upcoming, auto meeting detection, Ask bar, Obsidian/Notion/Slack senders, named diarisation.

Suggested order of Phases 2 and 3 can be swapped if the settings consolidation is the more urgent pain; nothing in Phase 2 depends on the Settings window existing, because the contextual popovers read the same config store either way.

---

## 14. Decisions made and open questions

**Decided**
- Keep Next.js static export and query-param routes (no server, no dynamic segments).
- Keep BlockNote for both notes and summary editors.
- Settings is a separate window, not a route in the main window, because it must be reachable while a meeting is live without navigating away from the notes.
- Red is only ever used for recording state and destructive actions.

**Open (implementer may choose, note the choice in the PR)**
- Whether the transcript panel on the live screen defaults open or closed for users who chose "I take notes" in onboarding (recommendation: closed, with the `Listening…` dot on the toggle button).
- Whether to ship `Starred` as a sidebar item or as a Library filter in Phase 1 (recommendation: sidebar item, it is cheap).
- FTS5 vs. LIKE for search (measure first).

---

## 15. Where everything moves (old → new)

| Today | New home |
|---|---|
| Home toolbar → Copy | Share ▾ → Copy transcript (live screen) |
| Home toolbar → Model | Readiness card → Summary chip → Settings → AI Summary |
| Home toolbar → Devices | Readiness card → Microphone / System audio → Settings → Recording |
| Home toolbar → Language (Whisper) | Transcript panel ⋯ → Language; Settings → Transcription |
| Home toolbar → Live translation popover | Transcript panel ⋯ → Live translation; defaults in Settings → Live translation |
| Home permission warning card | Readiness card row with `Fix` |
| Home modal "Preferences" (duplicate provider picker) | Deleted; Settings → AI Summary |
| Home modal "Audio Device Settings" | Deleted; Settings → Recording |
| Home modal "Language Settings" | Settings → Transcription → Spoken language |
| Home modal "Transcription Model Settings" + Show confidence | Settings → Transcription |
| Home modals "Recording Stopped" / "Performance Warning" | Inline banner on the meeting screen / capture-health badge |
| `/settings` General (notifications, storage, analytics) | Settings → General (notifications), Privacy & data (storage, analytics) |
| `/settings` Recordings | Settings → Recording |
| `/settings` Transcription | Settings → Transcription |
| `/settings` Summary (auto summary, languages, provider) | Settings → AI Summary |
| `/settings` Beta | Settings → Labs |
| Sidebar → Info / About dialog | Settings → About; app menu → About MeetOdds |
| Sidebar → Import Audio (beta) | File → Import audio… `⌘⇧I`, Home drop zone, command palette. Not beta-gated |
| Sidebar hover pencil → rename modal | Inline rename in Library, title editor in meeting header |
| Sidebar hover trash | Library row ⋯ / `⌘⌫`, meeting ⋯; undoable |
| Detail → Transcript column Copy / Recording / Enhance | Transcript tab header → Copy / Export ▾ / Re-transcribe…; Share ▾ → Reveal recording in Finder |
| Detail → "Add context for AI summary" textarea | Summary tab → Add context (collapsible) |
| Detail → Generate / Regenerate / Stop | Summary tab primary button; `⌘⇧G` |
| Detail → AI Model dialog | Template chip → Model… (quick switch) and Settings → AI Summary |
| Detail → Template dropdown | Template chip on the Summary tab |
| Detail → Languages popover | Summary tab → language picker (unchanged control) |
| Detail → Save | Autosave (dirty indicator in header, `⌘S` forces) |
| Detail → Copy | Share ▾ → Copy summary / Copy as Markdown |
| Detail → Export ▾ (PDF/DOCX/MD) | Share ▾ → Export… sheet, plus TXT/SRT/JSON and transcript/audio |
| Transcript recovery auto-dialog | Home → Needs attention |
| `StatusOverlays` stop states | `StopProgressStrip` in the recorder bar |
| Tray menu | Section 6.9 |
