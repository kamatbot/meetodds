-- MeetOdds Library contract: additive metadata and deferred-delete support.
-- Existing meeting rows intentionally keep duration/title_source/notes as NULL.
ALTER TABLE meetings ADD COLUMN duration_ms INTEGER;
ALTER TABLE meetings ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meetings ADD COLUMN title_source TEXT;
ALTER TABLE meetings ADD COLUMN notes_markdown TEXT;
ALTER TABLE meetings ADD COLUMN deleted_at TEXT;

-- Preserve notes created by the existing meeting_notes implementation when present.
UPDATE meetings
SET notes_markdown = (
    SELECT meeting_notes.notes_markdown
    FROM meeting_notes
    WHERE meeting_notes.meeting_id = meetings.id
)
WHERE notes_markdown IS NULL
  AND EXISTS (
    SELECT 1 FROM meeting_notes WHERE meeting_notes.meeting_id = meetings.id
  );

CREATE INDEX IF NOT EXISTS idx_meetings_library_newest
    ON meetings(deleted_at, created_at DESC, id ASC);
CREATE INDEX IF NOT EXISTS idx_meetings_library_starred
    ON meetings(deleted_at, starred, created_at DESC, id ASC);
CREATE INDEX IF NOT EXISTS idx_meetings_library_title
    ON meetings(deleted_at, title COLLATE NOCASE, id ASC);
