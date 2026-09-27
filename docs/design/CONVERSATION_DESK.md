# Conversation desk

Approved direction: **Conversation desk**, September 27, 2026. This replaces the
main Mac meeting experience, not the recording/storage engine. Product mode:
Operate while recording, Read after the meeting.

## The experience

1. **Set up once.** Choose Local AI or connect ChatGPT, then grant audio
   permissions. Model preparation is inline, not another wizard. Transcription
   stays local. The ChatGPT connection explicitly explains automatic processing
   of the transcript and meeting notes; audio is not sent.
2. **Stay with the conversation.** Finalized transcript on the left, optional
   autosaving notes on the right. Pause and Stop are outside the scrolling
   content. Captions remain optional and use the existing native preference;
   hiding them must stop speculative decoding, not just hide pixels.
3. **Read what happened.** The saved transcript stays visible on the left. The
   right side generates the summary automatically with a real status and an
   indeterminate progress bar where there is no meaningful percentage. Display
   the actual summary openly, with actions only when present. A failed summary
   never blocks access to the recording, transcript, or notes.

## Hierarchy and appearance

- System Mac typography, opaque neutral surfaces, restrained accent, readable
  speaker/timestamp paragraphs. Avoid a nested card hierarchy and promotional
  headings in work screens.
- The meeting is the primary canvas. Meeting history is available from the
  toolbar; the sidebar is initially collapsed and can be reopened/resized.
- Primary navigation is Meetings. Settings, import/export, Open meeting folder,
  and existing additional tools remain reachable without filling the main view.
- Both content columns must own their scrolling. Reading earlier speech must
  not be interrupted by forced follow-scroll. Source links reveal their real
  transcript evidence without hiding the summary.
- Respect appearance, keyboard focus and reduced motion. Long titles and
  transcripts wrap/scroll; they never push recording controls out of reach.

## Privacy and lifecycle invariants

- Saved summary approval is bound to the exact provider, model and destination.
  Existing cloud connections are not themselves permission for a new automatic
  processing policy. Changed settings require fresh approval.
- Once approved, automatic generation and manual retries do not repeat the
  input-review dialog. Unapproved background work reports an inline error rather
  than opening a modal. Private personal-note excerpts are never auto-included.
- Read the persisted model and full saved transcript, flush pending notes, and
  recheck consent before native dispatch. The native destination check remains.
- Claim an automatic attempt only at dispatch, after preparation and approval,
  so interrupted preparation does not permanently consume the meeting's job.
- Existing running jobs are observed, not resubmitted. Navigating away after
  dispatch does not cancel the native job. Failures require an explicit retry;
  no paid fallback or silent provider switch.
- Manual notes remain observations, not canonical speech or proof of an action,
  speaker, owner, date, or agreement. Never manufacture tasks to fill the view.
- No data migration/deletion is required by this layout. Existing meeting IDs,
  recordings, transcripts, summary edits, and action completion states survive.

## Acceptance scope

Focused helper/hook and component/source checks cover affected behavior. No
app packaging or full CI is part of this implementation request. Actual Mac
visual acceptance and microphone/system capture checks must be recorded
separately; source/type checks are not native runtime evidence.

The visual reference uses synthetic meeting content and is not product data.
