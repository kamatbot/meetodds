# Calendar awareness + live notebook

Baseline: `main` at `a675079f47bcc3f4af87bdfad5047f03e70404a7`.
Branch: `feat/calendar-live-notebook`.

No CI, deployment, release packaging, or workflow files were run or changed as part of this implementation.

## Product intent

This work closes two daily-use gaps without changing MeetOdds' recording, transcription, summary, or action-item contracts:

1. MeetOdds should know when a meeting is about to happen so starting the right recording is one click rather than a naming/setup task.
2. During a meeting, the main notes canvas should feel like the primary workspace rather than a text box beside a transcript.

The existing iOS application is unchanged.

## Calendar awareness

### Native privacy boundary

On macOS, MeetOdds reads Apple Calendar through EventKit only after the user presses **Connect**. It requests full event read access because nearby event titles/times/location are required to identify the meeting. Calendar details are queried locally and are not added to AI requests by this feature.

`Info.plist` includes calendar purpose strings. The native query returns only the nearby event fields needed by the UI:

- stable event identifier
- title
- start/end time
- location
- calendar name
- attendee count
- detected conferencing URL

All-day and cancelled events are excluded. Frontend queries are capped to a seven-day native range; the UI currently asks only for the previous 30 minutes through the next 24 hours.

Windows/Linux report the feature as unsupported and hide the Home surface rather than pretending calendar integration exists.

### User experience

Home now has an **Upcoming meeting** surface above the normal action inbox. For a meeting near its start time it shows:

- event title and time
- location/calendar context
- Join when a conferencing URL can be detected
- **Record**, which uses the event title as the MeetOdds recording title
- dismiss for irrelevant events

MeetOdds intentionally does **not** auto-record calendar events. Calendar awareness removes setup friction, not consent. The user must still press Record.

When OS notification permission has already been granted, MeetOdds can post a quiet reminder around two minutes before the meeting starts. The feature does not request notification permission merely because Calendar was connected.

Calendar awareness is controllable under **Settings → General**. Revoked/denied macOS permission links back to the Calendar privacy pane.

## Live notebook

The embedded main-canvas notebook continues to use `meeting_manual_notes`, so the live notebook, post-meeting notes, and optional pop-out editor share the same local document. It retains checked writes, recovery journaling, autosave, and the existing saved-meeting linking behavior.

### New meeting cockpit

The main note surface now provides:

- larger, calmer live-writing typography
- sticky Markdown controls
- local save state and linked-moment count
- calendar context (time, attendees, location, call link) when the recording came from a detected event
- quick manual capture buttons for **Key point**, **Decision**, **Question**, and **Follow-up**
- shortcuts `⌘⇧1` through `⌘⇧4` (Ctrl on non-macOS keyboards)

Quick capture inserts an editable note with the current recording-relative timestamp. These are user-authored annotations only. They do **not** create action-inbox records or bypass the summary-first action workflow.

Clicking **+** beside a live transcript turn now inserts a visible editable note anchor such as:

```md
<!-- [12:43] -->
**12:43 · Speaker** — 
```

The source transcript text is deliberately not copied into the notebook. The transcript remains evidence; the note captures what the user thinks matters. The hidden marker preserves the existing timestamp-link behavior.

## Files

### Native calendar

- `frontend/src-tauri/src/calendar_bridge.m`
- `frontend/src-tauri/src/calendar.rs`
- `frontend/src-tauri/build.rs`
- `frontend/src-tauri/Info.plist`
- `frontend/src-tauri/src/lib.rs`

### Desktop calendar UX

- `frontend/src/services/calendarService.ts`
- `frontend/src/lib/calendar-awareness.ts`
- `frontend/src/contexts/CalendarAwarenessContext.tsx`
- `frontend/src/components/Home/CalendarAgendaCard.tsx`
- `frontend/src/components/Home/HomeDashboard.tsx`
- `frontend/src/components/Settings/GeneralSettings.tsx`
- `frontend/src/hooks/useRecordingStart.ts`
- `frontend/src/app/layout.tsx`
- `frontend/src/app/page.tsx`

### Live notebook

- `frontend/src/components/Meeting/LiveMeetingNotes.tsx`
- `frontend/src/components/Notes/MarkdownNoteEditor.tsx`
- `frontend/src/components/Notes/NotedTranscriptView.tsx`

### Tests

- `frontend/tests/lib/calendar-awareness.test.cjs`

## Codex/native acceptance checklist

1. Build the macOS app with the existing supported toolchain. Confirm the Objective-C EventKit bridge compiles and links into the Tauri binary and no unsupported availability warning is promoted to an error.
2. Fresh install: Calendar is not prompted on launch. Press Connect on Home, approve full event access, and verify nearby Calendar events appear without restarting.
3. Deny calendar permission. Confirm MeetOdds remains fully functional and Settings links to the correct Calendar privacy pane. Re-enable access and verify refresh recovers.
4. Create test events for Zoom, Google Meet, Teams and an event without a call URL. Check title/time/location rendering and Join detection. Ensure arbitrary event notes are not shown in the UI.
5. With a meeting starting within 15 minutes, press Record. Verify the capture-preflight flow remains intact and the recording title is the calendar event title. MeetOdds must never begin recording just because the event starts.
6. Leave MeetOdds in the background with notification permission already enabled. Confirm one reminder per event around the start boundary, without repeated notifications on each minute poll.
7. Start a generic meeting. Confirm calendar context is absent and the previous timestamp-generated title behavior remains unchanged.
8. During a meeting, type continuously for several minutes while transcript updates arrive. Confirm typing remains responsive, autosave status reaches Saved, and the transcript never steals focus.
9. Exercise Key point / Decision / Question / Follow-up buttons and keyboard shortcuts. Confirm each inserts a timestamped editable annotation but creates no action-inbox item during the live meeting.
10. Click + on several transcript turns. Each new turn should add a visible timestamp/speaker anchor and focus the notebook; repeated clicks on the same timestamp must not duplicate the anchor.
11. Stop the meeting and reopen it. Confirm manual notes and timestamp links are preserved and are available to the existing post-meeting summary input policy exactly as before.
12. If the optional pop-out notes window is used, verify checked writes prevent one surface from silently overwriting newer content from the other.
13. Validate a UI reload during an active recording and multi-calendar accounts. Recording/transcription must remain independent of Calendar availability.

## Validation boundary

The implementation was source-reviewed against current `main` and includes deterministic JavaScript tests for the pure calendar suggestion/notification policy. No CI run, full Next/Tauri build, EventKit runtime test, or native macOS acceptance run is claimed here. Codex should execute those checks before merge.
