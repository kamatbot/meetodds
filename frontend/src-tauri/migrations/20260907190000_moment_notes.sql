-- Additive: do not rewrite existing meetings, audio paths, or either legacy notes table.
-- A live note initially belongs to the recording's draft ID. The existing
-- meeting_manual_note_links table resolves that ID after the meeting is saved.
CREATE TABLE meeting_moment_notes (
    id TEXT PRIMARY KEY NOT NULL,
    meeting_id TEXT NOT NULL,
    anchor_key TEXT NOT NULL,
    segment_id TEXT,
    audio_start_time REAL CHECK (audio_start_time IS NULL OR audio_start_time >= 0),
    audio_end_time REAL CHECK (audio_end_time IS NULL OR audio_end_time >= audio_start_time),
    source_text TEXT NOT NULL DEFAULT '',
    source_speaker TEXT,
    markdown TEXT NOT NULL DEFAULT '',
    include_in_summary INTEGER NOT NULL DEFAULT 1 CHECK (include_in_summary IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (meeting_id, anchor_key)
);
CREATE INDEX idx_moment_notes_meeting_time
    ON meeting_moment_notes(meeting_id, audio_start_time, created_at);
CREATE INDEX IF NOT EXISTS idx_transcripts_moment_lookup
    ON transcripts(meeting_id, audio_start_time);

-- No foreign key to meetings: the canonical meeting row does not exist during capture.
-- Delete only new app-owned note rows, including the linked draft when it is not
-- shared by another saved meeting. Deferred deletion remains undoable until commit.
CREATE TRIGGER delete_meeting_moment_notes BEFORE DELETE ON meetings BEGIN
    DELETE FROM meeting_moment_notes WHERE meeting_id = OLD.id;
    DELETE FROM meeting_moment_notes
    WHERE meeting_id IN (
        SELECT draft_meeting_id FROM meeting_manual_note_links WHERE meeting_id = OLD.id
    ) AND NOT EXISTS (
        SELECT 1 FROM meeting_manual_note_links other
        JOIN meetings m ON m.id = other.meeting_id
        WHERE other.draft_meeting_id = meeting_moment_notes.meeting_id AND m.id <> OLD.id
    );
END;
