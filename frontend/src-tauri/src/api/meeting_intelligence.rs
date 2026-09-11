use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use tauri::State;
use uuid::Uuid;
use crate::state::AppState;

const MEMORY_VECTOR_DIM: usize = 1024;
const MEMORY_VECTOR_VERSION: u32 = 1;
const AUTO_EVIDENCE_THRESHOLD: f64 = 0.45;

#[derive(Debug, Clone)]
struct TranscriptSource { id: String, text: String, start: Option<f64>, end: Option<f64>, speaker_label: Option<String> }
#[derive(Debug, Clone)]
struct DerivedCandidate {
    kind: &'static str, text: String, state: String, owner: Option<String>, due_text: Option<String>,
    commitment_state: Option<String>, evidence: Option<TranscriptSource>, confidence: f64,
}
#[derive(Debug, Clone)]
struct SourceDocument {
    kind: String, source_id: String, content: String, transcript_id: Option<String>,
    audio_start_time: Option<f64>, audio_end_time: Option<f64>, speaker_label: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MeetingContext {
    pub project: Option<String>, pub client: Option<String>,
    #[serde(default)] pub participants: Vec<String>, pub agenda: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceReference {
    pub id: String, pub meeting_id: String, pub source_kind: String, pub transcript_id: Option<String>,
    pub transcript_revision: i64, pub quote: String, pub audio_start_time: Option<f64>,
    pub audio_end_time: Option<f64>, pub speaker_label: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingFact { pub id: String, pub kind: String, pub text: String, pub state: String, pub confidence: f64, pub confirmed: bool, pub evidence: Vec<EvidenceReference> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAction {
    pub id: String, pub text: String, pub owner: Option<String>, pub due_at: Option<String>, pub due_text: Option<String>,
    pub status: String, pub commitment_state: String, pub confirmed: bool, pub evidence: Vec<EvidenceReference>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingIntelligenceResponse {
    pub meeting_id: String, pub context: MeetingContext, pub outcome: Option<MeetingFact>,
    pub decisions: Vec<MeetingFact>, pub open_questions: Vec<MeetingFact>, pub actions: Vec<MeetingAction>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingActionUpdate {
    pub action_id: String, pub text: String, pub owner: Option<String>, pub due_at: Option<String>, pub due_text: Option<String>,
    pub status: String, pub commitment_state: String, pub confirmed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionInboxItem { pub action: MeetingAction, pub meeting_id: String, pub meeting_title: String, pub meeting_created_at: String, pub project: Option<String>, pub client: Option<String> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionInboxResponse { pub needs_review: Vec<ActionInboxItem>, pub open: Vec<ActionInboxItem>, pub done_recent: Vec<ActionInboxItem> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowupDraft { pub subject: String, pub body: String, pub source_action_ids: Vec<String>, pub source_fact_ids: Vec<String> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchRequest { pub query: String, pub scope: String, pub meeting_id: Option<String>, pub project: Option<String>, pub client: Option<String>, pub limit: Option<usize> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub meeting_id: String, pub meeting_title: String, pub kind: String, pub source_id: String, pub snippet: String, pub score: f64,
    pub transcript_id: Option<String>, pub audio_start_time: Option<f64>, pub audio_end_time: Option<f64>,
    pub speaker_label: Option<String>, pub project: Option<String>, pub client: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchResponse { pub answer: String, pub scope_label: String, pub hits: Vec<MemoryHit> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationItem { pub meeting_id: String, pub meeting_title: String, pub text: String, pub confirmed: bool, pub evidence: Option<EvidenceReference> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingPreparationResponse { pub context: MeetingContext, pub scope_label: String, pub prior_decisions: Vec<PreparationItem>, pub open_actions: Vec<PreparationItem>, pub open_questions: Vec<PreparationItem> }

fn db_error(error: sqlx::Error) -> String { format!("Meeting data could not be updated: {error}") }
fn clean_optional(value: Option<String>) -> Option<String> { value.and_then(|v| { let t = v.trim(); (!t.is_empty()).then(|| t.to_string()) }) }
fn stable_hash(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() { hash ^= *byte as u64; hash = hash.wrapping_mul(0x100000001b3); }
    format!("{hash:016x}")
}
fn normalize_for_key(value: &str) -> String { value.split(|c: char| !c.is_alphanumeric()).filter(|s| !s.is_empty()).map(str::to_lowercase).collect::<Vec<_>>().join(" ") }
fn stable_key(kind: &str, text: &str) -> String { stable_hash(&format!("{kind}:{}", normalize_for_key(text))) }
fn canonical_term(term: &str) -> String {
    let term = term.to_lowercase();
    match term.as_str() {
        "decide" | "decided" | "decision" | "decisions" | "agree" | "agreed" => "decision".to_string(),
        "task" | "tasks" | "action" | "actions" | "todo" | "todos" | "followup" | "follow-up" => "action".to_string(),
        "launch" | "release" | "ship" | "rollout" | "roll-out" => "launch".to_string(),
        "customer" | "client" | "account" => "client".to_string(),
        "cost" | "costs" | "price" | "pricing" | "budget" => "cost".to_string(),
        "risk" | "risks" | "blocker" | "blockers" | "concern" | "concerns" => "risk".to_string(),
        "question" | "questions" | "unknown" | "unresolved" => "question".to_string(),
        _ => if term.len() > 5 && term.ends_with("ing") { term[..term.len()-3].to_string() }
            else if term.len() > 4 && term.ends_with("ed") { term[..term.len()-2].to_string() }
            else if term.len() > 4 && term.ends_with('s') { term[..term.len()-1].to_string() } else { term },
    }
}
fn is_stopword(term: &str) -> bool {
    matches!(term, "the" | "and" | "for" | "that" | "this" | "with" | "from" | "have" | "has" | "had" | "was" | "were" | "are" | "our" | "your" | "their" | "they" | "them" | "you" | "but" | "not" | "will" | "would" | "could" | "should" | "into" | "about" | "then" | "than" | "just" | "what" | "when" | "where" | "who" | "how" | "why" | "can" | "need" | "needs" | "meeting")
}
fn terms(value: &str) -> Vec<String> {
    value.split(|c: char| !c.is_alphanumeric() && c != '-').filter_map(|raw| {
        let lowered = raw.to_lowercase(); if lowered.len() < 3 || is_stopword(&lowered) { None } else { Some(canonical_term(&lowered)) }
    }).collect()
}
fn term_set(value: &str) -> HashSet<String> { terms(value).into_iter().collect() }
fn evidence_score(candidate: &str, transcript: &str) -> f64 {
    let c = normalize_for_key(candidate); let t = normalize_for_key(transcript);
    if c.len() > 12 && t.contains(&c) { return 1.0; }
    let c = term_set(candidate); let t = term_set(transcript);
    if c.is_empty() || t.is_empty() { return 0.0; }
    let shared = c.intersection(&t).count() as f64;
    if shared == 0.0 { return 0.0; }
    let coverage = shared / c.len() as f64;
    let specificity = shared / t.len().min(c.len().max(1)) as f64;
    (coverage * 0.8 + specificity * 0.2).min(1.0)
}
fn best_evidence(candidate: &str, transcripts: &[TranscriptSource]) -> Option<(TranscriptSource, f64)> {
    transcripts.iter().map(|t| (t.clone(), evidence_score(candidate, &t.text)))
        .max_by(|a,b| a.1.partial_cmp(&b.1).unwrap_or(Ordering::Equal)).filter(|(_,score)| *score >= AUTO_EVIDENCE_THRESHOLD)
}

include!("summary_outcome_parser.rs");

async fn fetch_transcripts<'e, E: sqlx::Executor<'e, Database = sqlx::Sqlite>>(executor: E, meeting_id: &str) -> Result<Vec<TranscriptSource>, String> {
    let rows = sqlx::query("SELECT id, transcript, audio_start_time, audio_end_time, speaker_label FROM transcripts WHERE meeting_id = ? ORDER BY COALESCE(audio_start_time, 999999999.0) ASC, timestamp ASC, id ASC")
        .bind(meeting_id).fetch_all(executor).await.map_err(db_error)?;
    Ok(rows.into_iter().map(|row| TranscriptSource { id: row.get("id"), text: row.get("transcript"), start: row.try_get("audio_start_time").unwrap_or(None), end: row.try_get("audio_end_time").unwrap_or(None), speaker_label: row.try_get("speaker_label").unwrap_or(None) }).collect())
}
async fn ensure_meeting_exists(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings WHERE id = ? AND deleted_at IS NULL").bind(meeting_id).fetch_one(pool).await.map_err(db_error)?;
    if count == 0 { Err(format!("Meeting not found: {meeting_id}")) } else { Ok(()) }
}
async fn insert_evidence(connection: &mut sqlx::SqliteConnection, meeting_id: &str, fact_id: Option<&str>, action_id: Option<&str>, evidence: &TranscriptSource) -> Result<(), String> {
    sqlx::query("INSERT INTO meeting_evidence (id, meeting_id, fact_id, action_id, transcript_id, transcript_revision, source_kind, quote, audio_start_time, audio_end_time, speaker_label, created_at) VALUES (?, ?, ?, ?, ?, 1, 'transcript', ?, ?, ?, ?, CURRENT_TIMESTAMP)")
        .bind(Uuid::new_v4().to_string()).bind(meeting_id).bind(fact_id).bind(action_id).bind(&evidence.id).bind(&evidence.text).bind(evidence.start).bind(evidence.end).bind(&evidence.speaker_label).execute(connection).await.map_err(db_error)?;
    Ok(())
}

/// A projection of an already completed AI result, not an action detector.
/// Transactions make empty results, failures and concurrent reads safe. Nothing
/// is generated from raw turns, and identical summary reads never rebuild rows.
async fn refresh_meeting_intelligence(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    ensure_meeting_exists(pool, meeting_id).await?;
    let mut tx = pool.begin().await.map_err(db_error)?;
    let row = sqlx::query("SELECT status, result FROM summary_processes WHERE meeting_id = ? LIMIT 1")
        .bind(meeting_id).fetch_optional(&mut *tx).await.map_err(db_error)?;
    let Some(row) = row else { return Ok(()); };
    if !row.get::<String, _>("status").eq_ignore_ascii_case("completed") { return Ok(()); }
    let raw = row.try_get::<Option<String>, _>("result").unwrap_or(None);
    let markdown = summary_markdown(raw.clone());
    if markdown.trim().is_empty() { return Ok(()); }
    let source_hash = stable_hash(&format!("summary-outcomes-v2:{}", raw.unwrap_or_default()));
    let previous: Option<String> = sqlx::query_scalar("SELECT source_hash FROM meeting_outcome_state WHERE meeting_id = ?")
        .bind(meeting_id).fetch_optional(&mut *tx).await.map_err(db_error)?;
    if previous.as_deref() == Some(source_hash.as_str()) { return Ok(()); }
    let transcripts = fetch_transcripts(&mut *tx, meeting_id).await?;
    let candidates = parse_summary_candidates(&markdown, &transcripts);
    // Only disposable suggestions are replaced. Preserve confirmed edits, done
    // work and explicit rejections even in older databases with confirmed=0.
    sqlx::query("DELETE FROM meeting_evidence WHERE fact_id IN (SELECT id FROM meeting_facts WHERE meeting_id = ? AND confirmed = 0 AND state <> 'dismissed') OR action_id IN (SELECT id FROM meeting_actions WHERE meeting_id = ? AND confirmed = 0 AND status = 'open')")
        .bind(meeting_id).bind(meeting_id).execute(&mut *tx).await.map_err(db_error)?;
    sqlx::query("DELETE FROM meeting_facts WHERE meeting_id = ? AND confirmed = 0 AND state <> 'dismissed'").bind(meeting_id).execute(&mut *tx).await.map_err(db_error)?;
    sqlx::query("DELETE FROM meeting_actions WHERE meeting_id = ? AND confirmed = 0 AND status = 'open'").bind(meeting_id).execute(&mut *tx).await.map_err(db_error)?;
    for candidate in candidates {
        let id = Uuid::new_v4().to_string();
        let key = stable_key(candidate.kind, &candidate.text);
        let inserted = if candidate.kind == "action" {
            sqlx::query("INSERT OR IGNORE INTO meeting_actions (id, meeting_id, text, owner, due_text, status, commitment_state, confirmed, stable_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
                .bind(&id).bind(meeting_id).bind(&candidate.text).bind(&candidate.owner).bind(&candidate.due_text)
                .bind(candidate.commitment_state.as_deref().unwrap_or("detected")).bind(&key).execute(&mut *tx).await.map_err(db_error)?
        } else {
            sqlx::query("INSERT OR IGNORE INTO meeting_facts (id, meeting_id, kind, text, state, confidence, confirmed, stable_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
                .bind(&id).bind(meeting_id).bind(candidate.kind).bind(&candidate.text).bind(&candidate.state).bind(candidate.confidence).bind(&key).execute(&mut *tx).await.map_err(db_error)?
        };
        if inserted.rows_affected() > 0 {
            if let Some(evidence) = &candidate.evidence {
                let action = candidate.kind == "action";
                insert_evidence(&mut tx, meeting_id, (!action).then_some(id.as_str()), action.then_some(id.as_str()), evidence).await?;
            }
        }
    }
    // Record even zero-action summaries; absence of tasks is a valid AI outcome.
    sqlx::query("INSERT INTO meeting_outcome_state (meeting_id, source_hash, projected_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(meeting_id) DO UPDATE SET source_hash = excluded.source_hash, projected_at = CURRENT_TIMESTAMP")
        .bind(meeting_id).bind(source_hash).execute(&mut *tx).await.map_err(db_error)?;
    sqlx::query("DELETE FROM meeting_memory_state WHERE meeting_id = ?").bind(meeting_id).execute(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(())
}
async fn load_context(pool: &SqlitePool, meeting_id: &str) -> Result<MeetingContext, String> {
    let row = sqlx::query("SELECT project, client, participants_json, agenda FROM meeting_contexts WHERE meeting_id = ?").bind(meeting_id).fetch_optional(pool).await.map_err(db_error)?;
    let Some(row) = row else { return Ok(MeetingContext::default()); };
    Ok(MeetingContext { project: row.try_get("project").unwrap_or(None), client: row.try_get("client").unwrap_or(None), agenda: row.try_get("agenda").unwrap_or(None), participants: serde_json::from_str(&row.try_get::<String,_>("participants_json").unwrap_or_else(|_| "[]".to_string())).unwrap_or_default() })
}
async fn load_evidence_for(pool: &SqlitePool, fact_id: Option<&str>, action_id: Option<&str>) -> Result<Vec<EvidenceReference>, String> {
    let rows = if let Some(id) = fact_id {
        sqlx::query("SELECT * FROM meeting_evidence WHERE fact_id = ? ORDER BY created_at ASC").bind(id).fetch_all(pool).await
    } else if let Some(id) = action_id {
        sqlx::query("SELECT * FROM meeting_evidence WHERE action_id = ? ORDER BY created_at ASC").bind(id).fetch_all(pool).await
    } else { return Ok(Vec::new()); }.map_err(db_error)?;
    Ok(rows.into_iter().map(|r| EvidenceReference { id: r.get("id"), meeting_id: r.get("meeting_id"), source_kind: r.get("source_kind"), transcript_id: r.try_get("transcript_id").unwrap_or(None), transcript_revision: r.try_get("transcript_revision").unwrap_or(1), quote: r.get("quote"), audio_start_time: r.try_get("audio_start_time").unwrap_or(None), audio_end_time: r.try_get("audio_end_time").unwrap_or(None), speaker_label: r.try_get("speaker_label").unwrap_or(None) }).collect())
}
async fn action_from_row(pool: &SqlitePool, row: &sqlx::sqlite::SqliteRow, id: String) -> Result<MeetingAction, String> {
    Ok(MeetingAction { evidence: load_evidence_for(pool, None, Some(&id)).await?, id,
        text: row.get("text"), owner: row.try_get("owner").unwrap_or(None), due_at: row.try_get("due_at").unwrap_or(None), due_text: row.try_get("due_text").unwrap_or(None), status: row.get("status"), commitment_state: row.get("commitment_state"), confirmed: row.try_get::<i64,_>("confirmed").unwrap_or(0) != 0 })
}
async fn load_intelligence(pool: &SqlitePool, meeting_id: &str, refresh: bool) -> Result<MeetingIntelligenceResponse, String> {
    ensure_meeting_exists(pool, meeting_id).await?;
    if refresh { refresh_meeting_intelligence(pool, meeting_id).await?; }
    let rows = sqlx::query("SELECT id, kind, text, state, confidence, confirmed FROM meeting_facts f WHERE meeting_id = ? AND state <> 'dismissed' AND (confirmed = 1 OR EXISTS (SELECT 1 FROM meeting_outcome_state o WHERE o.meeting_id = f.meeting_id)) ORDER BY CASE kind WHEN 'outcome' THEN 0 WHEN 'decision' THEN 1 ELSE 2 END, confirmed DESC, confidence DESC, created_at ASC")
        .bind(meeting_id).fetch_all(pool).await.map_err(db_error)?;
    let mut outcome = None; let mut decisions = Vec::new(); let mut open_questions = Vec::new();
    for row in rows {
        let id: String = row.get("id");
        let fact = MeetingFact { evidence: load_evidence_for(pool, Some(&id), None).await?, id, kind: row.get("kind"), text: row.get("text"), state: row.get("state"), confidence: row.try_get("confidence").unwrap_or(0.0), confirmed: row.try_get::<i64,_>("confirmed").unwrap_or(0) != 0 };
        match fact.kind.as_str() { "outcome" if outcome.is_none() => outcome = Some(fact), "decision" => decisions.push(fact), "open_question" => open_questions.push(fact), _ => {} }
    }
    let rows = sqlx::query("SELECT id, text, owner, due_at, due_text, status, commitment_state, confirmed FROM meeting_actions a WHERE meeting_id = ? AND status <> 'dismissed' AND (confirmed = 1 OR status = 'done' OR EXISTS (SELECT 1 FROM meeting_outcome_state o WHERE o.meeting_id = a.meeting_id)) ORDER BY confirmed DESC, CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at ASC")
        .bind(meeting_id).fetch_all(pool).await.map_err(db_error)?;
    let mut actions = Vec::new();
    for row in rows { actions.push(action_from_row(pool, &row, row.get("id")).await?); }
    Ok(MeetingIntelligenceResponse { meeting_id: meeting_id.to_string(), context: load_context(pool, meeting_id).await?, outcome, decisions, open_questions, actions })
}
async fn invalidate_meeting_memory(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM meeting_memory_state WHERE meeting_id = ?").bind(meeting_id).execute(pool).await.map_err(db_error)?; Ok(())
}
#[tauri::command]
pub async fn api_refresh_meeting_intelligence(state: State<'_, AppState>, meeting_id: String) -> Result<MeetingIntelligenceResponse, String> {
    if meeting_id.trim().is_empty() { return Err("meeting_id cannot be empty".to_string()); }
    refresh_meeting_intelligence(state.db_manager.pool(), meeting_id.trim()).await?;
    load_intelligence(state.db_manager.pool(), meeting_id.trim(), false).await
}
#[tauri::command]
pub async fn api_get_meeting_intelligence(state: State<'_, AppState>, meeting_id: String) -> Result<MeetingIntelligenceResponse, String> {
    if meeting_id.trim().is_empty() { return Err("meeting_id cannot be empty".to_string()); }
    load_intelligence(state.db_manager.pool(), meeting_id.trim(), true).await
}
#[tauri::command]
pub async fn api_save_meeting_context(state: State<'_, AppState>, meeting_id: String, context: MeetingContext) -> Result<MeetingContext, String> {
    let pool = state.db_manager.pool(); let id = meeting_id.trim(); ensure_meeting_exists(pool, id).await?;
    let context = MeetingContext { project: clean_optional(context.project), client: clean_optional(context.client), agenda: clean_optional(context.agenda), participants: context.participants.into_iter().filter_map(|v| clean_optional(Some(v))).collect() };
    sqlx::query("INSERT INTO meeting_contexts (meeting_id, project, client, participants_json, agenda, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(meeting_id) DO UPDATE SET project = excluded.project, client = excluded.client, participants_json = excluded.participants_json, agenda = excluded.agenda, updated_at = CURRENT_TIMESTAMP")
        .bind(id).bind(&context.project).bind(&context.client).bind(serde_json::to_string(&context.participants).map_err(|e| e.to_string())?).bind(&context.agenda).execute(pool).await.map_err(db_error)?;
    sqlx::query("UPDATE meetings SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).execute(pool).await.map_err(db_error)?;
    invalidate_meeting_memory(pool, id).await?; Ok(context)
}
#[tauri::command]
pub async fn api_set_meeting_fact_confirmed(state: State<'_, AppState>, fact_id: String, confirmed: bool) -> Result<(), String> {
    let pool = state.db_manager.pool();
    let id: String = sqlx::query_scalar("SELECT meeting_id FROM meeting_facts WHERE id = ?").bind(&fact_id).fetch_optional(pool).await.map_err(db_error)?.ok_or_else(|| "Meeting fact not found".to_string())?;
    sqlx::query("UPDATE meeting_facts SET confirmed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(confirmed).bind(&fact_id).execute(pool).await.map_err(db_error)?;
    sqlx::query("UPDATE meetings SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(&id).execute(pool).await.map_err(db_error)?;
    invalidate_meeting_memory(pool, &id).await
}
#[tauri::command]
pub async fn api_dismiss_meeting_fact(state: State<'_, AppState>, fact_id: String) -> Result<(), String> {
    let pool = state.db_manager.pool();
    let id: String = sqlx::query_scalar("SELECT meeting_id FROM meeting_facts WHERE id = ?").bind(&fact_id).fetch_optional(pool).await.map_err(db_error)?.ok_or_else(|| "Meeting fact not found".to_string())?;
    sqlx::query("UPDATE meeting_facts SET state = 'dismissed', confirmed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(&fact_id).execute(pool).await.map_err(db_error)?;
    sqlx::query("UPDATE meetings SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(&id).execute(pool).await.map_err(db_error)?;
    invalidate_meeting_memory(pool, &id).await
}
#[tauri::command]
pub async fn api_update_meeting_action(state: State<'_, AppState>, update: MeetingActionUpdate) -> Result<MeetingAction, String> {
    let pool = state.db_manager.pool();
    if update.text.trim().is_empty() { return Err("Action text cannot be empty".to_string()); }
    if !matches!(update.status.as_str(), "open" | "done" | "dismissed") { return Err("Action status must be open, done, or dismissed".to_string()); }
    if !matches!(update.commitment_state.as_str(), "detected" | "proposed" | "agreed") { return Err("Commitment state must be detected, proposed, or agreed".to_string()); }
    let id: String = sqlx::query_scalar("SELECT meeting_id FROM meeting_actions WHERE id = ?").bind(&update.action_id).fetch_optional(pool).await.map_err(db_error)?.ok_or_else(|| "Action not found".to_string())?;
    sqlx::query("UPDATE meeting_actions SET text = ?, owner = ?, due_at = ?, due_text = ?, status = ?, commitment_state = ?, confirmed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(update.text.trim()).bind(clean_optional(update.owner)).bind(clean_optional(update.due_at)).bind(clean_optional(update.due_text)).bind(&update.status).bind(&update.commitment_state).bind(update.confirmed).bind(&update.action_id).execute(pool).await.map_err(db_error)?;
    sqlx::query("UPDATE meetings SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(&id).execute(pool).await.map_err(db_error)?;
    invalidate_meeting_memory(pool, &id).await?;
    let row = sqlx::query("SELECT * FROM meeting_actions WHERE id = ?").bind(&update.action_id).fetch_one(pool).await.map_err(db_error)?;
    action_from_row(pool, &row, update.action_id).await
}

/// Backfill only persisted completed AI results. Opening Actions never invokes AI
/// and never scans raw transcript text for commitments.
async fn refresh_recent_missing(pool: &SqlitePool) -> Result<(), String> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT m.id FROM meetings m JOIN summary_processes s ON s.meeting_id = m.id WHERE m.deleted_at IS NULL AND LOWER(s.status) = 'completed' AND s.result IS NOT NULL ORDER BY s.updated_at DESC LIMIT 12")
        .fetch_all(pool).await.map_err(db_error)?;
    for id in ids { refresh_meeting_intelligence(pool, &id).await?; }
    Ok(())
}
#[tauri::command]
pub async fn api_get_action_inbox(state: State<'_, AppState>) -> Result<ActionInboxResponse, String> {
    let pool = state.db_manager.pool(); refresh_recent_missing(pool).await?;
    let rows = sqlx::query("SELECT a.id AS action_id, a.meeting_id, a.text, a.owner, a.due_at, a.due_text, a.status, a.commitment_state, a.confirmed, m.title AS meeting_title, CAST(m.created_at AS TEXT) AS meeting_created_at, c.project, c.client FROM meeting_actions a JOIN meetings m ON m.id = a.meeting_id LEFT JOIN meeting_contexts c ON c.meeting_id = a.meeting_id WHERE m.deleted_at IS NULL AND a.status <> 'dismissed' AND (a.confirmed = 1 OR a.status = 'done' OR EXISTS (SELECT 1 FROM meeting_outcome_state o WHERE o.meeting_id = a.meeting_id)) ORDER BY a.confirmed ASC, CASE a.status WHEN 'open' THEN 0 ELSE 1 END, CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END, a.due_at ASC, m.created_at DESC")
        .fetch_all(pool).await.map_err(db_error)?;
    let mut needs_review = Vec::new(); let mut open = Vec::new(); let mut done_recent = Vec::new();
    for row in rows {
        let item = ActionInboxItem { action: action_from_row(pool, &row, row.get("action_id")).await?, meeting_id: row.get("meeting_id"), meeting_title: row.get("meeting_title"), meeting_created_at: row.get("meeting_created_at"), project: row.try_get("project").unwrap_or(None), client: row.try_get("client").unwrap_or(None) };
        if item.action.status == "done" { if done_recent.len() < 20 { done_recent.push(item); } }
        else if !item.action.confirmed { if needs_review.len() < 50 { needs_review.push(item); } }
        else if open.len() < 100 { open.push(item); }
    }
    Ok(ActionInboxResponse { needs_review, open, done_recent })
}
#[tauri::command]
pub async fn api_generate_followup_draft(state: State<'_, AppState>, meeting_id: String) -> Result<FollowupDraft, String> {
    let pool = state.db_manager.pool(); let id = meeting_id.trim();
    let intelligence = load_intelligence(pool, id, true).await?;
    let title: String = sqlx::query_scalar("SELECT title FROM meetings WHERE id = ?").bind(id).fetch_one(pool).await.map_err(db_error)?;
    let decisions: Vec<_> = intelligence.decisions.iter().filter(|f| f.confirmed).collect();
    let actions: Vec<_> = intelligence.actions.iter().filter(|a| a.confirmed && a.status == "open" && a.commitment_state == "agreed").collect();
    let proposals: Vec<_> = intelligence.actions.iter().filter(|a| a.confirmed && a.status == "open" && a.commitment_state == "proposed").collect();
    let questions: Vec<_> = intelligence.open_questions.iter().filter(|f| f.confirmed).collect();
    let mut body = String::from("Thanks everyone. Here is my readout from the meeting.\n\n");
    if !decisions.is_empty() { body.push_str("Decisions\n"); for item in &decisions { body.push_str(&format!("- {}\n", item.text.trim())); } body.push('\n'); }
    body.push_str("Actions\n");
    if actions.is_empty() { body.push_str("- No confirmed commitments yet.\n"); }
    for item in &actions {
        body.push_str("- "); if let Some(owner) = &item.owner { body.push_str(owner); body.push_str(" — "); }
        body.push_str(item.text.trim()); if let Some(due) = item.due_at.as_deref().or(item.due_text.as_deref()) { body.push_str(&format!(" (due {due})")); } body.push('\n');
    }
    body.push('\n');
    if !proposals.is_empty() { body.push_str("Proposed follow-ups (not commitments)\n"); for item in &proposals { body.push_str(&format!("- {}\n", item.text.trim())); } body.push('\n'); }
    if !questions.is_empty() { body.push_str("Open questions\n"); for item in &questions { body.push_str(&format!("- {}\n", item.text.trim())); } body.push('\n'); }
    body.push_str("Please reply if I missed or misrepresented anything.");
    Ok(FollowupDraft { subject: format!("Follow-up — {title}"), body,
        source_action_ids: actions.into_iter().chain(proposals).map(|a| a.id.clone()).collect(),
        source_fact_ids: decisions.into_iter().chain(questions).map(|f| f.id.clone()).collect() })
}

// Local recall remains separate from AI outcome projection. Its public commands,
// sparse ranking, source navigation and reviewed-only work filters are preserved.
include!("meeting_memory.rs");
#[cfg(test)]
#[path = "summary_first_outcomes_tests.rs"]
mod tests;
