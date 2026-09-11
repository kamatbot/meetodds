-- Actions now come only from a successfully saved AI summary.
-- Preserve reviewed, completed and dismissed work. Archive old unreviewed
-- candidates before removing them from the live inbox; never touch source data.
CREATE TABLE IF NOT EXISTS meeting_outcome_state (
    meeting_id TEXT PRIMARY KEY NOT NULL,
    source_hash TEXT NOT NULL,
    projected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS meeting_legacy_action_candidates AS
    SELECT * FROM meeting_actions WHERE confirmed = 0 AND status = 'open';
CREATE TABLE IF NOT EXISTS meeting_legacy_fact_candidates AS
    SELECT * FROM meeting_facts WHERE confirmed = 0 AND state <> 'dismissed';
CREATE TABLE IF NOT EXISTS meeting_legacy_candidate_evidence AS
    SELECT * FROM meeting_evidence
    WHERE action_id IN (SELECT id FROM meeting_legacy_action_candidates)
       OR fact_id IN (SELECT id FROM meeting_legacy_fact_candidates);
DELETE FROM meeting_evidence
    WHERE action_id IN (SELECT id FROM meeting_actions WHERE confirmed = 0 AND status = 'open')
       OR fact_id IN (SELECT id FROM meeting_facts WHERE confirmed = 0 AND state <> 'dismissed');
DELETE FROM meeting_actions WHERE confirmed = 0 AND status = 'open';
DELETE FROM meeting_facts WHERE confirmed = 0 AND state <> 'dismissed';
