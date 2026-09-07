-- MeetOdds verifiable meetings + work + local recall.
-- Entire migration is additive. Existing meetings, transcripts, summaries and audio paths are untouched.

CREATE TABLE IF NOT EXISTS meeting_contexts (
    meeting_id TEXT PRIMARY KEY,
    project TEXT,
    client TEXT,
    participants_json TEXT NOT NULL DEFAULT '[]',
    agenda TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meeting_contexts_project
    ON meeting_contexts(project COLLATE NOCASE, meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_contexts_client
    ON meeting_contexts(client COLLATE NOCASE, meeting_id);

CREATE TABLE IF NOT EXISTS meeting_facts (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'detected',
    confidence REAL NOT NULL DEFAULT 0.0,
    confirmed INTEGER NOT NULL DEFAULT 0,
    stable_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_facts_stable
    ON meeting_facts(meeting_id, stable_key);
CREATE INDEX IF NOT EXISTS idx_meeting_facts_kind
    ON meeting_facts(meeting_id, kind, confirmed);

CREATE TABLE IF NOT EXISTS meeting_actions (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    text TEXT NOT NULL,
    owner TEXT,
    due_at TEXT,
    due_text TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    commitment_state TEXT NOT NULL DEFAULT 'detected',
    confirmed INTEGER NOT NULL DEFAULT 0,
    stable_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_actions_stable
    ON meeting_actions(meeting_id, stable_key);
CREATE INDEX IF NOT EXISTS idx_meeting_actions_inbox
    ON meeting_actions(status, confirmed, due_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS meeting_evidence (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    fact_id TEXT,
    action_id TEXT,
    transcript_id TEXT,
    transcript_revision INTEGER NOT NULL DEFAULT 1,
    source_kind TEXT NOT NULL DEFAULT 'transcript',
    quote TEXT NOT NULL,
    audio_start_time REAL,
    audio_end_time REAL,
    speaker_label TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (fact_id) REFERENCES meeting_facts(id) ON DELETE CASCADE,
    FOREIGN KEY (action_id) REFERENCES meeting_actions(id) ON DELETE CASCADE,
    FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE SET NULL,
    CHECK (fact_id IS NOT NULL OR action_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_meeting_evidence_fact ON meeting_evidence(fact_id);
CREATE INDEX IF NOT EXISTS idx_meeting_evidence_action ON meeting_evidence(action_id);
CREATE INDEX IF NOT EXISTS idx_meeting_evidence_transcript ON meeting_evidence(transcript_id);

CREATE TABLE IF NOT EXISTS meeting_memory_documents (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content TEXT NOT NULL,
    vector_json TEXT NOT NULL,
    project TEXT,
    client TEXT,
    transcript_id TEXT,
    audio_start_time REAL,
    audio_end_time REAL,
    speaker_label TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_memory_source
    ON meeting_memory_documents(meeting_id, kind, source_id);
CREATE INDEX IF NOT EXISTS idx_meeting_memory_project
    ON meeting_memory_documents(project COLLATE NOCASE, meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_memory_client
    ON meeting_memory_documents(client COLLATE NOCASE, meeting_id);

CREATE TABLE IF NOT EXISTS meeting_memory_state (
    meeting_id TEXT PRIMARY KEY,
    source_hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
