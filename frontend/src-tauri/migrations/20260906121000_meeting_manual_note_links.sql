CREATE TABLE IF NOT EXISTS meeting_manual_note_links (
    meeting_id TEXT PRIMARY KEY,
    draft_meeting_id TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
