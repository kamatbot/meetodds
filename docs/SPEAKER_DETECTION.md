# Speaker attribution

Apple Speech retains microphone and system-audio provenance during live capture.
The system channel includes **all remote participants**. Neither channel identifies
a named person; a shared microphone can also contain several people. Saved audio
remains mixed. Speaker analysis does not upload audio or download models.

## Post-meeting review

Open a saved meeting, choose **Transcript → Review speakers**, then **Analyze
recording**. The local pass compares recurring acoustic patterns in timed turns
and suggests meeting-local groups such as Speaker 1. It is an experimental
heuristic, not a trained diarization or identity-recognition model. Its accuracy
has not been measured on representative meetings.

Every automatic group remains **Estimated**, including after a group is renamed.
Listen to a turn, select or add a participant, and confirm its assignment. Use
**Unknown** when a turn cannot be attributed. Names and assignments save in
SQLite; review covers the full saved transcript independently of display
pagination. Original audio, transcript text, and timing are preserved.

The acoustic pass uses spectral-envelope and pitch descriptors with repeated-turn
support. It excludes microphone-channel turns, visible overlaps, invalid or
out-of-range timestamps, turns shorter than 1.2 seconds or longer than 18 seconds,
silence, insufficient voiced evidence, and inconsistent or ambiguous matches.
Analysis compares at most 2,000 turns and suggests at most six groups. All other
turns remain available for manual review. Overlap within one ASR turn, similar
voices, and microphone changes can still cause mistakes. Mixed or long turns
cannot be split automatically; keep them Unknown when necessary.

Microphone-only meetings currently require manual speaker assignment. Imports
with timed turns and retained audio can receive tentative groups, but original
capture-channel identity cannot be recovered from a mixed file.

## Names, summaries, and commitments

- Naming a group changes its display label, not its attribution certainty.
- A manual assignment is meeting-local; it does not create a reusable voiceprint.
- Reanalysis preserves reviewed turns. Changed transcript/audio snapshots use new
  group identities so an old name cannot silently transfer to a different voice.
- Copy, export, linked evidence, and summary input carry uncertainty with names.
- Speaker changes mark existing summary content for review. A fresh generation
  binds the revision captured before input review; a change during preparation
  requires a new request.
- Existing action owners are never rewritten by a speaker edit. Review ownership
  and commitment explicitly. Marking an action reviewed does not mark it agreed.

Raw transcript metadata uses `speaker`, `speaker_label`, `speaker_source`, and
`speaker_confidence`. Meeting-local profiles, review state, capture provenance,
and revisions live in `meeting_speakers`, `transcript_speaker_reviews`, and
`meeting_speaker_state`. Acoustic scores are not calibrated probabilities and
are not presented as percentages.

See [implementation and local acceptance](implementation/POST_MEETING_SPEAKERS.md)
and the [UX review](implementation/POST_MEETING_SPEAKERS_UX_REVIEW.md). Tests and
builds were not run. Native and real-recording validation remain required before
integration or any accuracy claim.
