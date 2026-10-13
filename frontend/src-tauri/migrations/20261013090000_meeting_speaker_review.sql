-- Meeting-local identities are separate from capture channels and never become
-- cross-meeting voice profiles. Deleting/retranscribing turns removes reviews.
CREATE TABLE meeting_speakers (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    cluster_index INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(meeting_id, cluster_index),
    UNIQUE(id, meeting_id)
);

CREATE UNIQUE INDEX idx_transcripts_identity_meeting ON transcripts(id, meeting_id);

CREATE TABLE transcript_speaker_reviews (
    transcript_id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker_id TEXT,
    capture_channel TEXT,
    source TEXT NOT NULL,
    confidence REAL,
    reviewed INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    FOREIGN KEY(speaker_id, meeting_id) REFERENCES meeting_speakers(id, meeting_id),
    FOREIGN KEY(transcript_id, meeting_id) REFERENCES transcripts(id, meeting_id) ON DELETE CASCADE
);
CREATE INDEX idx_transcript_speaker_reviews_meeting
    ON transcript_speaker_reviews(meeting_id, speaker_id);

CREATE TABLE meeting_speaker_state (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0,
    analyzed_at TEXT,
    analyzed_transcript_fingerprint TEXT,
    attribution_changed_at TEXT,
    summary_input_revision INTEGER
);
