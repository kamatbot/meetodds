-- Extend the existing transcript speaker channel field with user-facing
-- attribution metadata. `speaker` remains the stable session-local id.
ALTER TABLE transcripts ADD COLUMN speaker_label TEXT;
ALTER TABLE transcripts ADD COLUMN speaker_source TEXT;
ALTER TABLE transcripts ADD COLUMN speaker_confidence REAL;

CREATE INDEX IF NOT EXISTS idx_transcripts_meeting_speaker
    ON transcripts(meeting_id, speaker);
