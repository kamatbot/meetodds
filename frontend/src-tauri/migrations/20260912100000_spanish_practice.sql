CREATE TABLE IF NOT EXISTS spanish_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'beginner',
    variety TEXT NOT NULL DEFAULT 'es_MX',
    topics TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spanish_sessions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES spanish_profiles(id) ON DELETE CASCADE,
    situation TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    turns TEXT NOT NULL DEFAULT '[]',
    feedback TEXT NOT NULL DEFAULT '[]',
    level_signal TEXT
);
CREATE INDEX IF NOT EXISTS idx_spanish_sessions_profile ON spanish_sessions(profile_id, started_at DESC);
