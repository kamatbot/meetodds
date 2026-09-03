# Competitive benchmark: desktop AI meeting note-takers

**Purpose:** ground the [UX redesign spec](UX_REDESIGN_SPEC.md) in what users of Granola, Notion AI Meeting Notes, Otter, Fireflies, Fathom, tl;dv, Krisp and the local-first open-source apps already expect. Compiled September 2026 from vendor help centres, blogs, GitHub READMEs and review sites.

**Caveat:** several vendor sites could not be fetched directly from the research environment, so some UI labels come from search-engine excerpts of the help pages. Items marked *[unverified]* should be checked against the live app before being copied into UI copy.

---

## 1. Comparison

| | Granola | Notion AI Meeting Notes | Otter.ai | Fireflies | Fathom | tl;dv | Krisp | anarlog (ex-Hyprnote) |
|---|---|---|---|---|---|---|---|---|
| Capture | Bot-free, system audio; Mac/Win/iOS/Watch (Electron) | Bot-free, desktop only | Bot by default; bot-free desktop app since Oct 2025 | Bot; bot-free desktop app since Nov 2025 (paid) | Bot or bot-free desktop / Chrome ext. | Bot or bot-free desktop | Bot-free (virtual audio device) | Bot-free, local (Tauri) |
| Audio kept | **No**, deleted after transcription, no playback | Only during session *[retention unverified]* | Yes, synced playback | Yes (MP4/MP3) | Yes, video | Yes, video + clips | Yes | Yes, local files |
| Transcription | Cloud | Cloud | Cloud | Cloud | Cloud | Cloud | English on-device | On-device or BYO API |
| Note model | **Notes-first**: type rough notes, "Enhance notes" merges with transcript | Hybrid: Notes tab + transcript → summary | Transcript-first | Transcript-first + manual notes | Transcript-first + "Highlight" | Transcript-first | Transcript-first, "Summarize" | Notes-first with an "autonomy" slider |
| Live transcript | Collapsible panel | Transcript tab | Yes | Floating pane | Not primary | Not primary | Yes | Yes |
| Speakers | Me/Them default; named in Zoom etc. | v1.0, best for 1:1 | Yes | Yes | Yes | Yes | Yes | Top HN request |
| Templates | 29 built-in + custom, `/` in note | Auto, Sales, Stand-up, Team | Custom prompts | Custom (paid) | Custom incl. MEDDPICC | Custom | None | Suggested on new-note screen |
| Ask / chat | "Ask anything" bar at note bottom; scope note/folder/all | Notion AI | Otter AI Chat | AskFred | Ask Fathom side panel | AI chat | Krisp AI Chat | Via chosen LLM |
| Organisation | My notes / team space, folders, People & Companies, "Coming up" home | Notion pages | Left nav: chat, apps, channels, folders | Notebook, channels | Recordings; My/Team calls | Library + folders (no sort) | My Meetings (weak filters) | Collapsible sidebar |
| Share / export | Top-right **Share**: Copy notes (Markdown), Copy link; `⋯`: Email, Slack, Notion, HubSpot, Affinity, Attio, Zapier | Notion sharing | `⋯` on transcript: TXT/DOCX/PDF/SRT; link; email | Transcript, summary, MP4, MP3; 200+ integrations | Copy Summary on every call page; link; auto-share | Share/rename/star/download per item | One-click share; copy action items | Markdown |
| Settings | Sidebar: Profile, Calendar, Integrations, Templates, Notifications, Language, plan | Notion Settings → Notifications | Web-style | Web | Page: auto-record scope, share defaults, default template | Web | App settings | Transcription / Intelligence sections |

## 2. Granola in detail (primary benchmark)

**Shell.** Electron on macOS and Windows, plus iOS and an Apple Watch app (July 2026) for one-tap start/stop. No web app, no offline mode.

**Information architecture.**
- Home: a "Coming up" section of calendar events (next 14 days on desktop, paged 5 at a time), then recent notes.
- Sidebar: "My notes" (private) and a team space; folders inside spaces; folders can auto-post to Slack.
- People and Companies icons at the bottom-left of the sidebar; search jumps straight to an entity page on an exact name match.
- "Ask anything" chat bar at the bottom of the screen; scope is a note, a folder, a selection, or everything. Typing `/` in the chat bar opens saved "Recipes".

**Capture.**
- Calendar connected in Settings; a notification fires one minute before any event with two or more attendees. Clicking it opens the meeting link and the Granola note and starts transcribing.
- A live meeting indicator floats on the right edge of the screen; click to return to the note, drag by the bottom handle to move it.
- No device picker: uses the system default input and output.
- Meeting title comes from the calendar event.

**Note editor.**
- Plain document editor; you type rough bullets. The transcript toggle is a small waveform icon left of the "Ask anything" bar; the green audio indicator also opens the transcript.
- `/` in the note picks a template before enhancement.
- "Enhance notes" runs after the call: each of your bullets becomes an anchor and Granola fills in from the transcript. Result shows on an "Enhanced" tab with a dropdown to switch templates and regenerate.
- Speaker labels default to "Me" / "Them" (mic vs. system audio). Complaint: in three-person calls two people collapse into "Them".

**Share.**
- `Share` button top-right of the note: "Copy notes" (Markdown to clipboard) and "Copy link".
- `⋯` menu at the top of the note: Email (mail draft), Slack, Notion (one note at a time), HubSpot, Affinity, Attio, Zapier.
- Transcript is copied via a copy icon inside the transcript panel.
- Third-party teardown title worth remembering: "Great notes, too much friction to share."

**Settings.** A sidebar of sections: Profile, Calendar, Integrations, Templates, Notifications, Language, subscription/team. Whether it is a separate window is *[unverified]*.

**Visual style.** February 2026 rebrand (Ragged Edge): hand-drawn spiral mark, slab-serif display face, humanist UI face, brand green. Reception was mixed; the prior look was praised as "minimalist, distraction-free, gets out of your way".

**Praise:** staying present; clean UI; notes-then-enhance; bot-free; cross-meeting recall.
**Complaints:** no audio playback and nothing to re-transcribe when capture fails silently; unreliable speaker labels; free-tier history cap; price; no offline; cloud processing of transcripts; consent worries in the EU.

## 3. Other products, briefly

- **Notion AI Meeting Notes.** `/meet` block on any page. Desktop app watches for a process using the microphone and offers one-click start (toggle under Settings → Notifications). Notion Calendar shows "Join and transcribe" from 15 minutes before. During the call: Notes tab; after: summary, transcript, notes. Summary format via `⋯`: Auto, Sales, Stand-up, Team Meeting. Complaints: no calendar-triggered auto-record, weak speaker separation in groups.
- **Otter.ai.** Native Mac app (Oct 2025). Auto-detects meetings, auto-record, auto-end, and a draggable floating controller (Pause / Resume / Finish) shown over other apps. Conversation page: Summary (Overview, Action Items, Outline, Custom prompt) and Transcript with synced playback. Export from `⋯` on the transcript: TXT, DOCX, PDF, SRT. Complaints: bot joins by default; sharing settings are "a maze".
- **Fireflies.** Desktop app (Nov 2025) detects calls in Zoom, Meet, WhatsApp, FaceTime, Discord and opens a floating pane. Post-meeting Notepad: summary left, transcript right, each expandable to full screen; icon rail for Smart Search, Index, Soundbites, Comments. Downloads: transcript, summary, MP4, MP3. Complaints: crowded, intrusive AI pop-ups, privacy.
- **Fathom.** In-call panel bottom-right: End / Pause / Highlight. Library: Recordings, My Calls / Team Calls, Ask Fathom panel. "Copy Summary" on every call page. Settings page leads with the auto-record scope dropdown (All / External / Internal / None), attendee auto-share, default template. Praise: cleanest of the bot tools.
- **tl;dv.** Menu bar icon → Start recording. Library with folders, search by keyword/participant/title. Complaints: library "a mess", no sort by date or name, no bulk export.
- **Krisp.** Virtual audio device; records discreetly; My Meetings page; "Summarize" → Key Points + Action Items with editable assignee/due date. Complaints: no templates, no tags, weak filtering.
- **anarlog (Hyprnote).** Tauri v2 + React + Rust, MIT. Notes-first with live transcript beside notes, "autonomy" control for how much AI rewrites, new-note screen with a Record button and suggested templates, collapsible sidebar, Settings → Transcription and Settings → Intelligence showing the active provider and model, Markdown export. HN feedback: love local-first; "inability to identify speakers was a show-stopper"; wanted custom endpoints for internal LLMs.
- **Amie.** Calendar-first; notes attach to the event; menu bar calendar picker. **Superwhisper** (dictation reference): menu bar app, hotkey overlay, per-app modes, local Whisper; the Settings window is effectively the whole app.

## 4. macOS conventions used by the spec

- Settings window under the app menu at `⌘,`; sections as toolbar tabs or a sidebar; disable zoom.
- Sidebar at the leading edge, full height, translucent material, rounded selection, collapsible from the toolbar; search field at the top of the sidebar when it filters content.
- Toolbar in the title bar area with leading (navigation), centre (context), trailing (search, primary action) zones; every toolbar item also exists in the menu bar.
- Standard shortcuts untouched (`⌘N`, `⌘F`, `⌘S`, `⌘W`, `⌘Z`, `⌘,`); `⌘1…⌘9` switch major views (Things, Mail).
- Community macOS token set: 13 px body, 8 px grid, 16–20 px window padding, 6/8/10 px radii, hairline shadows, 150/250 ms easing.
- Design-language references: Things 3 (generous whitespace, `⌘1–6`), Bear (three collapsible columns), Craft (native typography, sidebar → spaces → documents), Linear (Electron but native-feeling: alignment grid, muted palette, single-letter shortcuts, sub-100 ms interactions).

## 5. Table stakes and differentiators

**Table stakes** (absence will be noticed)
1. Bot-free mic + system audio capture on Zoom, Meet, Teams, FaceTime.
2. A floating or docked recording controller with pause/stop.
3. Live transcript panel, toggleable, with at least Me/Them labels.
4. Post-meeting view with Notes / Summary / Transcript, editable output, action items.
5. Templates and (eventually) a chat bar over meetings.
6. Share: Copy as Markdown first, then export to PDF/DOCX/TXT/SRT, then integrations, from a top-right Share button.
7. Search across titles, notes and transcripts; folders.
8. Settings with clear sections, reachable with `⌘,`.
9. Calendar connection with a pre-meeting nudge and event-derived titles (Phase 3 for MeetOdds).

**Differentiators a local-first Mac app can own**
1. Kept audio with playback and re-transcribe (Granola's biggest self-inflicted gap).
2. Capture-health warnings (level meters, "no system audio" alerts) that end silent failures.
3. Visible model provenance and BYO endpoints for corporate LLMs.
4. Named on-device speaker diarisation.
5. Offline, no account, no history cap.
6. Bulk, structured export (Markdown + JSON per meeting) for Obsidian and archives.
7. A genuinely native shell: sidebar + toolbar + settings window + menu bar item + full keyboard coverage.

## 6. Sources

Granola: help.granola.ai/article/granola-101 · help.granola.ai/article/sharing-notes · docs.granola.ai/help-center/sharing/notion · docs.granola.ai/help-center/taking-notes/transcription · docs.granola.ai/help-center/taking-notes/notifications · docs.granola.ai/help-center/taking-notes/customise-notes-with-templates · docs.granola.ai/help-center/getting-more-from-your-notes/chatting-with-your-meetings · docs.granola.ai/help-center/sharing/folders/spaces-and-folders · docs.granola.ai/help-center/people-and-companies · docs.granola.ai/help-center/customising-granola/profile-and-preferences · docs.granola.ai/help-center/taking-notes/speaker-attribution · help.granola.ai/article/feature-requests · granola.ai/blog/a-new-look-for-granola · granola.ai/blog/granola-integrations-hubspot-slack-notion-zapier · meetingnotes.com/blog/granola-ai-teardown · anarlog.so/blog/granola-ai-complaints · techcrunch.com/2026/07/28/granola-launches-an-apple-watch-app · news.ycombinator.com/item?id=43858740

Notion: notion.com/help/ai-meeting-notes · tldv.io/blog/notion-ai-meeting-notes-review · matthiasfrank.de/en/notion-updates/notion-meeting-notes-speaker-attribution

Otter: help.otter.ai/hc/en-us/articles/35973988280215 · help.otter.ai/hc/en-us/articles/5093228433687 · help.otter.ai/hc/en-us/articles/39503855767191

Fireflies: guide.fireflies.ai/articles/6653885315 · guide.fireflies.ai/articles/6666374717 · guide.fireflies.ai/articles/3319752033 · fireflies.ai/blog/fireflies-launches-live-assist-and-desktop-app

Fathom: help.fathom.video/en/articles/449088 · help.fathom.video/en/articles/3239617 · help.fathom.video/en/articles/449856 · zapier.com/blog/fathom-features

tl;dv: intercom.help/tldv/en/articles/5946160 · intercom.help/tldv/en/articles/14433922 · anarlog.so/blog/tldv-review

Krisp: help.krisp.ai/hc/en-us/articles/10291109632412 · help.krisp.ai/hc/en-us/articles/8214720684956

Local-first: github.com/fastrepl/anarlog · anarlog.so/changelog · news.ycombinator.com/item?id=44725306 · github.com/Zackriya-Solutions/meetily · amie.so/documentation/features/ai-notes · superwhisper.com/docs/get-started/introduction

macOS: developer.apple.com/design/human-interface-guidelines/settings · …/sidebars · …/toolbars · …/keyboards · marioaguzman.github.io/design/sidebarguidelines · culturedcode.com/things/support/articles/2785159 · linear.app/now/how-we-redesigned-the-linear-ui
