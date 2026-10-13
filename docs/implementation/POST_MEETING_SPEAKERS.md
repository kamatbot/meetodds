# Post-meeting speaker review

Base: `kamatbot/meetodds` main at `50fba7d2119ce2e3552f7576aea2fac76deb3ad8`.
Date: 13 October 2026. Source changes only; no GitHub writes or CI.

## Result

Saved meetings have a **Review speakers** entry beside the transcript. Local
analysis suggests recurring voice groups; users can name groups, add participants,
listen to timed evidence, confirm individual assignments, or keep turns Unknown.
Search and a Needs review filter cover all persisted turns; display pages contain
20 turns. Naming a group never confirms every turn in it.

The native API saves changes transactionally and scopes participant/transcript
IDs to the meeting. Analysis checks a transcript/review snapshot before applying
results, preserves manual decisions, and prevents conflicting capture and
re-transcription work. Group identities are reused only for the same analysis
snapshot. Speaker changes refresh evidence and invalidate local recall data;
they never alter an action's owner or commitment status.

Summary input binds the speaker revision before reading transcripts. Native
dispatch rejects a changed revision after input review. Persisted provenance
keeps old, failed, or interrupted summary generations marked for review. All
providers receive instructions to preserve uncertain attribution and require
evidence for ownership or agreement.

## UX changes included

- Saved audio controls are consistently available; clicking a reviewed timestamp
  seeks with context and plays. Opening speaker review does not autoplay.
- Narrow saved-meeting windows have Summary & actions / Transcript controls;
  wider windows retain both panes. Hidden panes stay mounted to preserve drafts.
- Speaker saves refresh the loaded transcript range without unmounting the
  meeting or discarding unsaved summary edits.
- The transcript header puts folder/re-transcription operations under More.
- Transcript content, speaker status, captions, and playback use theme-aware
  colors. Muted text contrast is increased in both themes.
- Action review preserves commitment state instead of turning detected tasks
  into agreed commitments.

The [full UX audit](POST_MEETING_SPEAKERS_UX_REVIEW.md) records 17 findings across
the app. It visually inspected three historical screenshots and reviewed current
source; it is not a rendered review of the current native app. Broader navigation,
decisions placement, live layout, and export restructuring remain recommendations.

## Technical limits

This is an explicitly uncertain acoustic heuristic using existing `realfft`.
There is no added diarization model, trained speaker embedding, cross-meeting
identity recognition, cloud request, or language-asset download. No accuracy or
performance claim has been established. Similar voices, unmarked overlap, codecs,
and changed microphones can defeat the comparison. Microphone-channel turns need
manual assignment. Ambiguous/short/long turns can remain Unknown. See
[speaker detection](../SPEAKER_DETECTION.md) for grouping limits and the native
module for decoding bounds.

Optional speaker analysis decodes at most two hours or 128 million native audio
samples, whichever is reached first. It rejects damaged/timeline-changing audio
and formats needing the FFmpeg fallback (including MKV/WebM/WMA); manual review
remains available. This avoids invoking a fallback that could download a sidecar.
For typical 48 kHz mono saved audio the sample cap is about 44 minutes; stereo
imports reach it sooner. Longer-meeting automatic analysis needs a streaming
decoder before this limit can be raised without increasing memory use.

SQLite is the canonical corrected transcript. Original recording-folder JSON is
not rewritten; use current transcript copy/export to share reviewed labels.
Historical written notes and AI prose remain historical text until explicitly
edited or regenerated.

## Validation to run locally

**Tests and builds were not run. Local Codex should validate the changes before integration.**

1. With pinned Node 24 and installed dependencies, run speaker-label,
   summary-generation-flow, and post-meeting-flow tests, plus changed-file
   lint/type checks. The hook tests use IPC doubles, not native/DOM execution.
2. On a supported Mac, run the documented native compile check and focused
   speaker separation/review, summary provenance, intelligence, and export tests.
   Never package using the compile-only sidecar override.
3. Apply the migration to a database copy. Verify old meetings open, assignments
   and Unknown survive restart, cross-meeting IDs are rejected, and transcript
   re-transcription/deletion and meeting deletion clean up reviews.
4. Evaluate consented three-person recordings: separate remote voices, shared
   microphone, overlap, short acknowledgements, long turns, changed microphones,
   missing audio and timing. Measure false merges/splits and abstention before
   claiming reliability. Synthetic unit tests do not measure speaker accuracy.
5. Analyze → rename → assign → reopen → rerun. Reviewed turns must survive and
   changed snapshots must not inherit the wrong names. Exercise concurrent edits,
   capture/re-transcription, decode errors and oversized files. Failures must keep
   the previous transcript and names intact.
6. Change names during summary input review: dispatch must reject stale input.
   Try successful, failed and cancelled regeneration; only a completed result
   based on the current revision can clear the warning. Existing action owners
   remain editable and marking an action reviewed never implies agreement.
7. Copy/export transcript formats, create linked notes, inspect action evidence
   and recall. Estimated, channel-only and Unknown labels must retain caveats.
8. Follow the UX audit's 11 visual scenarios in light/dark at 1100×700 and larger
   sizes, with keyboard and VoiceOver. Check focus, failures, dirty drafts, >100
   transcript turns, playback and route changes. Finish with record → stop → save
   → reopen and real audio/caption regression checks.

No deployment or release artifact is included.
