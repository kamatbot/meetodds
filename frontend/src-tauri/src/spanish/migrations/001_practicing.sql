-- Run once inside the companion branch's migration transaction after its
-- spanish_profiles table exists. provider::migrate_practicing checks PRAGMA
-- table_info before running this so retries do not add the column twice.
ALTER TABLE spanish_profiles ADD COLUMN practicing TEXT NOT NULL DEFAULT '[]';
