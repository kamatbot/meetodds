# Post-meeting speakers: UX and visual review

Date: 13 October 2026. Scope: supported desktop Next.js/Tauri application.

The most useful simplification is one review loop: read an action, hear its source, correct the speaker when necessary, and explicitly decide whether a commitment was made. Speaker names, audio source, review status, and commitment status must remain separate facts.

## Evidence and limits

This audit inspected the current route/component/CSS source and visually inspected [home.png](../home.png), [transcription.png](../transcription.png), and [summary.png](../summary.png). All three screenshots visibly show the older **meetily** interface. They establish historical visual problems, but do not demonstrate the appearance of the current Horizon interface. No current desktop screenshots were found in the repository.

The September [redesign spec](../design/UX_REDESIGN_SPEC.md), [Horizon implementation notes](HORIZON_UX_SPEC_2026-09-11.md), and [summary-first notes](SUMMARY_FIRST_POST_MEETING_2026-09-11.md) were read as design history. Current source differs materially: saved meetings use a persistent transcript/summary split; the sidebar exposes a single Meetings destination and hides Actions under More tools. Recommendations below use the current source rather than assuming the older specifications are implemented.

No app, browser render, build, install, test, lint, CI, or native recording was run for this audit. Contrast figures are arithmetic calculations from source color values, not screenshots or a full accessibility conformance test. Findings describe the baseline before the accompanying speaker work; the implementation section at the end should identify which recommendations the change actually addresses.

## Current screen map

| Surface | Current behavior and useful strengths | Simplification opportunity |
| --- | --- | --- |
| App shell and sidebar | Search/command palette, recent meetings, one recording CTA, recording return link, Settings. Recent-item menus become visible on keyboard focus. | Home and library both present meetings; the sidebar's active Meetings item represents both. Distinguish quick access from the complete searchable library without adding another permanent navigation tier. |
| Home | Meeting list, New meeting, Import audio, recoverable-meeting and microphone failure states. Calendar/actions mount only when expanded. | Preserve the quiet first screen. If unreviewed commitments exist, a compact count/link can expose them without expanding two unrelated tools. |
| Meeting library | Date groups, virtualization, search/sort, inline rename, star, selection and undoable deletion. | Make compact-width rows retain title and status before secondary time columns. Do not force a 100px status column plus a 96px time column at every size. |
| Live meeting | Transcript and notes, separate recording dock, translation/caption controls, preserved original speech, keyboard-resizable transcript drawer in drawer presentation. | Keep speaker analysis after recording. Avoid another live status/control row. At narrow sizes the live layout still keeps two columns; offer a focused transcript/notes view later. |
| Saved meeting | Editable title, Share/More, transcript on left, summary/actions on right; notes open above summary. | Make playback consistently available wherever transcript evidence is visible. Keep the speaker editor temporary. Provide a focused narrow layout. |
| Summary | One Generate summary CTA, progress/cancel/error states, readable summary, structured action checklist, editing/autosave, advanced settings under More. | “More” currently holds unrelated export, model settings, context, automation and decisions. Prefer descriptive groups and avoid hiding important decisions behind two disclosures. |
| Action inbox | Separates review-needed/open/recently-completed data and links to source moments. | Reviewing a task must not establish agreement. Distinguish “Reviewed” from “Agreed”; expose uncertain owner/commitment next to the action. |
| Notes | Personal notes and transcript-linked notes are separately persisted; linked notes navigate to moments. | Explain each at its point of use with plain labels. The saved layout gives notes only 38% of one pane, capped at 320px; a focused notes view helps substantial writing. |
| Settings/onboarding | Searchable settings sections; keyboard navigation; short setup flow; permission and language choices. | Use settings links for global defaults; keep per-meeting speaker correction inside the meeting. Do not introduce a diarization configuration wizard. |
| Share/export | Explicit section selection, saved-content preview, export progress/errors, personal content opt-in. | Preserve these safeguards. Carry speaker uncertainty into exported transcript content and clearly distinguish saved summary prose from subsequently reviewed action ownership. |
| Floating captions | Separate dark window with focus outlines, reset controls and reduced-motion styling. | Preserve this dedicated reading surface. Post-meeting estimates should not change the meaning of live source labels. |

Sources: [HomeDashboard](../../frontend/src/components/Home/HomeDashboard.tsx), [Sidebar](../../frontend/src/components/Sidebar/index.tsx), [MeetingLibrary](../../frontend/src/components/Meetings/MeetingLibrary.tsx), [MeetingRow](../../frontend/src/components/Meetings/MeetingRow.tsx), [saved PageContent](../../frontend/src/app/meeting-details/page-content.tsx), [SummaryPanel](../../frontend/src/components/MeetingDetails/SummaryPanel.tsx), [SettingsShell](../../frontend/src/components/Settings/SettingsShell.tsx), [ExportSheet](../../frontend/src/components/Meeting/ExportSheet.tsx), [captions CSS](../../frontend/src/components/Captions/captions.css).

## Prioritized findings

### P0: trust, legibility, and completing speaker review

1. **Generic action confirmation currently establishes agreement.** The baseline [ActionInboxPanel](../../frontend/src/components/Actions/ActionInboxPanel.tsx) Confirm handler changes `detected` to `agreed`. Reviewing a useful task is not evidence that a named person committed. Preserve `commitmentState` when confirming the review; reserve agreement changes for an explicit commitment edit. Keep completion separate as well. This is directly relevant to “who committed to what.”

2. **Playback is hidden on the default saved-meeting view even though its transcript is visible.** [Meeting page](../../frontend/src/app/meeting/page.tsx) mounts AudioPlayer only for `activeTab === 'transcript'`, while [PageContent](../../frontend/src/app/meeting-details/page-content.tsx) always renders both panes. A source link changes the URL and reveals the player, but normal opening does not. Mount a consistent player wherever evidence review occurs; speaker sample/source actions should seek to their turn with surrounding context. Retain the existing missing-audio and metadata-error states. Never start playback merely because a review panel opened.

3. **The saved transcript can be almost unreadable in dark mode.** Baseline [VirtualizedTranscriptView](../../frontend/src/components/VirtualizedTranscriptView.tsx) uses `text-gray-800` for original finalized speech and `text-gray-900` for translated text. The live CSS overrides original paragraph color in some live presentations, but saved TranscriptPanel is outside that wrapper. `#1f2937` on dark background `#0e0d0c` is approximately **1.32:1**. Use the shared primary text token for transcript content and secondary text token for time/uncertainty. Speaker review must be readable in both themes.

4. **Readable words do not establish speaker identity.** [Speaker presentation](../../frontend/src/lib/speaker-labels.ts) and [VirtualizedTranscriptView](../../frontend/src/components/VirtualizedTranscriptView.tsx) already distinguish speech confidence from a speaker source, but the latter is exposed mainly through the timestamp tooltip. A microphone channel is not proof that only the device owner spoke; remote audio can include several people. Keep the audio source available, label acoustic groups as estimates, and explicitly retain unknown/overlapping speech. Do not turn a name entered for a group into blanket confirmation of every turn in it.

### P1: simplify the everyday review path

5. **The post-meeting layout has no narrow-width fallback.** The baseline saved page uses `grid-cols-2` at every size. The configured window starts at 1100×700; after the sidebar each content pane is already compact. Transcript controls, new speaker controls, action forms, and summary tables will compete for that space. Keep the desktop split when there is sufficient content width; below that, use a labeled Summary/Transcript switch with notes available on demand. Source navigation should open the transcript and keep the cited turn in view. Preserve mounted draft state or flush/save before switching.

6. **Secondary text is too low contrast for its size.** [globals.css](../../frontend/src/app/globals.css) defines light `--text-3: #8f8880` and dark `--text-3: #777068`; these appear frequently at 9.5–12px in dates, action ownership, status and explanatory text. Calculated baseline ratios:

   | Text/background | Ratio |
   | --- | --- |
   | `#8f8880` / light page `#f6f5f2` | 3.21:1 |
   | `#8f8880` / white panel | 3.50:1 |
   | `#777068` / dark page `#0e0d0c` | 3.98:1 |
   | `#777068` / dark panel `#181614` | 3.70:1 |
   | `#777068` / dark secondary panel `#1f1d1a` | 3.44:1 |

   These normal-size text cases fall below the usual 4.5:1 threshold. Use `text-2` for information required to interpret a transcript/action and adjust the shared muted token for remaining captions. Keep body text 14–16px, control labels at least 12px, and important uncertainty at least as readable as dates. A second accent or extra badge cannot compensate for illegible text.

7. **Speaker color is disconnected from the rest of the visual system.** [speaker-labels.ts](../../frontend/src/lib/speaker-labels.ts) uses blue/purple/green/etc. light Tailwind palettes for speaker badges. Use theme-aware token pairs, restrained borders, and visible text labels. Avoid distinguishing people by color alone. Reserve amber attention treatment for unresolved attribution; use a quieter reviewed indication. Do not imply quality with a decorative percentage when the score is uncalibrated.

8. **Repeated operational controls consume space that evidence needs.** Copy and recording-folder actions exist in the transcript header, Share menu, meeting More menu and summary More controls. Keep Share as the cross-meeting export/copy destination. A transcript-local Copy shortcut may remain useful, but the normal transcript header should prioritize its title, speaker review state, and one review entry point. Move infrequent re-transcription/folder operations into a compact menu. Label re-transcription literally instead of “Enhance,” which can be confused with speaker analysis.

9. **Actions are concise but source context remains indirect.** [FinishedMeetingActions](../../frontend/src/components/MeetingDetails/FinishedMeetingActions.tsx) offers owner/date/commitment editing and a timestamped source link; that is a good base. Its owner is a free-text input, so naming a speaker elsewhere does not itself establish ownership. Offer existing speaker names as suggestions while retaining free text and unknown. Display “Owner needs review” when attribution is unresolved. A speaker speaking about another person's task must not become the owner automatically.

10. **Three review interfaces use different language and behavior.** The saved checklist, [MeetingOutcomeWorkspace](../../frontend/src/components/Meeting/MeetingOutcomeWorkspace.tsx), and inbox expose variants of Confirm, Reviewed, Needs review, Proposed, and Agreed. Standardize the user-facing meanings: review is the user's editorial approval; commitment records what the conversation establishes; done records subsequent progress. A source match is navigation, not proof. Prefer “Mark reviewed,” “Proposed,” “Agreed,” and “Commitment unclear” where those meanings apply.

11. **Important content is buried inside a generic disclosure.** SummaryPanel places decisions, open questions and meeting context within More, then another disclosure. The primary recap/action loop is easier if decisions appear directly beneath action items in a concise collapsed section with a count. Keep model/provider, regeneration, context and automation in a specifically named settings disclosure. Show the selected provider/destination near Generate when needed for a meaningful decision, not implementation explanations in the reading view.

12. **The action inbox is hard to discover for a product centered on commitments.** Sidebar hides it under More tools; Home puts it in a closed “Calendar and action inbox” disclosure. When actions require review, show one meaningful count/link on Home or beside Meetings. Avoid a permanent empty dashboard card. Keep calendar status separate from action review because they answer different user questions.

### P2: consistency and finishing quality

13. **Some interactions have undersized targets or missing state labels.** ActionInboxPanel uses an 18px completion button, a generic “Complete action” label even for completed items, and an icon-only refresh without an accessible label. FinishedMeetingActions uses a 16px checkbox without an enclosing clickable label. Keep the visual check compact but enlarge its clickable area and announce the task and current state. Aim for at least 24px targets, with 32–36px comfortable targets in dense desktop controls. Inspect focus order in the actual app before claiming keyboard acceptance.

14. **Accent foreground is inconsistently applied.** The theme defines `--on-accent`, including a dark foreground for bright dark-mode orange. AudioPlayer and ExportSheet still use `bg-accent text-white`. White on dark-mode `#ff7a1a` is about **2.61:1**. Use the shared accent foreground token for labels and icons, and inspect control boundaries separately.

15. **Readability width is determined by panes rather than content.** The meeting header allows 1440px, summary permits 900px inside half a window, and the live transcript overrides row max widths. Set a readable line length for long prose and allow evidence/context beside it when space permits. Avoid compensating for cramped panes by shrinking text. Long speaker names should wrap or truncate with an accessible full name, without pushing review controls offscreen.

16. **“Saved” and “reviewed” exports need clear expectations.** The saved summary reading projection hides original generated actions when structured actions exist, while SummaryPanel explicitly notes that copy/export keep the original summary. Once users correct speaker names and action owners, exporting older AI prose can appear to undo their work. Treat reviewed actions as a separately identifiable export section or clearly label the scope before export. Do not silently rewrite the historical summary, and do not export an estimated speaker as a confirmed identity.

17. **Historical screenshots should be replaced after native acceptance.** The old screenshots show the split layout's clipped action table, narrow transcript column, multiple toolbars, independent scrollbars, tiny timestamps and icon navigation. Those observations support the simplification direction, but the images use old branding, colors, controls and content layout. Capture current light/dark and narrow/wide states after the code is running; keep mockups explicitly labeled as concepts.

## Recommended speaker review design

### Entry and hierarchy

- Keep the transcript header compact: **Transcript** on the left; **Review speakers** and a plain unresolved count on the right. Before analysis, the action can say **Separate speakers**. If a native control uses the latter label, its nearby description must state that the resulting groups are estimates.
- Open an inline collapsible panel or accessible sheet, not a permanent third column. Show one short explanation: “Group similar voices on this Mac, then review names and uncertain turns.” Explain that the original recording/transcript text is preserved where it helps the user decide.
- Present a meaningful initial state: no analysis yet, processing, estimated groups, partially reviewed, review complete, unavailable, or failed with retry. Completion means the processing finished; it does not mean the attribution is accurate.
- Include the count of unresolved turns and a way to jump to the next one. Restrict any “review complete” claim to the actual reviewed scope, including unloaded transcript pages.

### Name and turn correction

- A group row contains a stable label such as Speaker 1, an editable display name, and a playable sample. Prefer a representative timestamp/quote over an unexplained confidence percentage.
- Separate **rename this group** from **assign this turn**. A group name is a convenient label; a user-verified turn is stronger evidence. Make the distinction apparent in the row's status.
- Let a turn move to an existing speaker, a new speaker, or **Unknown**. Multiple people can use the microphone and one source segment may contain overlapping or mixed speech. Do not force every turn into a named person.
- Keep correction next to the speaker label; use one keyboard-accessible menu or combobox. Include the current turn/time in its accessible name. Avoid making every transcript row a large permanent form.
- Preserve manual corrections across reruns, or describe exactly which edits a reset affects before resetting. A failed save keeps the entered name/selection visible with retry. Announce a concise status after successful save.
- Do not make listening, naming every speaker, or running separation a prerequisite to reading the meeting or generating a summary.

### Uncertainty and commitment

| User-facing state | Meaning | Suggested presentation |
| --- | --- | --- |
| Microphone / Remote audio | Captured input source; may contain multiple people | Secondary source detail |
| Speaker 1 · Estimated | Automatic voice grouping; identity not established | Name plus visible “Estimated” text |
| Alex · Estimated turn | Group has a human-friendly name; this turn is still estimated | Name plus uncertainty, not a verified check |
| Alex · Assigned by you | User assigned this individual turn | Quiet review indication with reversible edit |
| Unknown speaker | No reliable assignment, insufficient audio, or ambiguous speech | Explicit neutral label; never blank |
| Commitment unclear / Proposed / Agreed | What the conversation establishes about the action | Separate from speaker review and completion |

Names supplied by the user are meeting-local labels. Speaker grouping alone must not claim real-world identity, calibrated confidence, or proof of agreement. An unknown owner is a valid result.

### Reading order

For a typical three-person meeting: open the saved recap → inspect an action's owner/commitment → open its related moment → listen → correct the turn if needed → edit the action's owner/commitment explicitly → return to the recap. Each step should leave the meeting and draft state intact. A context match or named group should never automatically make a proposed task “Agreed.”

## Visual acceptance on a Mac — not executed

Use synthetic or consented nonprivate content. Check the default 1100×700 window, 1280×820, the smallest supported size, and a zoomed/text-enlarged view. Repeat essential checks in system/light/dark themes.

1. **Three participants:** one microphone speaker, two remote speakers. Inspect long names, renamed groups, unknown turns, and an intentionally wrong estimate. Names and uncertainty must remain legible without color.
2. **Shared microphone:** two people use the microphone. Confirm the UI does not identify both as the device owner solely from channel provenance.
3. **Evidence loop:** open an action's source, seek/listen, edit the speaker, return to summary, then explicitly edit owner and commitment. Compare saved state after reopening. Opening review must not autoplay.
4. **Ambiguous audio:** overlapping voices, short acknowledgments, background media, silence, weak audio, and a turn containing two people. Unknown/estimated states must remain available; inspect the actual audio grouping accuracy separately from UI correctness.
5. **No audio / old meeting:** no retained recording, moved audio, missing timings or incomplete metadata. Existing transcript and summary remain readable; unavailable analysis has a specific reason and recovery path where possible.
6. **Long transcript:** more than one loaded page. Review counts, renamed groups, corrections and source navigation must reflect the whole persisted meeting. Filtering or resizing must not lose the focused turn.
7. **Pending/failure:** start analysis, navigate away/back, retry a failure, fail a name save, rerun after a manual correction. Watch for duplicate jobs, stale labels, lost input, silent overwrites and misleading “complete” indicators.
8. **Summary/export:** generate using estimated labels, rename/assign later, then copy/export. Inspect whether uncertainty survives and whether existing prose clearly differs from corrected action ownership. Confirm personal notes/audio inclusion remains explicit.
9. **Keyboard/VoiceOver:** reach the review entry, names, speaker assignments, sample controls and source links; open/close with keyboard, preserve focus on closing, announce save/failure/status, and retain a logical order when the layout changes. Verify checkbox states and descriptive names.
10. **Visual density:** no clipped controls, horizontal prose scrolling, stacked competing primary CTAs, or 9px ownership text. Keep name/source/commitment visually distinct. Confirm dark transcript text, speaker badges, accent buttons, focus rings and disabled states.
11. **Existing capture regression:** record → stop/save → reopen, notes save, source transcription, pause/resume, captions, transcript updates, audio playback and provider consent continue to behave as before. The speaker feature must remain outside the active recording path.

Suggested usability measures: time from opening an action to hearing its source; time to name three groups; clicks to correct one turn and its action owner; fraction of unresolved turns visibly discoverable; accuracy of answers to “was this person identified?” and “did this person agree?” Measure recognition/grouping quality separately on representative consented recordings; no accuracy claim is established by this audit.

## Implementation tracking

The accompanying source change addresses findings 1–8 and the playback portion of 14: commitment-preserving review, consistent playback, transcript contrast, explicit attribution states, a focused narrow layout, stronger muted text colors, theme-aware speaker badges, and compact transcript controls. It adds the speaker review flow described above and revision-aware stale-summary warnings. This is source implementation, not runtime or visual acceptance.

Broader navigation, decisions placement, action-editor consistency, export restructuring, and live-layout recommendations remain follow-up work. See [implementation and local checks](POST_MEETING_SPEAKERS.md) for the exact scope and limits.
