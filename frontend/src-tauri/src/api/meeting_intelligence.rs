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
struct TranscriptSource {
    id: String,
    text: String,
    start: Option<f64>,
    end: Option<f64>,
    speaker_label: Option<String>,
}

#[derive(Debug, Clone)]
struct DerivedCandidate {
    kind: &'static str,
    text: String,
    state: String,
    owner: Option<String>,
    due_text: Option<String>,
    commitment_state: Option<String>,
    evidence: Option<TranscriptSource>,
    confidence: f64,
}

#[derive(Debug, Clone)]
struct SourceDocument {
    kind: String,
    source_id: String,
    content: String,
    transcript_id: Option<String>,
    audio_start_time: Option<f64>,
    audio_end_time: Option<f64>,
    speaker_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MeetingContext {
    pub project: Option<String>,
    pub client: Option<String>,
    #[serde(default)]
    pub participants: Vec<String>,
    pub agenda: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceReference {
    pub id: String,
    pub meeting_id: String,
    pub source_kind: String,
    pub transcript_id: Option<String>,
    pub transcript_revision: i64,
    pub quote: String,
    pub audio_start_time: Option<f64>,
    pub audio_end_time: Option<f64>,
    pub speaker_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingFact {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub state: String,
    pub confidence: f64,
    pub confirmed: bool,
    pub evidence: Vec<EvidenceReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAction {
    pub id: String,
    pub text: String,
    pub owner: Option<String>,
    pub due_at: Option<String>,
    pub due_text: Option<String>,
    pub status: String,
    pub commitment_state: String,
    pub confirmed: bool,
    pub evidence: Vec<EvidenceReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingIntelligenceResponse {
    pub meeting_id: String,
    pub context: MeetingContext,
    pub outcome: Option<MeetingFact>,
    pub decisions: Vec<MeetingFact>,
    pub open_questions: Vec<MeetingFact>,
    pub actions: Vec<MeetingAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingActionUpdate {
    pub action_id: String,
    pub text: String,
    pub owner: Option<String>,
    pub due_at: Option<String>,
    pub due_text: Option<String>,
    pub status: String,
    pub commitment_state: String,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionInboxItem {
    pub action: MeetingAction,
    pub meeting_id: String,
    pub meeting_title: String,
    pub meeting_created_at: String,
    pub project: Option<String>,
    pub client: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionInboxResponse {
    pub needs_review: Vec<ActionInboxItem>,
    pub open: Vec<ActionInboxItem>,
    pub done_recent: Vec<ActionInboxItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowupDraft {
    pub subject: String,
    pub body: String,
    pub source_action_ids: Vec<String>,
    pub source_fact_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchRequest {
    pub query: String,
    pub scope: String,
    pub meeting_id: Option<String>,
    pub project: Option<String>,
    pub client: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub meeting_id: String,
    pub meeting_title: String,
    pub kind: String,
    pub source_id: String,
    pub snippet: String,
    pub score: f64,
    pub transcript_id: Option<String>,
    pub audio_start_time: Option<f64>,
    pub audio_end_time: Option<f64>,
    pub speaker_label: Option<String>,
    pub project: Option<String>,
    pub client: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchResponse {
    pub answer: String,
    pub scope_label: String,
    pub hits: Vec<MemoryHit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationItem {
    pub meeting_id: String,
    pub meeting_title: String,
    pub text: String,
    pub confirmed: bool,
    pub evidence: Option<EvidenceReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingPreparationResponse {
    pub context: MeetingContext,
    pub scope_label: String,
    pub prior_decisions: Vec<PreparationItem>,
    pub open_actions: Vec<PreparationItem>,
    pub open_questions: Vec<PreparationItem>,
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn stable_hash(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn normalize_for_key(value: &str) -> String {
    value
        .split(|c: char| !c.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| part.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

fn stable_key(kind: &str, text: &str) -> String {
    stable_hash(&format!("{kind}:{}", normalize_for_key(text)))
}

fn canonical_term(term: &str) -> String {
    let term = term.to_lowercase();
    match term.as_str() {
        "decide" | "decided" | "decision" | "decisions" | "agree" | "agreed" => {
            "decision".to_string()
        }
        "task" | "tasks" | "action" | "actions" | "todo" | "todos" | "followup"
        | "follow-up" => "action".to_string(),
        "launch" | "release" | "ship" | "rollout" | "roll-out" => "launch".to_string(),
        "customer" | "client" | "account" => "client".to_string(),
        "cost" | "costs" | "price" | "pricing" | "budget" => "cost".to_string(),
        "risk" | "risks" | "blocker" | "blockers" | "concern" | "concerns" => {
            "risk".to_string()
        }
        "question" | "questions" | "unknown" | "unresolved" => "question".to_string(),
        _ => {
            if term.len() > 5 && term.ends_with("ing") {
                term[..term.len() - 3].to_string()
            } else if term.len() > 4 && term.ends_with("ed") {
                term[..term.len() - 2].to_string()
            } else if term.len() > 4 && term.ends_with('s') {
                term[..term.len() - 1].to_string()
            } else {
                term
            }
        }
    }
}

fn is_stopword(term: &str) -> bool {
    matches!(
        term,
        "the"
            | "and"
            | "for"
            | "that"
            | "this"
            | "with"
            | "from"
            | "have"
            | "has"
            | "had"
            | "was"
            | "were"
            | "are"
            | "our"
            | "your"
            | "their"
            | "they"
            | "them"
            | "you"
            | "but"
            | "not"
            | "will"
            | "would"
            | "could"
            | "should"
            | "into"
            | "about"
            | "then"
            | "than"
            | "just"
            | "what"
            | "when"
            | "where"
            | "who"
            | "how"
            | "why"
            | "can"
            | "need"
            | "needs"
            | "meeting"
    )
}

fn terms(value: &str) -> Vec<String> {
    value
        .split(|c: char| !c.is_alphanumeric() && c != '-')
        .filter_map(|raw| {
            let lowered = raw.to_lowercase();
            if lowered.len() < 3 || is_stopword(&lowered) {
                None
            } else {
                Some(canonical_term(&lowered))
            }
        })
        .collect()
}

fn term_set(value: &str) -> HashSet<String> {
    terms(value).into_iter().collect()
}

fn evidence_score(candidate: &str, transcript: &str) -> f64 {
    let candidate_normalized = normalize_for_key(candidate);
    let transcript_normalized = normalize_for_key(transcript);
    if candidate_normalized.len() > 12 && transcript_normalized.contains(&candidate_normalized) {
        return 1.0;
    }

    let candidate_terms = term_set(candidate);
    let transcript_terms = term_set(transcript);
    if candidate_terms.is_empty() || transcript_terms.is_empty() {
        return 0.0;
    }
    let shared = candidate_terms.intersection(&transcript_terms).count() as f64;
    if shared == 0.0 {
        return 0.0;
    }
    let coverage = shared / candidate_terms.len() as f64;
    let specificity = shared / transcript_terms.len().min(candidate_terms.len().max(1)) as f64;
    (coverage * 0.8 + specificity * 0.2).min(1.0)
}

fn best_evidence(candidate: &str, transcripts: &[TranscriptSource]) -> Option<(TranscriptSource, f64)> {
    transcripts
        .iter()
        .map(|transcript| (transcript.clone(), evidence_score(candidate, &transcript.text)))
        .max_by(|left, right| left.1.partial_cmp(&right.1).unwrap_or(Ordering::Equal))
        .filter(|(_, score)| *score >= AUTO_EVIDENCE_THRESHOLD)
}

fn classify_heading(heading: &str) -> Option<&'static str> {
    let heading = heading.to_lowercase();
    if heading.contains("decision") || heading.contains("agreed") {
        Some("decision")
    } else if heading.contains("action")
        || heading.contains("next step")
        || heading.contains("commitment")
        || heading.contains("follow-up")
        || heading.contains("follow up")
    {
        Some("action")
    } else if heading.contains("open question")
        || heading.contains("unresolved")
        || heading == "questions"
        || heading.contains("question to resolve")
    {
        Some("open_question")
    } else if heading.contains("outcome")
        || heading.contains("executive summary")
        || heading == "summary"
        || heading.contains("meeting overview")
    {
        Some("outcome")
    } else {
        None
    }
}

fn clean_candidate_line(line: &str) -> String {
    let mut value = line.trim();
    for prefix in ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "+ "] {
        if let Some(rest) = value.strip_prefix(prefix) {
            value = rest.trim();
            break;
        }
    }
    let mut chars = value.chars().peekable();
    let mut numeric_prefix = String::new();
    while let Some(ch) = chars.peek().copied() {
        if ch.is_ascii_digit() || ch == '.' || ch == ')' || ch.is_whitespace() {
            numeric_prefix.push(ch);
            chars.next();
        } else {
            break;
        }
    }
    if numeric_prefix.chars().any(|ch| ch.is_ascii_digit())
        && (numeric_prefix.contains('.') || numeric_prefix.contains(')'))
    {
        value = value[numeric_prefix.len()..].trim();
    }
    value.trim_matches('`').trim().to_string()
}

fn useful_candidate(value: &str) -> bool {
    let trimmed = value.trim();
    let lower = trimmed.to_lowercase();
    trimmed.len() >= 8
        && !trimmed.eq_ignore_ascii_case("none")
        && !lower.starts_with("none noted")
        && !lower.starts_with("not discussed")
        && !lower.starts_with("no decision")
        && !lower.starts_with("no action")
        && !lower.starts_with("no open question")
}

fn json_summary_to_markdown(value: &Value) -> String {
    if let Some(markdown) = value.get("markdown").and_then(Value::as_str) {
        return markdown.to_string();
    }

    let mut output = String::new();
    if let Some(object) = value.as_object() {
        for (key, section) in object {
            if key.starts_with('_') || key == "MeetingName" {
                continue;
            }
            let title = section
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or(key.as_str());
            let Some(blocks) = section.get("blocks").and_then(Value::as_array) else {
                continue;
            };
            output.push_str(&format!("\n## {title}\n"));
            for block in blocks {
                if let Some(content) = block.get("content").and_then(Value::as_str) {
                    output.push_str("- ");
                    output.push_str(content);
                    output.push('\n');
                }
            }
        }
    }
    output
}

fn summary_markdown(result: Option<String>) -> String {
    let Some(result) = result else {
        return String::new();
    };
    match serde_json::from_str::<Value>(&result) {
        Ok(value) => json_summary_to_markdown(&value),
        Err(_) => result,
    }
}

fn parse_summary_candidates(markdown: &str, transcripts: &[TranscriptSource]) -> Vec<DerivedCandidate> {
    let mut current_kind: Option<&'static str> = None;
    let mut candidates = Vec::new();
    let mut captured_outcome = false;

    for raw_line in markdown.lines() {
        let line = raw_line.trim();
        if line.starts_with('#') {
            let heading = line.trim_start_matches('#').trim();
            current_kind = classify_heading(heading);
            continue;
        }
        let Some(kind) = current_kind else {
            continue;
        };
        let text = clean_candidate_line(line);
        if !useful_candidate(&text) {
            continue;
        }
        if kind == "outcome" && captured_outcome {
            continue;
        }
        if kind == "outcome" {
            captured_outcome = true;
        }
        let matched = best_evidence(&text, transcripts);
        let confidence = matched.as_ref().map(|(_, score)| *score).unwrap_or(0.0);
        let (owner, due_text) = if kind == "action" {
            (extract_owner(&text), extract_due_text(&text))
        } else {
            (None, None)
        };
        candidates.push(DerivedCandidate {
            kind,
            text,
            state: match kind {
                "decision" => "agreed".to_string(),
                "open_question" => "open".to_string(),
                "outcome" => "stated".to_string(),
                _ => "detected".to_string(),
            },
            owner,
            due_text,
            commitment_state: (kind == "action").then(|| "detected".to_string()),
            evidence: matched.map(|(source, _)| source),
            confidence,
        });
    }
    candidates
}

fn explicit_decision(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "we decided",
        "we've decided",
        "we have decided",
        "we agreed",
        "agreed that",
        "the decision is",
        "let's go with",
        "we'll go with",
        "we will go with",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn explicit_action(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    if ["i'll ", "i will ", "i can take ", "i'll take ", "i will take "]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        Some("agreed")
    } else if [
        "we'll ",
        "we will ",
        "will follow up",
        "need to follow up",
        "action item",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        Some("agreed")
    } else if ["can you ", "could you ", "please ", "will you "]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        Some("proposed")
    } else {
        None
    }
}

fn explicit_open_question(text: &str) -> bool {
    if !text.contains('?') {
        return false;
    }
    let lower = text.to_lowercase();
    [
        "do we ",
        "should we ",
        "what about ",
        "open question",
        "need to decide",
        "whether we ",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn parse_transcript_candidates(transcripts: &[TranscriptSource]) -> Vec<DerivedCandidate> {
    let mut candidates = Vec::new();
    for transcript in transcripts {
        let text = transcript.text.trim();
        if !useful_candidate(text) {
            continue;
        }
        if explicit_decision(text) {
            candidates.push(DerivedCandidate {
                kind: "decision",
                text: text.to_string(),
                state: "agreed".to_string(),
                owner: None,
                due_text: None,
                commitment_state: None,
                evidence: Some(transcript.clone()),
                confidence: 1.0,
            });
        }
        if let Some(commitment_state) = explicit_action(text) {
            let lower = text.to_lowercase();
            let singular_self_commitment = ["i'll ", "i will ", "i can take ", "i'll take ", "i will take "]
                .iter()
                .any(|needle| lower.contains(needle));
            candidates.push(DerivedCandidate {
                kind: "action",
                text: text.to_string(),
                state: "detected".to_string(),
                owner: if commitment_state == "agreed" && singular_self_commitment {
                    transcript.speaker_label.clone()
                } else {
                    extract_owner(text)
                },
                due_text: extract_due_text(text),
                commitment_state: Some(commitment_state.to_string()),
                evidence: Some(transcript.clone()),
                confidence: 1.0,
            });
        }
        if explicit_open_question(text) {
            candidates.push(DerivedCandidate {
                kind: "open_question",
                text: text.to_string(),
                state: "open".to_string(),
                owner: None,
                due_text: None,
                commitment_state: None,
                evidence: Some(transcript.clone()),
                confidence: 1.0,
            });
        }
    }
    candidates
}

fn candidate_duplicate(left: &DerivedCandidate, right: &DerivedCandidate) -> bool {
    if left.kind != right.kind {
        return false;
    }
    let left_terms = term_set(&left.text);
    let right_terms = term_set(&right.text);
    if left_terms.is_empty() || right_terms.is_empty() {
        return normalize_for_key(&left.text) == normalize_for_key(&right.text);
    }
    let shared = left_terms.intersection(&right_terms).count() as f64;
    let denominator = left_terms.len().min(right_terms.len()) as f64;
    shared / denominator >= 0.7
}

fn dedupe_candidates(candidates: Vec<DerivedCandidate>) -> Vec<DerivedCandidate> {
    let mut result: Vec<DerivedCandidate> = Vec::new();
    for candidate in candidates {
        if let Some(existing) = result
            .iter_mut()
            .find(|existing| candidate_duplicate(existing, &candidate))
        {
            if candidate.confidence > existing.confidence {
                *existing = candidate;
            }
        } else {
            result.push(candidate);
        }
    }
    result
}

fn extract_owner(text: &str) -> Option<String> {
    for separator in [":", " — ", " - "] {
        if let Some((prefix, _)) = text.split_once(separator) {
            let prefix = prefix.trim().trim_matches('*');
            if (2..=40).contains(&prefix.len())
                && prefix.split_whitespace().count() <= 4
                && prefix.chars().any(|c| c.is_alphabetic())
            {
                return Some(prefix.to_string());
            }
        }
    }
    None
}

fn extract_due_text(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for marker in [" by ", " due ", " before "] {
        if let Some(index) = lower.find(marker) {
            let start = index + marker.len();
            let rest = text[start..]
                .trim()
                .trim_end_matches(&['.', ';'][..])
                .split(',')
                .next()
                .unwrap_or_default()
                .trim();
            if !rest.is_empty() && rest.len() <= 64 {
                return Some(rest.to_string());
            }
        }
    }
    None
}

async fn fetch_transcripts(pool: &SqlitePool, meeting_id: &str) -> Result<Vec<TranscriptSource>, String> {
    let rows = sqlx::query(
        "SELECT id, transcript, audio_start_time, audio_end_time, speaker_label
         FROM transcripts
         WHERE meeting_id = ?
         ORDER BY COALESCE(audio_start_time, 999999999.0) ASC, timestamp ASC, id ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("Failed to load transcript evidence: {error}"))?;

    Ok(rows
        .into_iter()
        .map(|row| TranscriptSource {
            id: row.get::<String, _>("id"),
            text: row.get::<String, _>("transcript"),
            start: row
                .try_get::<Option<f64>, _>("audio_start_time")
                .unwrap_or(None),
            end: row
                .try_get::<Option<f64>, _>("audio_end_time")
                .unwrap_or(None),
            speaker_label: row
                .try_get::<Option<String>, _>("speaker_label")
                .unwrap_or(None),
        })
        .collect())
}

async fn load_summary_markdown(pool: &SqlitePool, meeting_id: &str) -> Result<String, String> {
    let result = sqlx::query_scalar::<_, Option<String>>(
        "SELECT result FROM summary_processes WHERE meeting_id = ? LIMIT 1",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("Failed to load meeting summary: {error}"))?
    .flatten();
    Ok(summary_markdown(result))
}

async fn ensure_meeting_exists(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    let exists = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM meetings WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(meeting_id)
    .fetch_one(pool)
    .await
    .map_err(|error| format!("Failed to verify meeting: {error}"))?;
    if exists == 0 {
        Err(format!("Meeting not found: {meeting_id}"))
    } else {
        Ok(())
    }
}

async fn insert_evidence(
    pool: &SqlitePool,
    meeting_id: &str,
    fact_id: Option<&str>,
    action_id: Option<&str>,
    evidence: &TranscriptSource,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO meeting_evidence
         (id, meeting_id, fact_id, action_id, transcript_id, transcript_revision, source_kind, quote,
          audio_start_time, audio_end_time, speaker_label, created_at)
         VALUES (?, ?, ?, ?, ?, 1, 'transcript', ?, ?, ?, ?, CURRENT_TIMESTAMP)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(meeting_id)
    .bind(fact_id)
    .bind(action_id)
    .bind(&evidence.id)
    .bind(&evidence.text)
    .bind(evidence.start)
    .bind(evidence.end)
    .bind(&evidence.speaker_label)
    .execute(pool)
    .await
    .map_err(|error| format!("Failed to save meeting evidence: {error}"))?;
    Ok(())
}

async fn refresh_meeting_intelligence(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    ensure_meeting_exists(pool, meeting_id).await?;
    let transcripts = fetch_transcripts(pool, meeting_id).await?;
    if transcripts.is_empty() {
        return Ok(());
    }

    let markdown = load_summary_markdown(pool, meeting_id).await.unwrap_or_default();
    let mut candidates = parse_summary_candidates(&markdown, &transcripts);
    candidates.extend(parse_transcript_candidates(&transcripts));
    let candidates = dedupe_candidates(candidates);

    sqlx::query(
        "DELETE FROM meeting_evidence
         WHERE fact_id IN (SELECT id FROM meeting_facts WHERE meeting_id = ? AND confirmed = 0)",
    )
    .bind(meeting_id)
    .execute(pool)
    .await
    .map_err(|error| format!("Failed to clear stale fact evidence: {error}"))?;
    sqlx::query(
        "DELETE FROM meeting_evidence
         WHERE action_id IN (SELECT id FROM meeting_actions WHERE meeting_id = ? AND confirmed = 0)",
    )
    .bind(meeting_id)
    .execute(pool)
    .await
    .map_err(|error| format!("Failed to clear stale action evidence: {error}"))?;
    sqlx::query("DELETE FROM meeting_facts WHERE meeting_id = ? AND confirmed = 0")
        .bind(meeting_id)
        .execute(pool)
        .await
        .map_err(|error| format!("Failed to refresh meeting facts: {error}"))?;
    sqlx::query("DELETE FROM meeting_actions WHERE meeting_id = ? AND confirmed = 0")
        .bind(meeting_id)
        .execute(pool)
        .await
        .map_err(|error| format!("Failed to refresh meeting actions: {error}"))?;

    for candidate in candidates {
        if candidate.kind == "action" {
            let id = Uuid::new_v4().to_string();
            let key = stable_key("action", &candidate.text);
            let inserted = sqlx::query(
                "INSERT OR IGNORE INTO meeting_actions
                 (id, meeting_id, text, owner, due_text, status, commitment_state,
                  confirmed, stable_key, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 'open', ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            )
            .bind(&id)
            .bind(meeting_id)
            .bind(&candidate.text)
            .bind(&candidate.owner)
            .bind(&candidate.due_text)
            .bind(candidate.commitment_state.as_deref().unwrap_or("detected"))
            .bind(&key)
            .execute(pool)
            .await
            .map_err(|error| format!("Failed to save detected action: {error}"))?;
            if inserted.rows_affected() > 0 {
                if let Some(evidence) = candidate.evidence.as_ref() {
                    insert_evidence(pool, meeting_id, None, Some(&id), evidence).await?;
                }
            }
        } else {
            let id = Uuid::new_v4().to_string();
            let key = stable_key(candidate.kind, &candidate.text);
            let inserted = sqlx::query(
                "INSERT OR IGNORE INTO meeting_facts
                 (id, meeting_id, kind, text, state, confidence, confirmed, stable_key,
                  created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            )
            .bind(&id)
            .bind(meeting_id)
            .bind(candidate.kind)
            .bind(&candidate.text)
            .bind(&candidate.state)
            .bind(candidate.confidence)
            .bind(&key)
            .execute(pool)
            .await
            .map_err(|error| format!("Failed to save detected meeting fact: {error}"))?;
            if inserted.rows_affected() > 0 {
                if let Some(evidence) = candidate.evidence.as_ref() {
                    insert_evidence(pool, meeting_id, Some(&id), None, evidence).await?;
                }
            }
        }
    }

    invalidate_meeting_memory(pool, meeting_id).await?;
    Ok(())
}

async fn load_context(pool: &SqlitePool, meeting_id: &str) -> Result<MeetingContext, String> {
    let row = sqlx::query(
        "SELECT project, client, participants_json, agenda
         FROM meeting_contexts WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("Failed to load meeting context: {error}"))?;

    let Some(row) = row else {
        return Ok(MeetingContext::default());
    };
    let participants_json = row
        .try_get::<String, _>("participants_json")
        .unwrap_or_else(|_| "[]".to_string());
    let participants = serde_json::from_str::<Vec<String>>(&participants_json).unwrap_or_default();
    Ok(MeetingContext {
        project: row.try_get::<Option<String>, _>("project").unwrap_or(None),
        client: row.try_get::<Option<String>, _>("client").unwrap_or(None),
        participants,
        agenda: row.try_get::<Option<String>, _>("agenda").unwrap_or(None),
    })
}

async fn load_evidence_for(
    pool: &SqlitePool,
    fact_id: Option<&str>,
    action_id: Option<&str>,
) -> Result<Vec<EvidenceReference>, String> {
    let rows = if let Some(fact_id) = fact_id {
        sqlx::query(
            "SELECT id, meeting_id, source_kind, transcript_id, transcript_revision, quote, audio_start_time,
                    audio_end_time, speaker_label
             FROM meeting_evidence WHERE fact_id = ? ORDER BY created_at ASC",
        )
        .bind(fact_id)
        .fetch_all(pool)
        .await
    } else if let Some(action_id) = action_id {
        sqlx::query(
            "SELECT id, meeting_id, source_kind, transcript_id, transcript_revision, quote, audio_start_time,
                    audio_end_time, speaker_label
             FROM meeting_evidence WHERE action_id = ? ORDER BY created_at ASC",
        )
        .bind(action_id)
        .fetch_all(pool)
        .await
    } else {
        Ok(Vec::new())
    }
    .map_err(|error| format!("Failed to load evidence: {error}"))?;

    Ok(rows
        .into_iter()
        .map(|row| EvidenceReference {
            id: row.get::<String, _>("id"),
            meeting_id: row.get::<String, _>("meeting_id"),
            source_kind: row.get::<String, _>("source_kind"),
            transcript_id: row
                .try_get::<Option<String>, _>("transcript_id")
                .unwrap_or(None),
            transcript_revision: row.try_get::<i64, _>("transcript_revision").unwrap_or(1),
            quote: row.get::<String, _>("quote"),
            audio_start_time: row
                .try_get::<Option<f64>, _>("audio_start_time")
                .unwrap_or(None),
            audio_end_time: row
                .try_get::<Option<f64>, _>("audio_end_time")
                .unwrap_or(None),
            speaker_label: row
                .try_get::<Option<String>, _>("speaker_label")
                .unwrap_or(None),
        })
        .collect())
}

async fn load_intelligence(
    pool: &SqlitePool,
    meeting_id: &str,
    refresh_when_empty: bool,
) -> Result<MeetingIntelligenceResponse, String> {
    ensure_meeting_exists(pool, meeting_id).await?;
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT (SELECT COUNT(*) FROM meeting_facts WHERE meeting_id = ?) +
                (SELECT COUNT(*) FROM meeting_actions WHERE meeting_id = ?)",
    )
    .bind(meeting_id)
    .bind(meeting_id)
    .fetch_one(pool)
    .await
    .map_err(|error| format!("Failed to inspect meeting intelligence: {error}"))?;
    if count == 0 && refresh_when_empty {
        refresh_meeting_intelligence(pool, meeting_id).await?;
    }

    let fact_rows = sqlx::query(
        "SELECT id, kind, text, state, confidence, confirmed
         FROM meeting_facts WHERE meeting_id = ? AND state <> 'dismissed'
         ORDER BY CASE kind WHEN 'outcome' THEN 0 WHEN 'decision' THEN 1 ELSE 2 END,
                  confirmed DESC, confidence DESC, created_at ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("Failed to load meeting facts: {error}"))?;

    let mut outcome = None;
    let mut decisions = Vec::new();
    let mut open_questions = Vec::new();
    for row in fact_rows {
        let id = row.get::<String, _>("id");
        let fact = MeetingFact {
            evidence: load_evidence_for(pool, Some(&id), None).await?,
            id,
            kind: row.get::<String, _>("kind"),
            text: row.get::<String, _>("text"),
            state: row.get::<String, _>("state"),
            confidence: row.try_get::<f64, _>("confidence").unwrap_or(0.0),
            confirmed: row.try_get::<i64, _>("confirmed").unwrap_or(0) != 0,
        };
        match fact.kind.as_str() {
            "outcome" if outcome.is_none() => outcome = Some(fact),
            "decision" => decisions.push(fact),
            "open_question" => open_questions.push(fact),
            _ => {}
        }
    }

    let action_rows = sqlx::query(
        "SELECT id, text, owner, due_at, due_text, status, commitment_state, confirmed
         FROM meeting_actions WHERE meeting_id = ? AND status <> 'dismissed'
         ORDER BY confirmed DESC, CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("Failed to load meeting actions: {error}"))?;
    let mut actions = Vec::new();
    for row in action_rows {
        let id = row.get::<String, _>("id");
        actions.push(MeetingAction {
            evidence: load_evidence_for(pool, None, Some(&id)).await?,
            id,
            text: row.get::<String, _>("text"),
            owner: row.try_get::<Option<String>, _>("owner").unwrap_or(None),
            due_at: row.try_get::<Option<String>, _>("due_at").unwrap_or(None),
            due_text: row.try_get::<Option<String>, _>("due_text").unwrap_or(None),
            status: row.get::<String, _>("status"),
            commitment_state: row.get::<String, _>("commitment_state"),
            confirmed: row.try_get::<i64, _>("confirmed").unwrap_or(0) != 0,
        });
    }

    Ok(MeetingIntelligenceResponse {
        meeting_id: meeting_id.to_string(),
        context: load_context(pool, meeting_id).await?,
        outcome,
        decisions,
        open_questions,
        actions,
    })
}

async fn invalidate_meeting_memory(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM meeting_memory_state WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(pool)
        .await
        .map_err(|error| format!("Failed to invalidate meeting memory: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn api_refresh_meeting_intelligence(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<MeetingIntelligenceResponse, String> {
    let meeting_id = meeting_id.trim();
    if meeting_id.is_empty() {
        return Err("meeting_id cannot be empty".to_string());
    }
    refresh_meeting_intelligence(state.db_manager.pool(), meeting_id).await?;
    load_intelligence(state.db_manager.pool(), meeting_id, false).await
}

#[tauri::command]
pub async fn api_get_meeting_intelligence(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<MeetingIntelligenceResponse, String> {
    let meeting_id = meeting_id.trim();
    if meeting_id.is_empty() {
        return Err("meeting_id cannot be empty".to_string());
    }
    load_intelligence(state.db_manager.pool(), meeting_id, true).await
}

#[tauri::command]
pub async fn api_save_meeting_context(
    state: State<'_, AppState>,
    meeting_id: String,
    context: MeetingContext,
) -> Result<MeetingContext, String> {
    let meeting_id = meeting_id.trim();
    ensure_meeting_exists(state.db_manager.pool(), meeting_id).await?;
    let project = clean_optional(context.project);
    let client = clean_optional(context.client);
    let agenda = clean_optional(context.agenda);
    let participants: Vec<String> = context
        .participants
        .into_iter()
        .filter_map(|participant| clean_optional(Some(participant)))
        .collect();
    let participants_json = serde_json::to_string(&participants)
        .map_err(|error| format!("Failed to encode participants: {error}"))?;

    sqlx::query(
        "INSERT INTO meeting_contexts
         (meeting_id, project, client, participants_json, agenda, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(meeting_id) DO UPDATE SET
           project = excluded.project,
           client = excluded.client,
           participants_json = excluded.participants_json,
           agenda = excluded.agenda,
           updated_at = CURRENT_TIMESTAMP",
    )
    .bind(meeting_id)
    .bind(&project)
    .bind(&client)
    .bind(&participants_json)
    .bind(&agenda)
    .execute(state.db_manager.pool())
    .await
    .map_err(|error| format!("Failed to save meeting context: {error}"))?;

    sqlx::query("UPDATE meetings SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(meeting_id)
        .execute(state.db_manager.pool())
        .await
        .map_err(|error| format!("Failed to touch meeting after context update: {error}"))?;
    invalidate_meeting_memory(state.db_manager.pool(), meeting_id).await?;

    Ok(MeetingContext {
        project,
        client,
        participants,
        agenda,
    })
}

#[tauri::command]
pub async fn api_set_meeting_fact_confirmed(
    state: State<'_, AppState>,
    fact_id: String,
    confirmed: bool,
) -> Result<(), String> {
    let meeting_id = sqlx::query_scalar::<_, String>(
        "SELECT meeting_id FROM meeting_facts WHERE id = ?",
    )
    .bind(&fact_id)
    .fetch_optional(state.db_manager.pool())
    .await
    .map_err(|error| format!("Failed to find meeting fact: {error}"))?
    .ok_or_else(|| format!("Meeting fact not found: {fact_id}"))?;

    sqlx::query(
        "UPDATE meeting_facts SET confirmed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(confirmed)
    .bind(&fact_id)
    .execute(state.db_manager.pool())
    .await
    .map_err(|error| format!("Failed to update meeting fact: {error}"))?;
    sqlx::query("UPDATE meetings SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(&meeting_id)
        .execute(state.db_manager.pool())
        .await
        .map_err(|error| format!("Failed to touch meeting after fact update: {error}"))?;
    invalidate_meeting_memory(state.db_manager.pool(), &meeting_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn api_dismiss_meeting_fact(
    state: State<'_, AppState>,
    fact_id: String,
) -> Result<(), String> {
    let meeting_id = sqlx::query_scalar::<_, String>(
        "SELECT meeting_id FROM meeting_facts WHERE id = ?",
    )
    .bind(&fact_id)
    .fetch_optional(state.db_manager.pool())
    .await
    .map_err(|error| format!("Failed to find meeting fact: {error}"))?
    .ok_or_else(|| format!("Meeting fact not found: {fact_id}"))?;

    // A dismissed row is pinned as reviewed so later summary regeneration cannot
    // recreate the same stable key and surface a claim the user already rejected.
    sqlx::query(
        "UPDATE meeting_facts
         SET state = 'dismissed', confirmed = 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?",
    )
    .bind(&fact_id)
    .execute(state.db_manager.pool())
    .await
    .map_err(|error| format!("Failed to dismiss meeting fact: {error}"))?;
    sqlx::query("UPDATE meetings SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(&meeting_id)
        .execute(state.db_manager.pool())
        .await
        .map_err(|error| format!("Failed to touch meeting after fact dismissal: {error}"))?;
    invalidate_meeting_memory(state.db_manager.pool(), &meeting_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn api_update_meeting_action(
    state: State<'_, AppState>,
    update: MeetingActionUpdate,
) -> Result<MeetingAction, String> {
    let text = update.text.trim();
    if text.is_empty() {
        return Err("Action text cannot be empty".to_string());
    }
    if !matches!(update.status.as_str(), "open" | "done" | "dismissed") {
        return Err("Action status must be open, done, or dismissed".to_string());
    }
    if !matches!(
        update.commitment_state.as_str(),
        "detected" | "proposed" | "agreed"
    ) {
        return Err("Commitment state must be detected, proposed, or agreed".to_string());
    }

    let meeting_id = sqlx::query_scalar::<_, String>(
        "SELECT meeting_id FROM meeting_actions WHERE id = ?",
    )
    .bind(&update.action_id)
    .fetch_optional(state.db_manager.pool())
    .await
    .map_err(|error| format!("Failed to find action: {error}"))?
    .ok_or_else(|| format!("Action not found: {}", update.action_id))?;

    let action_id = update.action_id.clone();
    let normalized_text = text.to_string();
    let owner = clean_optional(update.owner.clone());
    let due_at = clean_optional(update.due_at.clone());
    let due_text = clean_optional(update.due_text.clone());
    let status = update.status.clone();
    let commitment_state = update.commitment_state.clone();

    sqlx::query(
        "UPDATE meeting_actions
         SET text = ?, owner = ?, due_at = ?, due_text = ?, status = ?,
             commitment_state = ?, confirmed = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?",
    )
    .bind(&normalized_text)
    .bind(&owner)
    .bind(&due_at)
    .bind(&due_text)
    .bind(&status)
    .bind(&commitment_state)
    .bind(update.confirmed)
    .bind(&action_id)
    .execute(state.db_manager.pool())
    .await
    .map_err(|error| format!("Failed to update action: {error}"))?;

    sqlx::query("UPDATE meetings SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(&meeting_id)
        .execute(state.db_manager.pool())
        .await
        .map_err(|error| format!("Failed to touch meeting after action update: {error}"))?;
    invalidate_meeting_memory(state.db_manager.pool(), &meeting_id).await?;

    if status == "dismissed" {
        return Ok(MeetingAction {
            id: action_id.clone(),
            text: normalized_text,
            owner,
            due_at,
            due_text,
            status,
            commitment_state,
            confirmed: update.confirmed,
            evidence: load_evidence_for(state.db_manager.pool(), None, Some(&action_id)).await?,
        });
    }

    let intelligence = load_intelligence(state.db_manager.pool(), &meeting_id, false).await?;
    intelligence
        .actions
        .into_iter()
        .find(|action| action.id == action_id)
        .ok_or_else(|| "Updated action could not be reloaded".to_string())
}

async fn refresh_recent_missing(pool: &SqlitePool) -> Result<(), String> {
    let meeting_ids = sqlx::query_scalar::<_, String>(
        "SELECT m.id
         FROM meetings m
         WHERE m.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM meeting_facts f WHERE f.meeting_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM meeting_actions a WHERE a.meeting_id = m.id)
           AND EXISTS (SELECT 1 FROM transcripts t WHERE t.meeting_id = m.id)
         ORDER BY m.created_at DESC
         LIMIT 12",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("Failed to find unindexed meetings: {error}"))?;

    for meeting_id in meeting_ids {
        if let Err(error) = refresh_meeting_intelligence(pool, &meeting_id).await {
            log::warn!(
                "Could not derive intelligence for meeting {} while building action inbox: {}",
                meeting_id,
                error
            );
        }
    }
    Ok(())
}

async fn inbox_item_from_row(pool: &SqlitePool, row: sqlx::sqlite::SqliteRow) -> Result<ActionInboxItem, String> {
    let action_id = row.get::<String, _>("action_id");
    Ok(ActionInboxItem {
        action: MeetingAction {
            evidence: load_evidence_for(pool, None, Some(&action_id)).await?,
            id: action_id,
            text: row.get::<String, _>("text"),
            owner: row.try_get::<Option<String>, _>("owner").unwrap_or(None),
            due_at: row.try_get::<Option<String>, _>("due_at").unwrap_or(None),
            due_text: row.try_get::<Option<String>, _>("due_text").unwrap_or(None),
            status: row.get::<String, _>("status"),
            commitment_state: row.get::<String, _>("commitment_state"),
            confirmed: row.try_get::<i64, _>("confirmed").unwrap_or(0) != 0,
        },
        meeting_id: row.get::<String, _>("meeting_id"),
        meeting_title: row.get::<String, _>("meeting_title"),
        meeting_created_at: row.get::<String, _>("meeting_created_at"),
        project: row.try_get::<Option<String>, _>("project").unwrap_or(None),
        client: row.try_get::<Option<String>, _>("client").unwrap_or(None),
    })
}

#[tauri::command]
pub async fn api_get_action_inbox(
    state: State<'_, AppState>,
) -> Result<ActionInboxResponse, String> {
    refresh_recent_missing(state.db_manager.pool()).await?;
    let rows = sqlx::query(
        "SELECT a.id AS action_id, a.meeting_id, a.text, a.owner, a.due_at, a.due_text,
                a.status, a.commitment_state, a.confirmed,
                m.title AS meeting_title, CAST(m.created_at AS TEXT) AS meeting_created_at,
                c.project, c.client
         FROM meeting_actions a
         JOIN meetings m ON m.id = a.meeting_id
         LEFT JOIN meeting_contexts c ON c.meeting_id = a.meeting_id
         WHERE m.deleted_at IS NULL AND a.status <> 'dismissed'
         ORDER BY a.confirmed ASC,
                  CASE a.status WHEN 'open' THEN 0 ELSE 1 END,
                  CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END,
                  a.due_at ASC,
                  m.created_at DESC",
    )
    .fetch_all(state.db_manager.pool())
    .await
    .map_err(|error| format!("Failed to load action inbox: {error}"))?;

    let mut needs_review = Vec::new();
    let mut open = Vec::new();
    let mut done_recent = Vec::new();
    for row in rows {
        let item = inbox_item_from_row(state.db_manager.pool(), row).await?;
        if !item.action.confirmed {
            if needs_review.len() < 50 {
                needs_review.push(item);
            }
        } else if item.action.status == "open" {
            if open.len() < 100 {
                open.push(item);
            }
        } else if done_recent.len() < 20 {
            done_recent.push(item);
        }
    }

    Ok(ActionInboxResponse {
        needs_review,
        open,
        done_recent,
    })
}

#[tauri::command]
pub async fn api_generate_followup_draft(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<FollowupDraft, String> {
    let meeting_id = meeting_id.trim();
    let intelligence = load_intelligence(state.db_manager.pool(), meeting_id, true).await?;
    let title = sqlx::query_scalar::<_, String>("SELECT title FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_one(state.db_manager.pool())
        .await
        .map_err(|error| format!("Failed to load meeting title: {error}"))?;

    let decisions: Vec<&MeetingFact> = intelligence
        .decisions
        .iter()
        .filter(|fact| fact.confirmed)
        .collect();
    let actions: Vec<&MeetingAction> = intelligence
        .actions
        .iter()
        .filter(|action| {
            action.confirmed
                && action.status == "open"
                && action.commitment_state == "agreed"
        })
        .collect();
    let proposals: Vec<&MeetingAction> = intelligence
        .actions
        .iter()
        .filter(|action| {
            action.confirmed
                && action.status == "open"
                && action.commitment_state == "proposed"
        })
        .collect();
    let questions: Vec<&MeetingFact> = intelligence
        .open_questions
        .iter()
        .filter(|fact| fact.confirmed)
        .collect();

    let mut body = String::from("Thanks everyone. Here is my readout from the meeting.\n\n");
    if !decisions.is_empty() {
        body.push_str("Decisions\n");
        for decision in &decisions {
            body.push_str("- ");
            body.push_str(decision.text.trim());
            body.push('\n');
        }
        body.push('\n');
    }
    if !actions.is_empty() {
        body.push_str("Actions\n");
        for action in &actions {
            body.push_str("- ");
            if let Some(owner) = action.owner.as_deref() {
                body.push_str(owner);
                body.push_str(" — ");
            }
            body.push_str(action.text.trim());
            if let Some(due) = action.due_at.as_deref().or(action.due_text.as_deref()) {
                body.push_str(" (due ");
                body.push_str(due);
                body.push(')');
            }
            body.push('\n');
        }
        body.push('\n');
    } else {
        body.push_str("Actions\n- No confirmed commitments yet.\n\n");
    }
    if !proposals.is_empty() {
        body.push_str("Proposed follow-ups (not commitments)\n");
        for proposal in &proposals {
            body.push_str("- ");
            body.push_str(proposal.text.trim());
            body.push('\n');
        }
        body.push('\n');
    }
    if !questions.is_empty() {
        body.push_str("Open questions\n");
        for question in &questions {
            body.push_str("- ");
            body.push_str(question.text.trim());
            body.push('\n');
        }
        body.push('\n');
    }
    body.push_str("Please reply if I missed or misrepresented anything.");

    Ok(FollowupDraft {
        subject: format!("Follow-up — {title}"),
        body,
        source_action_ids: actions
            .into_iter()
            .chain(proposals.into_iter())
            .map(|action| action.id.clone())
            .collect(),
        source_fact_ids: decisions
            .into_iter()
            .chain(questions.into_iter())
            .map(|fact| fact.id.clone())
            .collect(),
    })
}

fn memory_vector(text: &str) -> Vec<(usize, f32)> {
    let tokens = terms(text);
    let mut weights: HashMap<usize, f32> = HashMap::new();
    for token in &tokens {
        let hash = u64::from_str_radix(&stable_hash(token), 16).unwrap_or_default();
        let index = (hash as usize) % MEMORY_VECTOR_DIM;
        *weights.entry(index).or_insert(0.0) += 1.0;
    }
    for window in tokens.windows(2) {
        let bigram = format!("{} {}", window[0], window[1]);
        let hash = u64::from_str_radix(&stable_hash(&bigram), 16).unwrap_or_default();
        let index = (hash as usize) % MEMORY_VECTOR_DIM;
        *weights.entry(index).or_insert(0.0) += 0.55;
    }
    let norm = weights
        .values()
        .map(|value| (*value as f64) * (*value as f64))
        .sum::<f64>()
        .sqrt() as f32;
    let mut vector: Vec<(usize, f32)> = weights
        .into_iter()
        .map(|(index, value)| (index, if norm > 0.0 { value / norm } else { value }))
        .collect();
    vector.sort_by_key(|(index, _)| *index);
    vector
}

fn cosine(left: &[(usize, f32)], right: &[(usize, f32)]) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let mut left_index = 0usize;
    let mut right_index = 0usize;
    let mut score = 0.0_f64;
    while left_index < left.len() && right_index < right.len() {
        match left[left_index].0.cmp(&right[right_index].0) {
            Ordering::Equal => {
                score += (left[left_index].1 as f64) * (right[right_index].1 as f64);
                left_index += 1;
                right_index += 1;
            }
            Ordering::Less => left_index += 1,
            Ordering::Greater => right_index += 1,
        }
    }
    score
}

fn token_overlap(query: &str, content: &str) -> f64 {
    let query_terms = term_set(query);
    let content_terms = term_set(content);
    if query_terms.is_empty() || content_terms.is_empty() {
        return 0.0;
    }
    query_terms.intersection(&content_terms).count() as f64 / query_terms.len() as f64
}

async fn build_source_documents(
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<(Vec<SourceDocument>, MeetingContext), String> {
    let context = load_context(pool, meeting_id).await?;
    let mut documents = Vec::new();
    for transcript in fetch_transcripts(pool, meeting_id).await? {
        documents.push(SourceDocument {
            kind: "transcript".to_string(),
            source_id: transcript.id.clone(),
            content: transcript.text,
            transcript_id: Some(transcript.id),
            audio_start_time: transcript.start,
            audio_end_time: transcript.end,
            speaker_label: transcript.speaker_label,
        });
    }

    if let Some(notes) = sqlx::query_scalar::<_, Option<String>>(
        "SELECT notes_markdown FROM meetings WHERE id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("Failed to load meeting notes for memory: {error}"))?
    .flatten()
    .and_then(|notes| clean_optional(Some(notes)))
    {
        documents.push(SourceDocument {
            kind: "notes".to_string(),
            source_id: "meeting-notes".to_string(),
            content: notes,
            transcript_id: None,
            audio_start_time: None,
            audio_end_time: None,
            speaker_label: None,
        });
    }

    if let Some(manual_notes) = sqlx::query_scalar::<_, String>(
        "SELECT content FROM meeting_manual_notes WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("Failed to load manual notes for memory: {error}"))?
    .and_then(|notes| clean_optional(Some(notes)))
    {
        documents.push(SourceDocument {
            kind: "manual_notes".to_string(),
            source_id: "manual-notes".to_string(),
            content: manual_notes,
            transcript_id: None,
            audio_start_time: None,
            audio_end_time: None,
            speaker_label: None,
        });
    }

    let context_text = [
        context.project.as_ref().map(|value| format!("Project: {value}.")),
        context.client.as_ref().map(|value| format!("Client: {value}.")),
        (!context.participants.is_empty()).then(|| format!("Participants: {}.", context.participants.join(", "))),
        context.agenda.as_ref().map(|value| format!("Agenda: {value}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    if !context_text.is_empty() {
        documents.push(SourceDocument {
            kind: "context".to_string(),
            source_id: "meeting-context".to_string(),
            content: context_text,
            transcript_id: None,
            audio_start_time: None,
            audio_end_time: None,
            speaker_label: None,
        });
    }

    let facts = sqlx::query(
        "SELECT f.id, f.kind, f.text, e.transcript_id, e.audio_start_time,
                e.audio_end_time, e.speaker_label
         FROM meeting_facts f
         LEFT JOIN meeting_evidence e ON e.id = (
             SELECT e1.id FROM meeting_evidence e1 WHERE e1.fact_id = f.id
             ORDER BY e1.created_at ASC LIMIT 1
         )
         WHERE f.meeting_id = ? AND f.state <> 'dismissed' AND f.confirmed = 1",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("Failed to load facts for memory: {error}"))?;
    for row in facts {
        documents.push(SourceDocument {
            kind: row.get::<String, _>("kind"),
            source_id: row.get::<String, _>("id"),
            content: row.get::<String, _>("text"),
            transcript_id: row.try_get::<Option<String>, _>("transcript_id").unwrap_or(None),
            audio_start_time: row.try_get::<Option<f64>, _>("audio_start_time").unwrap_or(None),
            audio_end_time: row.try_get::<Option<f64>, _>("audio_end_time").unwrap_or(None),
            speaker_label: row.try_get::<Option<String>, _>("speaker_label").unwrap_or(None),
        });
    }

    let actions = sqlx::query(
        "SELECT a.id, a.text, a.owner, a.due_at, a.due_text,
                e.transcript_id, e.audio_start_time, e.audio_end_time, e.speaker_label
         FROM meeting_actions a
         LEFT JOIN meeting_evidence e ON e.id = (
             SELECT e1.id FROM meeting_evidence e1 WHERE e1.action_id = a.id
             ORDER BY e1.created_at ASC LIMIT 1
         )
         WHERE a.meeting_id = ? AND a.status <> 'dismissed' AND a.confirmed = 1",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("Failed to load actions for memory: {error}"))?;
    for row in actions {
        let mut content = row.get::<String, _>("text");
        if let Some(owner) = row.try_get::<Option<String>, _>("owner").unwrap_or(None) {
            content.push_str(&format!(" Owner: {owner}."));
        }
        if let Some(due) = row
            .try_get::<Option<String>, _>("due_at")
            .unwrap_or(None)
            .or_else(|| row.try_get::<Option<String>, _>("due_text").unwrap_or(None))
        {
            content.push_str(&format!(" Due: {due}."));
        }
        documents.push(SourceDocument {
            kind: "action".to_string(),
            source_id: row.get::<String, _>("id"),
            content,
            transcript_id: row.try_get::<Option<String>, _>("transcript_id").unwrap_or(None),
            audio_start_time: row.try_get::<Option<f64>, _>("audio_start_time").unwrap_or(None),
            audio_end_time: row.try_get::<Option<f64>, _>("audio_end_time").unwrap_or(None),
            speaker_label: row.try_get::<Option<String>, _>("speaker_label").unwrap_or(None),
        });
    }

    Ok((documents, context))
}

async fn index_meeting_memory(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    let (documents, context) = build_source_documents(pool, meeting_id).await?;
    if documents.is_empty() {
        return Ok(());
    }
    let source_material = documents
        .iter()
        .map(|document| format!("{}:{}:{}", document.kind, document.source_id, document.content))
        .collect::<Vec<_>>()
        .join("\u{1f}");
    let source_hash = stable_hash(&format!("vector-v{MEMORY_VECTOR_VERSION}:{source_material}"));
    let current_hash = sqlx::query_scalar::<_, String>(
        "SELECT source_hash FROM meeting_memory_state WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("Failed to inspect memory index state: {error}"))?;
    if current_hash.as_deref() == Some(source_hash.as_str()) {
        return Ok(());
    }

    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("Failed to start memory index transaction: {error}"))?;
    sqlx::query("DELETE FROM meeting_memory_documents WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to reset meeting memory index: {error}"))?;

    for document in documents {
        let vector_json = serde_json::to_string(&memory_vector(&document.content))
            .map_err(|error| format!("Failed to encode local memory vector: {error}"))?;
        sqlx::query(
            "INSERT INTO meeting_memory_documents
             (id, meeting_id, kind, source_id, content, vector_json, project, client,
              transcript_id, audio_start_time, audio_end_time, speaker_label, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(meeting_id)
        .bind(document.kind)
        .bind(document.source_id)
        .bind(document.content)
        .bind(vector_json)
        .bind(context.project.as_deref())
        .bind(context.client.as_deref())
        .bind(document.transcript_id)
        .bind(document.audio_start_time)
        .bind(document.audio_end_time)
        .bind(document.speaker_label)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to write local memory document: {error}"))?;
    }

    sqlx::query(
        "INSERT INTO meeting_memory_state (meeting_id, source_hash, indexed_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(meeting_id) DO UPDATE SET
           source_hash = excluded.source_hash,
           indexed_at = CURRENT_TIMESTAMP",
    )
    .bind(meeting_id)
    .bind(source_hash)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("Failed to save memory index state: {error}"))?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit memory index: {error}"))?;
    Ok(())
}

async fn scope_value_from_meeting(
    pool: &SqlitePool,
    meeting_id: Option<&str>,
    field: &str,
) -> Result<Option<String>, String> {
    let Some(meeting_id) = meeting_id else {
        return Ok(None);
    };
    let context = load_context(pool, meeting_id).await?;
    Ok(match field {
        "project" => context.project,
        "client" => context.client,
        _ => None,
    })
}

async fn scoped_meeting_ids(
    pool: &SqlitePool,
    request: &MemorySearchRequest,
) -> Result<(Vec<String>, String), String> {
    match request.scope.as_str() {
        "meeting" => {
            let meeting_id = request
                .meeting_id
                .as_deref()
                .ok_or_else(|| "Meeting scope requires meetingId".to_string())?;
            ensure_meeting_exists(pool, meeting_id).await?;
            Ok((vec![meeting_id.to_string()], "This meeting".to_string()))
        }
        "project" => {
            let project = clean_optional(request.project.clone())
                .or(scope_value_from_meeting(pool, request.meeting_id.as_deref(), "project").await?)
                .ok_or_else(|| "Add a project to the meeting before using project recall".to_string())?;
            let ids = sqlx::query_scalar::<_, String>(
                "SELECT c.meeting_id FROM meeting_contexts c
                 JOIN meetings m ON m.id = c.meeting_id
                 WHERE m.deleted_at IS NULL AND LOWER(c.project) = LOWER(?)
                 ORDER BY m.created_at DESC",
            )
            .bind(&project)
            .fetch_all(pool)
            .await
            .map_err(|error| format!("Failed to load project meetings: {error}"))?;
            Ok((ids, format!("Project · {project}")))
        }
        "client" => {
            let client = clean_optional(request.client.clone())
                .or(scope_value_from_meeting(pool, request.meeting_id.as_deref(), "client").await?)
                .ok_or_else(|| "Add a client to the meeting before using client recall".to_string())?;
            let ids = sqlx::query_scalar::<_, String>(
                "SELECT c.meeting_id FROM meeting_contexts c
                 JOIN meetings m ON m.id = c.meeting_id
                 WHERE m.deleted_at IS NULL AND LOWER(c.client) = LOWER(?)
                 ORDER BY m.created_at DESC",
            )
            .bind(&client)
            .fetch_all(pool)
            .await
            .map_err(|error| format!("Failed to load client meetings: {error}"))?;
            Ok((ids, format!("Client · {client}")))
        }
        "all" => {
            let ids = sqlx::query_scalar::<_, String>(
                "SELECT id FROM meetings WHERE deleted_at IS NULL ORDER BY created_at DESC",
            )
            .fetch_all(pool)
            .await
            .map_err(|error| format!("Failed to load meeting library for recall: {error}"))?;
            Ok((ids, "All meetings".to_string()))
        }
        _ => Err("Recall scope must be meeting, project, client, or all".to_string()),
    }
}

fn snippet_for_query(content: &str, query: &str) -> String {
    const MAX_CHARS: usize = 320;
    let chars: Vec<char> = content.chars().collect();
    if chars.len() <= MAX_CHARS {
        return content.trim().to_string();
    }

    // Search over character windows rather than slicing by byte offsets. Unicode
    // case folding can change byte lengths, and meeting transcripts are multilingual.
    let query_terms = term_set(query);
    let window = MAX_CHARS;
    let step = MAX_CHARS / 4;
    let mut best_start = 0usize;
    let mut best_score = 0.0_f64;
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + window).min(chars.len());
        let candidate: String = chars[start..end].iter().collect();
        let candidate_terms = term_set(&candidate);
        let shared = query_terms.intersection(&candidate_terms).count() as f64;
        let score = if query_terms.is_empty() { 0.0 } else { shared / query_terms.len() as f64 };
        if score > best_score {
            best_score = score;
            best_start = start;
        }
        if end == chars.len() {
            break;
        }
        start += step;
    }

    let end = (best_start + MAX_CHARS).min(chars.len());
    let mut snippet: String = chars[best_start..end].iter().collect();
    if best_start > 0 {
        snippet.insert_str(0, "…");
    }
    if end < chars.len() {
        snippet.push('…');
    }
    snippet.trim().to_string()
}

#[tauri::command]
pub async fn api_search_meeting_memory(
    state: State<'_, AppState>,
    request: MemorySearchRequest,
) -> Result<MemorySearchResponse, String> {
    let query = request.query.trim();
    if query.len() < 2 {
        return Err("Ask a more specific question".to_string());
    }
    let (meeting_ids, scope_label) = scoped_meeting_ids(state.db_manager.pool(), &request).await?;
    if meeting_ids.is_empty() {
        return Ok(MemorySearchResponse {
            answer: "No meetings are linked to this scope yet.".to_string(),
            scope_label,
            hits: Vec::new(),
        });
    }

    for meeting_id in &meeting_ids {
        if let Err(error) = index_meeting_memory(state.db_manager.pool(), meeting_id).await {
            log::warn!("Could not index meeting {} for local recall: {}", meeting_id, error);
        }
    }

    let allowed: HashSet<&str> = meeting_ids.iter().map(String::as_str).collect();
    let query_vector = memory_vector(query);
    let rows = sqlx::query(
        "SELECT d.meeting_id, m.title AS meeting_title, d.kind, d.source_id, d.content,
                d.vector_json, d.transcript_id, d.audio_start_time, d.audio_end_time,
                d.speaker_label, d.project, d.client
         FROM meeting_memory_documents d
         JOIN meetings m ON m.id = d.meeting_id
         WHERE m.deleted_at IS NULL",
    )
    .fetch_all(state.db_manager.pool())
    .await
    .map_err(|error| format!("Failed to search local meeting memory: {error}"))?;

    let mut hits = Vec::new();
    for row in rows {
        let meeting_id = row.get::<String, _>("meeting_id");
        if !allowed.contains(meeting_id.as_str()) {
            continue;
        }
        let vector_json = row.get::<String, _>("vector_json");
        let vector = serde_json::from_str::<Vec<(usize, f32)>>(&vector_json).unwrap_or_default();
        let content = row.get::<String, _>("content");
        let vector_score = cosine(&query_vector, &vector).max(0.0);
        let overlap = token_overlap(query, &content);
        let score = vector_score * 0.72 + overlap * 0.28;
        if score <= 0.01 {
            continue;
        }
        hits.push(MemoryHit {
            meeting_id,
            meeting_title: row.get::<String, _>("meeting_title"),
            kind: row.get::<String, _>("kind"),
            source_id: row.get::<String, _>("source_id"),
            snippet: snippet_for_query(&content, query),
            score,
            transcript_id: row
                .try_get::<Option<String>, _>("transcript_id")
                .unwrap_or(None),
            audio_start_time: row
                .try_get::<Option<f64>, _>("audio_start_time")
                .unwrap_or(None),
            audio_end_time: row
                .try_get::<Option<f64>, _>("audio_end_time")
                .unwrap_or(None),
            speaker_label: row
                .try_get::<Option<String>, _>("speaker_label")
                .unwrap_or(None),
            project: row.try_get::<Option<String>, _>("project").unwrap_or(None),
            client: row.try_get::<Option<String>, _>("client").unwrap_or(None),
        });
    }
    hits.sort_by(|left, right| right.score.partial_cmp(&left.score).unwrap_or(Ordering::Equal));
    // Prefer one result per exact transcript turn. Reviewed facts/actions may point
    // to the same evidence and should not crowd out distinct supporting passages.
    let mut seen_sources = HashSet::new();
    hits.retain(|hit| {
        let key = match hit.transcript_id.as_deref() {
            Some(transcript_id) => format!("{}:transcript:{}", hit.meeting_id, transcript_id),
            None => format!("{}:{}:{}", hit.meeting_id, hit.kind, hit.source_id),
        };
        seen_sources.insert(key)
    });
    hits.truncate(request.limit.unwrap_or(12).clamp(1, 30));

    let answer = if hits.is_empty() {
        "I could not find supporting meeting evidence for that question in this scope.".to_string()
    } else {
        let mut answer = String::from("Strongest matching meeting evidence:\n");
        for hit in hits.iter().take(4) {
            answer.push_str("\n- ");
            answer.push_str(&hit.snippet.replace('\n', " "));
            answer.push_str(" — ");
            answer.push_str(&hit.meeting_title);
        }
        answer
    };

    Ok(MemorySearchResponse {
        answer,
        scope_label,
        hits,
    })
}

async fn preparation_fact_rows(
    pool: &SqlitePool,
    meeting_ids: &HashSet<String>,
    kind: &str,
    limit: usize,
) -> Result<Vec<PreparationItem>, String> {
    let rows = sqlx::query(
        "SELECT f.id, f.meeting_id, f.text, f.confirmed, m.title AS meeting_title,
                e.id AS evidence_id, e.source_kind, e.transcript_id, e.transcript_revision, e.quote,
                e.audio_start_time, e.audio_end_time, e.speaker_label
         FROM meeting_facts f
         JOIN meetings m ON m.id = f.meeting_id
         LEFT JOIN meeting_evidence e ON e.id = (
             SELECT e1.id FROM meeting_evidence e1 WHERE e1.fact_id = f.id
             ORDER BY e1.created_at ASC LIMIT 1
         )
         WHERE f.kind = ? AND f.state <> 'dismissed' AND f.confirmed = 1 AND m.deleted_at IS NULL
         ORDER BY f.confirmed DESC, f.confidence DESC, m.created_at DESC",
    )
    .bind(kind)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("Failed to load preparation facts: {error}"))?;
    let mut result = Vec::new();
    for row in rows {
        let meeting_id = row.get::<String, _>("meeting_id");
        if !meeting_ids.contains(&meeting_id) {
            continue;
        }
        let evidence_id = row
            .try_get::<Option<String>, _>("evidence_id")
            .unwrap_or(None);
        let evidence = evidence_id.map(|id| EvidenceReference {
            id,
            meeting_id: meeting_id.clone(),
            source_kind: row
                .try_get::<Option<String>, _>("source_kind")
                .unwrap_or(None)
                .unwrap_or_else(|| "transcript".to_string()),
            transcript_id: row
                .try_get::<Option<String>, _>("transcript_id")
                .unwrap_or(None),
            transcript_revision: row.try_get::<i64, _>("transcript_revision").unwrap_or(1),
            quote: row
                .try_get::<Option<String>, _>("quote")
                .unwrap_or(None)
                .unwrap_or_default(),
            audio_start_time: row
                .try_get::<Option<f64>, _>("audio_start_time")
                .unwrap_or(None),
            audio_end_time: row
                .try_get::<Option<f64>, _>("audio_end_time")
                .unwrap_or(None),
            speaker_label: row
                .try_get::<Option<String>, _>("speaker_label")
                .unwrap_or(None),
        });
        result.push(PreparationItem {
            meeting_id,
            meeting_title: row.get::<String, _>("meeting_title"),
            text: row.get::<String, _>("text"),
            confirmed: row.try_get::<i64, _>("confirmed").unwrap_or(0) != 0,
            evidence,
        });
        if result.len() >= limit {
            break;
        }
    }
    Ok(result)
}

async fn preparation_action_rows(
    pool: &SqlitePool,
    meeting_ids: &HashSet<String>,
    limit: usize,
) -> Result<Vec<PreparationItem>, String> {
    let rows = sqlx::query(
        "SELECT a.id, a.meeting_id, a.text, a.confirmed, m.title AS meeting_title,
                e.id AS evidence_id, e.source_kind, e.transcript_id, e.transcript_revision, e.quote,
                e.audio_start_time, e.audio_end_time, e.speaker_label
         FROM meeting_actions a
         JOIN meetings m ON m.id = a.meeting_id
         LEFT JOIN meeting_evidence e ON e.action_id = a.id
         WHERE a.status = 'open' AND a.confirmed = 1 AND m.deleted_at IS NULL
         ORDER BY a.confirmed DESC,
                  CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END,
                  a.due_at ASC,
                  m.created_at DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("Failed to load preparation actions: {error}"))?;
    let mut result = Vec::new();
    for row in rows {
        let meeting_id = row.get::<String, _>("meeting_id");
        if !meeting_ids.contains(&meeting_id) {
            continue;
        }
        let evidence_id = row
            .try_get::<Option<String>, _>("evidence_id")
            .unwrap_or(None);
        let evidence = evidence_id.map(|id| EvidenceReference {
            id,
            meeting_id: meeting_id.clone(),
            source_kind: row
                .try_get::<Option<String>, _>("source_kind")
                .unwrap_or(None)
                .unwrap_or_else(|| "transcript".to_string()),
            transcript_id: row
                .try_get::<Option<String>, _>("transcript_id")
                .unwrap_or(None),
            transcript_revision: row.try_get::<i64, _>("transcript_revision").unwrap_or(1),
            quote: row
                .try_get::<Option<String>, _>("quote")
                .unwrap_or(None)
                .unwrap_or_default(),
            audio_start_time: row
                .try_get::<Option<f64>, _>("audio_start_time")
                .unwrap_or(None),
            audio_end_time: row
                .try_get::<Option<f64>, _>("audio_end_time")
                .unwrap_or(None),
            speaker_label: row
                .try_get::<Option<String>, _>("speaker_label")
                .unwrap_or(None),
        });
        result.push(PreparationItem {
            meeting_id,
            meeting_title: row.get::<String, _>("meeting_title"),
            text: row.get::<String, _>("text"),
            confirmed: row.try_get::<i64, _>("confirmed").unwrap_or(0) != 0,
            evidence,
        });
        if result.len() >= limit {
            break;
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn api_get_meeting_preparation(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<MeetingPreparationResponse, String> {
    let meeting_id = meeting_id.trim();
    ensure_meeting_exists(state.db_manager.pool(), meeting_id).await?;
    let context = load_context(state.db_manager.pool(), meeting_id).await?;
    let (scope_sql, scope_value, scope_label) = if let Some(project) = context.project.clone() {
        (
            "SELECT c.meeting_id FROM meeting_contexts c JOIN meetings m ON m.id = c.meeting_id WHERE m.deleted_at IS NULL AND c.meeting_id <> ? AND LOWER(c.project) = LOWER(?) ORDER BY m.created_at DESC LIMIT 20",
            project.clone(),
            format!("Project · {project}"),
        )
    } else if let Some(client) = context.client.clone() {
        (
            "SELECT c.meeting_id FROM meeting_contexts c JOIN meetings m ON m.id = c.meeting_id WHERE m.deleted_at IS NULL AND c.meeting_id <> ? AND LOWER(c.client) = LOWER(?) ORDER BY m.created_at DESC LIMIT 20",
            client.clone(),
            format!("Client · {client}"),
        )
    } else {
        return Ok(MeetingPreparationResponse {
            context,
            scope_label: "Add a project or client to link recurring meetings.".to_string(),
            prior_decisions: Vec::new(),
            open_actions: Vec::new(),
            open_questions: Vec::new(),
        });
    };

    let prior_ids = sqlx::query_scalar::<_, String>(scope_sql)
        .bind(meeting_id)
        .bind(scope_value)
        .fetch_all(state.db_manager.pool())
        .await
        .map_err(|error| format!("Failed to load related meetings: {error}"))?;

    for prior_id in &prior_ids {
        let count = sqlx::query_scalar::<_, i64>(
            "SELECT (SELECT COUNT(*) FROM meeting_facts WHERE meeting_id = ?) +
                    (SELECT COUNT(*) FROM meeting_actions WHERE meeting_id = ?)",
        )
        .bind(prior_id)
        .bind(prior_id)
        .fetch_one(state.db_manager.pool())
        .await
        .unwrap_or(0);
        if count == 0 {
            let _ = refresh_meeting_intelligence(state.db_manager.pool(), prior_id).await;
        }
    }
    let prior_set: HashSet<String> = prior_ids.into_iter().collect();
    Ok(MeetingPreparationResponse {
        context,
        scope_label,
        prior_decisions: preparation_fact_rows(
            state.db_manager.pool(),
            &prior_set,
            "decision",
            8,
        )
        .await?,
        open_actions: preparation_action_rows(state.db_manager.pool(), &prior_set, 10).await?,
        open_questions: preparation_fact_rows(
            state.db_manager.pool(),
            &prior_set,
            "open_question",
            8,
        )
        .await?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_test_db() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create test in-memory sqlite db");

        sqlx::query(
            r#"
            CREATE TABLE meetings (
                id TEXT PRIMARY KEY NOT NULL,
                title TEXT NOT NULL,
                notes_markdown TEXT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                deleted_at TEXT NULL
            );
            CREATE TABLE transcripts (
                id TEXT PRIMARY KEY NOT NULL,
                meeting_id TEXT NOT NULL,
                transcript TEXT NOT NULL,
                timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                audio_start_time REAL,
                audio_end_time REAL,
                speaker_label TEXT,
                FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            );
            CREATE TABLE summary_processes (
                meeting_id TEXT PRIMARY KEY NOT NULL,
                status TEXT NOT NULL DEFAULT 'completed',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                result TEXT,
                FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS meeting_manual_notes (
                meeting_id TEXT PRIMARY KEY,
                content TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            "#,
        )
        .execute(&pool)
        .await
        .expect("create base meeting tables");

        let migration_sql = include_str!("../../migrations/20260907163000_meeting_intelligence.sql");
        for statement in migration_sql.split(';') {
            let stmt = statement.trim();
            if !stmt.is_empty() {
                sqlx::query(stmt)
                    .execute(&pool)
                    .await
                    .expect("execute migration statement");
            }
        }

        pool
    }

    #[test]
    fn test_extract_owner_and_due_text() {
        assert_eq!(
            extract_owner("Alice: finalize the migration script"),
            Some("Alice".to_string())
        );
        assert_eq!(
            extract_owner("Bob — review pull request"),
            Some("Bob".to_string())
        );
        assert_eq!(
            extract_owner("Charlie - update docs"),
            Some("Charlie".to_string())
        );
        assert_eq!(extract_owner("Ship the release without an owner"), None);

        assert_eq!(
            extract_due_text("Finish the release by Friday, end of day"),
            Some("Friday".to_string())
        );
        assert_eq!(
            extract_due_text("Feature due 2026-09-15 for staging"),
            Some("2026-09-15 for staging".to_string())
        );
        assert_eq!(
            extract_due_text("Complete checks before next week"),
            Some("next week".to_string())
        );
        assert_eq!(extract_due_text("Just a regular task"), None);
    }

    #[test]
    fn test_explicit_pattern_recognition() {
        assert!(explicit_decision("We decided to keep all models local."));
        assert!(explicit_decision("Let's go with the SQLite migration."));
        assert!(!explicit_decision("Today is sunny outside."));

        assert_eq!(
            explicit_action("I'll take the lead on writing tests."),
            Some("agreed")
        );
        assert_eq!(
            explicit_action("Can you review the pull request?"),
            Some("proposed")
        );
        assert_eq!(explicit_action("Just discussing architecture."), None);

        assert!(explicit_open_question("Should we support offline mode?"));
        assert!(explicit_open_question("Do we have enough memory headroom?"));
        assert!(!explicit_open_question("Is it done?"));
        assert!(!explicit_open_question("Plain statement without question"));
    }

    #[test]
    fn test_parse_summary_candidates() {
        let markdown = r#"
# Outcome
Deliver MeetOdds with local verifiable meetings and memory recall.

# Key Decisions
- Use additive migrations for SQLite schema.
- Preserve all user audio files untouched.

# Action Items
- Sarah: review migration by Friday.
- John — build macOS universal binary.

# Open Questions
- Should we add automated sync to remote storage?
"#;
        let transcripts = vec![
            TranscriptSource {
                id: "t1".to_string(),
                text: "Sarah will review migration by Friday.".to_string(),
                start: Some(10.0),
                end: Some(15.0),
                speaker_label: Some("Speaker 1".to_string()),
            },
            TranscriptSource {
                id: "t2".to_string(),
                text: "We should preserve all user audio files untouched.".to_string(),
                start: Some(20.0),
                end: Some(25.0),
                speaker_label: Some("Speaker 2".to_string()),
            },
        ];

        let candidates = parse_summary_candidates(markdown, &transcripts);
        assert_eq!(candidates.len(), 6);

        let outcome = candidates.iter().find(|c| c.kind == "outcome").unwrap();
        assert!(outcome.text.contains("Deliver MeetOdds"));

        let decisions: Vec<_> = candidates.iter().filter(|c| c.kind == "decision").collect();
        assert_eq!(decisions.len(), 2);
        assert!(decisions.iter().any(|d| d.text.contains("additive migrations")));

        let actions: Vec<_> = candidates.iter().filter(|c| c.kind == "action").collect();
        assert_eq!(actions.len(), 2);
        let sarah = actions.iter().find(|a| a.text.contains("Sarah")).unwrap();
        assert_eq!(sarah.owner.as_deref(), Some("Sarah"));
        assert_eq!(sarah.due_text.as_deref(), Some("Friday"));
        // Transcripts should provide evidence for matched action
        assert!(sarah.evidence.is_some());
        assert_eq!(sarah.evidence.as_ref().unwrap().id, "t1");

        let questions: Vec<_> = candidates.iter().filter(|c| c.kind == "open_question").collect();
        assert_eq!(questions.len(), 1);
        assert!(questions[0].text.contains("remote storage"));
    }

    #[test]
    fn test_memory_vector_and_cosine() {
        let v1 = memory_vector("database migration sqlite query");
        let v2 = memory_vector("database migration sqlite query");
        let v3 = memory_vector("unrelated cooking recipe pancakes syrup");

        let sim_self = cosine(&v1, &v2);
        assert!((sim_self - 1.0).abs() < 1e-4, "Self similarity should be ~1.0: got {sim_self}");

        let sim_diff = cosine(&v1, &v3);
        assert!(sim_diff < 0.1, "Unrelated similarity should be near 0.0: got {sim_diff}");

        let v_partial = memory_vector("sqlite database performance indexing");
        let sim_partial = cosine(&v1, &v_partial);
        assert!(sim_partial > 0.3, "Related terms should have positive similarity: got {sim_partial}");
    }

    #[tokio::test]
    async fn test_refresh_and_confirmation_survival() {
        let pool = setup_test_db().await;

        // Seed meeting
        sqlx::query("INSERT INTO meetings (id, title) VALUES (?, ?)")
            .bind("meeting-100")
            .bind("Sprint Review")
            .execute(&pool)
            .await
            .unwrap();

        // Seed transcript
        sqlx::query(
            "INSERT INTO transcripts (id, meeting_id, transcript, audio_start_time, audio_end_time)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind("t-100")
        .bind("meeting-100")
        .bind("We agreed that local recall is critical. Dave will deploy the update by Tuesday.")
        .bind(0.0)
        .bind(5.0)
        .execute(&pool)
        .await
        .unwrap();

        // Seed initial summary
        let initial_summary = r#"
# Key Decisions
- Local recall is critical for privacy.

# Action Items
- Dave: deploy the update by Tuesday.
"#;
        sqlx::query("INSERT INTO summary_processes (meeting_id, result) VALUES (?, ?)")
            .bind("meeting-100")
            .bind(initial_summary)
            .execute(&pool)
            .await
            .unwrap();

        // Initial refresh
        refresh_meeting_intelligence(&pool, "meeting-100")
            .await
            .expect("refresh intelligence");

        // Verify inserted
        let facts = sqlx::query_as::<_, (String, String, i64)>(
            "SELECT id, text, confirmed FROM meeting_facts WHERE meeting_id = ?",
        )
        .bind("meeting-100")
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(!facts.is_empty());

        let actions = sqlx::query_as::<_, (String, String, i64)>(
            "SELECT id, text, confirmed FROM meeting_actions WHERE meeting_id = ?",
        )
        .bind("meeting-100")
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(actions.len(), 1);
        let action_id = &actions[0].0;

        // User reviews: confirms the action
        sqlx::query("UPDATE meeting_actions SET confirmed = 1 WHERE id = ?")
            .bind(action_id)
            .execute(&pool)
            .await
            .unwrap();

        // User dismisses a fact
        let fact_id = &facts[0].0;
        sqlx::query("UPDATE meeting_facts SET state = 'dismissed', confirmed = 1 WHERE id = ?")
            .bind(fact_id)
            .execute(&pool)
            .await
            .unwrap();

        // Regenerate summary with slightly modified wording and run refresh again
        let regenerated_summary = r#"
# Key Decisions
- Local recall is critical for privacy.
- Audio recordings remain on device.

# Action Items
- Dave: deploy the update by Tuesday.
- Alice: write unit tests.
"#;
        sqlx::query("UPDATE summary_processes SET result = ? WHERE meeting_id = ?")
            .bind(regenerated_summary)
            .bind("meeting-100")
            .execute(&pool)
            .await
            .unwrap();

        refresh_meeting_intelligence(&pool, "meeting-100")
            .await
            .expect("refresh intelligence after regeneration");

        // Verified: The confirmed action survived without being duplicated or reset to unconfirmed!
        let surviving_action = sqlx::query_as::<_, (String, i64, String)>(
            "SELECT id, confirmed, status FROM meeting_actions WHERE id = ?",
        )
        .bind(action_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(surviving_action.1, 1, "Action must stay confirmed");

        // Verified: The dismissed fact survived as dismissed and did not duplicate into a detected unconfirmed fact
        let dismissed_fact = sqlx::query_as::<_, (String, String, i64)>(
            "SELECT id, state, confirmed FROM meeting_facts WHERE id = ?",
        )
        .bind(fact_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(dismissed_fact.1, "dismissed");
        assert_eq!(dismissed_fact.2, 1);

        // And the new action and decision were added
        let total_actions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meeting_actions WHERE meeting_id = ?")
            .bind("meeting-100")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total_actions, 2); // Dave (confirmed) + Alice (detected)
    }

    #[tokio::test]
    async fn test_meeting_memory_indexing() {
        let pool = setup_test_db().await;

        sqlx::query("INSERT INTO meetings (id, title) VALUES (?, ?)")
            .bind("meeting-200")
            .bind("Architecture Planning")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO transcripts (id, meeting_id, transcript)
             VALUES (?, ?, ?)",
        )
        .bind("t-200")
        .bind("meeting-200")
        .bind("We plan to use Rust for low-latency audio capture and Next.js for UI.")
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO summary_processes (meeting_id, result) VALUES (?, ?)")
            .bind("meeting-200")
            .bind("# Decisions\n- Use Rust and Next.js.")
            .execute(&pool)
            .await
            .unwrap();

        // Index meeting memory
        index_meeting_memory(&pool, "meeting-200")
            .await
            .expect("index meeting memory");

        // Verify indexed documents exist
        let doc_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM meeting_memory_documents WHERE meeting_id = ?",
        )
        .bind("meeting-200")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(doc_count > 0, "Indexed documents must be created");

        // Verify state is recorded
        let state_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM meeting_memory_state WHERE meeting_id = ?",
        )
        .bind("meeting-200")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(state_count, 1, "Memory state must record indexed hash");
    }

    #[test]
    fn test_snippet_for_query() {
        let text = "We held a sprint planning session today. Many issues were discussed. The key architectural decision was adopting SQLite for local offline persistence without cloud lock-in. Tomorrow we continue with UI polish.";
        let snippet = snippet_for_query(text, "sqlite offline persistence");
        assert!(snippet.contains("SQLite"));
        assert!(snippet.contains("offline persistence"));

        let short = "Quick test";
        assert_eq!(snippet_for_query(short, "test"), "Quick test");
    }

    #[test]
    fn test_sparse_vector_and_overlap_ranking() {
        let query = "sqlite database local storage";
        let doc_relevant = "We chose SQLite as our embedded database for local storage.";
        let doc_somewhat = "Database migration scripts need to run on startup.";
        let doc_unrelated = "Pancake recipe requires flour, milk, and eggs.";

        let q_vec = memory_vector(query);
        let rel_vec = memory_vector(doc_relevant);
        let some_vec = memory_vector(doc_somewhat);
        let unrel_vec = memory_vector(doc_unrelated);

        let score_rel = cosine(&q_vec, &rel_vec) * 0.72 + token_overlap(query, doc_relevant) * 0.28;
        let score_some = cosine(&q_vec, &some_vec) * 0.72 + token_overlap(query, doc_somewhat) * 0.28;
        let score_unrel = cosine(&q_vec, &unrel_vec) * 0.72 + token_overlap(query, doc_unrelated) * 0.28;

        assert!(score_rel > score_some, "Relevant document ({score_rel}) must outrank somewhat relevant ({score_some})");
        assert!(score_some > score_unrel, "Somewhat relevant ({score_some}) must outrank unrelated ({score_unrel})");
        assert!(score_unrel < 0.05, "Unrelated score should be negligible ({score_unrel})");
    }
}


