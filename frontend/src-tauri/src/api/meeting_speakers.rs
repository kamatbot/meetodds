//! Local, post-meeting attribution. Acoustic groups are estimates; naming a
//! group never confirms its turns. The SQLite database is the canonical review.
use serde::Serialize;
use sqlx::{FromRow, Row, SqliteConnection, SqlitePool};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::State;
use uuid::Uuid;

use crate::audio::speaker_separation::{separate_speakers, SeparationTurn};
use crate::state::AppState;

static ANALYSIS_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

pub(crate) fn analysis_in_progress() -> bool {
    ANALYSIS_IN_PROGRESS.load(Ordering::SeqCst)
}

struct AnalysisGuard;
impl AnalysisGuard {
    fn acquire() -> Result<Self, String> {
        ANALYSIS_IN_PROGRESS.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "Speaker analysis is already running. Please wait.".to_string())?;
        Ok(Self)
    }
}
impl Drop for AnalysisGuard {
    fn drop(&mut self) { ANALYSIS_IN_PROGRESS.store(false, Ordering::SeqCst); }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeaker {
    pub id: String,
    pub name: String,
    pub source: String,
    pub turn_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerReviewTurn {
    pub id: String,
    pub text: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub speaker_id: Option<String>,
    pub speaker_label: Option<String>,
    pub capture_channel: Option<String>,
    pub source: String,
    pub confidence: Option<f64>,
    pub reviewed: bool,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeakerReview {
    pub meeting_id: String,
    pub speakers: Vec<MeetingSpeaker>,
    pub turns: Vec<SpeakerReviewTurn>,
    pub analyzed_at: Option<String>,
    pub summary_needs_review: bool,
    pub can_analyze: bool,
    pub unavailable_reason: Option<String>,
    pub can_edit: bool,
    pub read_only_reason: Option<String>,
    pub revision: i64,
}

#[derive(Debug, Clone, FromRow, PartialEq)]
struct RawTurn {
    id: String,
    transcript: String,
    timestamp: String,
    audio_start_time: Option<f64>,
    audio_end_time: Option<f64>,
    speaker: Option<String>,
    speaker_label: Option<String>,
    speaker_source: Option<String>,
    speaker_confidence: Option<f64>,
    review_id: Option<String>,
    speaker_id: Option<String>,
    capture_channel: Option<String>,
    review_source: Option<String>,
    review_confidence: Option<f64>,
    reviewed: Option<bool>,
    reason: Option<String>,
}

impl RawTurn {
    fn channel(&self) -> Option<String> {
        // An existing review preserves None for imported audio, too.
        if self.review_id.is_some() { return self.capture_channel.clone(); }
        let source = self.speaker_source.as_deref().unwrap_or("");
        let speaker = self.speaker.as_deref().unwrap_or("");
        if source.starts_with("microphone") || matches!(speaker, "me" | "mic" | "microphone") {
            Some("microphone".to_string())
        } else if source.starts_with("system") || matches!(speaker, "system" | "remote-unknown") {
            Some("system".to_string())
        } else { None }
    }

    fn is_reviewed(&self) -> bool {
        self.reviewed.unwrap_or(false)
            || matches!(self.speaker_source.as_deref(), Some("manual" | "manual-unknown"))
    }

    fn into_review(self) -> SpeakerReviewTurn {
        let capture_channel = self.channel();
        let reviewed = self.is_reviewed();
        let source = self.review_source.clone().unwrap_or_else(|| {
            if reviewed { "manual" } else { "unresolved-channel" }.to_string()
        });
        let confidence = if source == "post-meeting-acoustic" { self.review_confidence } else { None };
        let reason = self.reason.clone().unwrap_or_else(|| match capture_channel.as_deref() {
            Some("microphone") => "Microphone channel; this does not identify a person.".to_string(),
            Some("system") => "The system channel can contain several participants.".to_string(),
            _ => "Speaker has not been identified.".to_string(),
        });
        SpeakerReviewTurn {
            id: self.id, text: self.transcript, start: self.audio_start_time, end: self.audio_end_time,
            speaker_id: self.speaker_id, speaker_label: self.speaker_label, capture_channel,
            source, confidence, reviewed, reason,
        }
    }
}

fn db_error(error: sqlx::Error) -> String { format!("Could not save or load speaker review: {error}") }

async fn meeting_folder(connection: &mut SqliteConnection, meeting_id: &str) -> Result<Option<String>, String> {
    sqlx::query_scalar::<_, Option<String>>("SELECT folder_path FROM meetings WHERE id = ? AND deleted_at IS NULL")
        .bind(meeting_id).fetch_optional(connection).await.map_err(db_error)?
        .ok_or_else(|| "This meeting no longer exists.".to_string())
}

async fn lock_meeting(connection: &mut SqliteConnection, meeting_id: &str) -> Result<(), String> {
    // Acquire the SQLite write lock before reading any mutation preconditions.
    let result = sqlx::query("UPDATE meetings SET updated_at = updated_at WHERE id = ? AND deleted_at IS NULL")
        .bind(meeting_id).execute(connection).await.map_err(db_error)?;
    if result.rows_affected() != 1 { return Err("This meeting no longer exists.".to_string()); }
    Ok(())
}

async fn fetch_turns(connection: &mut SqliteConnection, meeting_id: &str) -> Result<Vec<RawTurn>, String> {
    sqlx::query_as::<_, RawTurn>(
        "SELECT t.id, t.transcript, t.timestamp, t.audio_start_time, t.audio_end_time,
         t.speaker, t.speaker_label, t.speaker_source, t.speaker_confidence,
         r.transcript_id AS review_id, r.speaker_id, r.capture_channel,
         r.source AS review_source, r.confidence AS review_confidence, r.reviewed, r.reason
         FROM transcripts t LEFT JOIN transcript_speaker_reviews r ON r.transcript_id = t.id AND r.meeting_id = t.meeting_id
         WHERE t.meeting_id = ? ORDER BY t.audio_start_time IS NULL, t.audio_start_time, t.timestamp, t.id")
        .bind(meeting_id).fetch_all(connection).await.map_err(db_error)
}

async fn revision(connection: &mut SqliteConnection, meeting_id: &str) -> Result<i64, String> {
    Ok(sqlx::query_scalar("SELECT revision FROM meeting_speaker_state WHERE meeting_id = ?")
        .bind(meeting_id).fetch_optional(connection).await.map_err(db_error)?.unwrap_or(0))
}

fn fingerprint(value: &str) -> String {
    // Stable cache marker, not a security primitive. No meeting text is logged.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.bytes() { hash ^= u64::from(byte); hash = hash.wrapping_mul(0x100000001b3); }
    format!("{hash:016x}")
}

async fn changed(connection: &mut SqliteConnection, meeting_id: &str, attribution_changed: bool) -> Result<(), String> {
    sqlx::query("INSERT INTO meeting_speaker_state(meeting_id, revision) VALUES (?, 1) ON CONFLICT(meeting_id) DO UPDATE SET revision = revision + 1")
        .bind(meeting_id).execute(&mut *connection).await.map_err(db_error)?;
    if !attribution_changed { return Ok(()); }
    sqlx::query("UPDATE meeting_speaker_state SET attribution_changed_at = ? WHERE meeting_id = ?")
        .bind(chrono::Utc::now().to_rfc3339()).bind(meeting_id)
        .execute(&mut *connection).await.map_err(db_error)?;
    // Evidence stays attached to the same statement. Attribution changes never
    // rewrite an action owner or turn a detected commitment into confirmation.
    for turn in fetch_turns(connection, meeting_id).await? {
        let label = super::meeting_export::speaker_display_label(turn.speaker.as_deref(), turn.speaker_label.as_deref(), turn.speaker_source.as_deref());
        sqlx::query("UPDATE meeting_evidence SET speaker_label = ? WHERE meeting_id = ? AND transcript_id = ?")
            .bind(label).bind(meeting_id).bind(&turn.id).execute(&mut *connection).await.map_err(db_error)?;
    }
    sqlx::query("DELETE FROM meeting_memory_documents WHERE meeting_id = ?")
        .bind(meeting_id).execute(&mut *connection).await.map_err(db_error)?;
    sqlx::query("DELETE FROM meeting_memory_state WHERE meeting_id = ?")
        .bind(meeting_id).execute(&mut *connection).await.map_err(db_error)?;
    Ok(())
}

async fn ensure_idle() -> Result<(), String> {
    if crate::audio::recording_commands::is_recording().await {
        return Err("Finish recording before reviewing speakers.".to_string());
    }
    if crate::audio::retranscription::is_retranscription_in_progress() {
        return Err("Wait for re-transcription to finish before reviewing speakers.".to_string());
    }
    Ok(())
}

async fn ensure_summary_idle(connection: &mut SqliteConnection, meeting_id: &str) -> Result<(), String> {
    let busy: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM summary_processes WHERE meeting_id = ? AND LOWER(status) IN ('pending', 'processing', 'summarizing', 'regenerating'))")
        .bind(meeting_id).fetch_one(connection).await.map_err(db_error)?;
    if busy { return Err("Wait for the summary to finish before reviewing speakers.".to_string()); }
    Ok(())
}

fn transcript_fingerprint(turns: &[RawTurn]) -> String {
    let values: Vec<_> = turns.iter().map(|t| (&t.id, &t.transcript, t.audio_start_time, t.audio_end_time, t.channel())).collect();
    fingerprint(&serde_json::to_string(&values).unwrap_or_default())
}

fn has_timed_remote_turn(turns: &[RawTurn]) -> bool {
    turns.iter().any(|turn| turn.channel().as_deref() != Some("microphone")
        && matches!((turn.audio_start_time, turn.audio_end_time), (Some(start), Some(end))
            if start.is_finite() && end.is_finite() && start >= 0.0 && end > start))
}

fn audio_fingerprint(path: &Path) -> Result<String, String> {
    let metadata = std::fs::metadata(path).map_err(|_| "Saved audio is unavailable.".to_string())?;
    let modified = metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());
    Ok(fingerprint(&format!("{}:{}:{modified:?}", path.display(), metadata.len())))
}

fn audio_path(folder: &Path) -> Result<PathBuf, String> {
    let folder = folder.canonicalize().map_err(|_| "Saved audio is unavailable.".to_string())?;
    let metadata = std::fs::read(folder.join("metadata.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let declared = metadata.as_ref().and_then(|v| v.get("audio_file")).and_then(|v| v.as_str());
    if declared == Some("") { return Err("Audio was not retained for this meeting. You can still assign speakers manually.".to_string()); }
    let candidates: Vec<&str> = match declared {
        Some(name) => vec![name],
        None => vec!["audio.mp4", "audio.m4a", "audio.wav", "audio.mp3", "audio.flac", "audio.ogg", "recording.mp4", "audio.mkv", "audio.webm"],
    };
    for name in candidates {
        let relative = Path::new(name);
        if relative.components().count() != 1 || relative.file_name().and_then(|n| n.to_str()) != Some(name) { continue; }
        if let Ok(path) = folder.join(relative).canonicalize() {
            if path.parent() == Some(folder.as_path()) && path.is_file() { return Ok(path); }
        }
    }
    Err("Saved audio is unavailable. You can still assign speakers manually.".to_string())
}

async fn load_review(pool: &SqlitePool, meeting_id: &str) -> Result<MeetingSpeakerReview, String> {
    let mut tx = pool.begin().await.map_err(db_error)?;
    let folder = meeting_folder(&mut tx, meeting_id).await?;
    let turns = fetch_turns(&mut tx, meeting_id).await?;
    let rows = sqlx::query("SELECT s.id, s.name, s.source, COUNT(r.transcript_id) AS turn_count FROM meeting_speakers s LEFT JOIN transcript_speaker_reviews r ON r.speaker_id = s.id AND r.meeting_id = s.meeting_id WHERE s.meeting_id = ? GROUP BY s.id ORDER BY s.created_at, s.name, s.id")
        .bind(meeting_id).fetch_all(&mut *tx).await.map_err(db_error)?;
    let speakers = rows.into_iter().map(|r| MeetingSpeaker { id: r.get("id"), name: r.get("name"), source: r.get("source"), turn_count: r.get("turn_count") }).collect();
    let state = sqlx::query("SELECT revision, analyzed_at, summary_input_revision, attribution_changed_at FROM meeting_speaker_state WHERE meeting_id = ?")
        .bind(meeting_id).fetch_optional(&mut *tx).await.map_err(db_error)?;
    let analyzed_at = state.as_ref().and_then(|r| r.get::<Option<String>, _>("analyzed_at"));
    let current_revision = state.as_ref().map(|r| r.get::<i64, _>("revision")).unwrap_or(0);
    let summary_input_revision = state.as_ref().and_then(|r| r.get::<Option<i64>, _>("summary_input_revision"));
    let summary = sqlx::query("SELECT result, status, start_time, end_time FROM summary_processes WHERE meeting_id = ?")
        .bind(meeting_id).fetch_optional(&mut *tx).await.map_err(db_error)?;
    let has_summary = summary.as_ref().and_then(|r| r.get::<Option<String>, _>("result")).is_some();
    let completed_fresh_generation = summary.as_ref().map(|r| {
        let status: String = r.get("status");
        let start = r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("start_time").ok().flatten();
        let end = r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("end_time").ok().flatten();
        status.eq_ignore_ascii_case("completed") && matches!((start, end), (Some(start), Some(end)) if end >= start)
            && summary_input_revision == Some(current_revision)
    }).unwrap_or(false);
    // Conservatively keep the warning until a fresh summary explicitly
    // acknowledges this attribution revision. Editing summary text is not
    // evidence that its previous speaker assumptions were reviewed.
    let summary_needs_review = has_summary && !completed_fresh_generation && state.as_ref()
        .and_then(|r| r.get::<Option<String>, _>("attribution_changed_at")).is_some();
    let summary_busy_reason = ensure_summary_idle(&mut tx, meeting_id).await.err();
    tx.commit().await.map_err(db_error)?;
    let read_only_reason = ensure_idle().await.err().or(summary_busy_reason);
    let mut unavailable_reason = read_only_reason.clone();
    if unavailable_reason.is_none() && analysis_in_progress() { unavailable_reason = Some("Speaker analysis is running.".to_string()); }
    if unavailable_reason.is_none() && !has_timed_remote_turn(&turns) {
        unavailable_reason = Some("Speaker analysis needs timed remote or imported audio. You can assign speakers manually.".to_string());
    }
    if unavailable_reason.is_none() {
        unavailable_reason = match folder {
            Some(folder) => tokio::task::spawn_blocking(move || audio_path(Path::new(&folder))).await
                .map_err(|_| "Could not inspect saved audio.".to_string())?.err(),
            None => Some("No saved audio is available. You can assign speakers manually.".to_string()),
        };
    }
    Ok(MeetingSpeakerReview { meeting_id: meeting_id.to_string(), speakers,
        turns: turns.into_iter().map(RawTurn::into_review).collect(), analyzed_at,
        summary_needs_review, can_analyze: unavailable_reason.is_none(), unavailable_reason,
        can_edit: read_only_reason.is_none(), read_only_reason, revision: current_revision })
}

#[tauri::command]
pub async fn api_get_meeting_speakers(state: State<'_, AppState>, meeting_id: String) -> Result<MeetingSpeakerReview, String> {
    load_review(state.db_manager.pool(), &meeting_id).await
}

fn valid_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("Enter a participant name of 1–80 characters without line breaks.".to_string());
    }
    if matches!(name.to_lowercase().as_str(), "unknown" | "unknown speaker" | "unassigned" | "other party" | "remote participants" | "microphone" | "system audio") {
        return Err("Enter a person's name, or use Unknown for an unidentified speaker.".to_string());
    }
    Ok(name.to_string())
}

#[tauri::command]
pub async fn api_add_meeting_speaker(state: State<'_, AppState>, meeting_id: String, name: String) -> Result<MeetingSpeakerReview, String> {
    ensure_idle().await?;
    let name = valid_name(&name)?;
    let pool = state.db_manager.pool();
    let mut tx = pool.begin().await.map_err(db_error)?;
    lock_meeting(&mut tx, &meeting_id).await?;
    ensure_summary_idle(&mut tx, &meeting_id).await?;
    sqlx::query("INSERT INTO meeting_speakers(id, meeting_id, name, source) VALUES (?, ?, ?, 'manual')")
        .bind(Uuid::new_v4().to_string()).bind(&meeting_id).bind(name).execute(&mut *tx).await.map_err(db_error)?;
    changed(&mut tx, &meeting_id, false).await?;
    tx.commit().await.map_err(db_error)?;
    load_review(pool, &meeting_id).await
}

#[tauri::command]
pub async fn api_rename_meeting_speaker(state: State<'_, AppState>, meeting_id: String, speaker_id: String, name: String) -> Result<MeetingSpeakerReview, String> {
    ensure_idle().await?;
    let name = valid_name(&name)?;
    let pool = state.db_manager.pool();
    let mut tx = pool.begin().await.map_err(db_error)?;
    lock_meeting(&mut tx, &meeting_id).await?;
    ensure_summary_idle(&mut tx, &meeting_id).await?;
    let result = sqlx::query("UPDATE meeting_speakers SET name = ? WHERE id = ? AND meeting_id = ?")
        .bind(&name).bind(&speaker_id).bind(&meeting_id).execute(&mut *tx).await.map_err(db_error)?;
    if result.rows_affected() != 1 { return Err("This participant does not belong to this meeting.".to_string()); }
    let result = sqlx::query("UPDATE transcripts SET speaker_label = ? WHERE meeting_id = ? AND id IN (SELECT transcript_id FROM transcript_speaker_reviews WHERE meeting_id = ? AND speaker_id = ?)")
        .bind(&name).bind(&meeting_id).bind(&meeting_id).bind(&speaker_id).execute(&mut *tx).await.map_err(db_error)?;
    changed(&mut tx, &meeting_id, result.rows_affected() > 0).await?;
    tx.commit().await.map_err(db_error)?;
    load_review(pool, &meeting_id).await
}

async fn write_assignment(connection: &mut SqliteConnection, meeting_id: &str, turn: &RawTurn,
    speaker_id: Option<&str>, label: Option<&str>, source: &str, confidence: Option<f64>, reviewed: bool, reason: &str) -> Result<(), String> {
    sqlx::query("INSERT INTO transcript_speaker_reviews(transcript_id, meeting_id, speaker_id, capture_channel, source, confidence, reviewed, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(transcript_id) DO UPDATE SET speaker_id = excluded.speaker_id, source = excluded.source, confidence = excluded.confidence, reviewed = excluded.reviewed, reason = excluded.reason")
        .bind(&turn.id).bind(meeting_id).bind(speaker_id).bind(turn.channel()).bind(source).bind(confidence).bind(reviewed).bind(reason)
        .execute(&mut *connection).await.map_err(db_error)?;
    let persisted_source = if reviewed && speaker_id.is_none() { "manual-unknown" } else { source };
    sqlx::query("UPDATE transcripts SET speaker = ?, speaker_label = ?, speaker_source = ?, speaker_confidence = ? WHERE id = ? AND meeting_id = ?")
        .bind(speaker_id.unwrap_or("unknown")).bind(label).bind(persisted_source).bind(confidence).bind(&turn.id).bind(meeting_id)
        .execute(connection).await.map_err(db_error)?;
    Ok(())
}

#[tauri::command]
pub async fn api_assign_transcript_speaker(state: State<'_, AppState>, meeting_id: String, transcript_id: String, speaker_id: Option<String>) -> Result<MeetingSpeakerReview, String> {
    ensure_idle().await?;
    let pool = state.db_manager.pool();
    let mut tx = pool.begin().await.map_err(db_error)?;
    lock_meeting(&mut tx, &meeting_id).await?;
    ensure_summary_idle(&mut tx, &meeting_id).await?;
    let turn = fetch_turns(&mut tx, &meeting_id).await?.into_iter().find(|t| t.id == transcript_id)
        .ok_or_else(|| "This transcript turn no longer belongs to this meeting.".to_string())?;
    let name = if let Some(id) = speaker_id.as_ref() {
        Some(sqlx::query_scalar::<_, String>("SELECT name FROM meeting_speakers WHERE id = ? AND meeting_id = ?")
            .bind(id).bind(&meeting_id).fetch_optional(&mut *tx).await.map_err(db_error)?
            .ok_or_else(|| "This participant does not belong to this meeting.".to_string())?)
    } else { None };
    let reason = if speaker_id.is_some() { "Speaker assignment confirmed by you." } else { "Reviewed by you; speaker remains unknown." };
    write_assignment(&mut tx, &meeting_id, &turn, speaker_id.as_deref(), name.as_deref(), "manual", None, true, reason).await?;
    changed(&mut tx, &meeting_id, true).await?;
    tx.commit().await.map_err(db_error)?;
    load_review(pool, &meeting_id).await
}

#[tauri::command]
pub async fn api_analyze_meeting_speakers(state: State<'_, AppState>, meeting_id: String) -> Result<MeetingSpeakerReview, String> {
    let guard = AnalysisGuard::acquire()?;
    // Coordinate with recording initialization as well as its active flag.
    let lifecycle_guard = crate::audio::common::acquire_engine_lifecycle_lock().await;
    ensure_idle().await?;
    let pool = state.db_manager.pool();
    let mut snapshot = pool.begin().await.map_err(db_error)?;
    let folder = meeting_folder(&mut snapshot, &meeting_id).await?
        .ok_or_else(|| "No saved audio is available. Assign speakers manually.".to_string())?;
    let turns = fetch_turns(&mut snapshot, &meeting_id).await?;
    ensure_summary_idle(&mut snapshot, &meeting_id).await?;
    if turns.is_empty() { return Err("This meeting has no transcript to review.".to_string()); }
    if !has_timed_remote_turn(&turns) { return Err("Speaker analysis needs timed remote or imported audio. Assign speakers manually.".to_string()); }
    let snapshot_revision = revision(&mut snapshot, &meeting_id).await?;
    let transcript_snapshot = transcript_fingerprint(&turns);
    snapshot.commit().await.map_err(db_error)?;
    let inputs: Vec<_> = turns.iter().map(|t| SeparationTurn { id: t.id.clone(), start: t.audio_start_time, end: t.audio_end_time, channel: t.channel() }).collect();
    let (estimates, source_fingerprint) = tokio::task::spawn_blocking(move || {
        let path = audio_path(Path::new(&folder))?;
        let audio_snapshot = audio_fingerprint(&path)?;
        let audio = crate::audio::decoder::decode_audio_file_bounded(&path, 7_200.0, 128_000_000)
            .map_err(|error| format!("Speaker analysis could not read this recording: {error}. You can assign speakers manually."))?;
        let samples = audio.to_16k_mono();
        let estimates = separate_speakers(&samples, 16_000, &inputs);
        if audio_fingerprint(&path)? != audio_snapshot {
            return Err("The saved audio changed during analysis. Please run it again.".to_string());
        }
        Ok::<_, String>((estimates, fingerprint(&format!("{transcript_snapshot}:{audio_snapshot}"))))
    }).await.map_err(|_| "Local speaker analysis did not finish. Please retry.".to_string())??;
    ensure_idle().await?;
    let mut tx = pool.begin().await.map_err(db_error)?;
    lock_meeting(&mut tx, &meeting_id).await?;
    ensure_summary_idle(&mut tx, &meeting_id).await?;
    if revision(&mut tx, &meeting_id).await? != snapshot_revision || fetch_turns(&mut tx, &meeting_id).await? != turns {
        return Err("The transcript or speaker review changed during analysis. Your changes were kept; run analysis again.".to_string());
    }
    let previous_fingerprint: Option<String> = sqlx::query_scalar::<_, Option<String>>("SELECT analyzed_transcript_fingerprint FROM meeting_speaker_state WHERE meeting_id = ?")
        .bind(&meeting_id).fetch_optional(&mut *tx).await.map_err(db_error)?.flatten();
    if previous_fingerprint.as_deref() != Some(source_fingerprint.as_str()) {
        // Cluster indices are positional, not voice identities. Retain named
        // participants/manual assignments, but never reuse an old name for a
        // different transcript snapshot's group at the same index.
        sqlx::query("UPDATE meeting_speakers SET cluster_index = NULL WHERE meeting_id = ?")
            .bind(&meeting_id).execute(&mut *tx).await.map_err(db_error)?;
    }
    let mut clusters: HashMap<usize, (String, String)> = HashMap::new();
    let turn_lookup: HashMap<&str, &RawTurn> = turns.iter().map(|turn| (turn.id.as_str(), turn)).collect();
    let mut attribution_changed = false;
    for estimate in estimates {
        let Some(turn) = turn_lookup.get(estimate.transcript_id.as_str()) else { continue; };
        if turn.is_reviewed() { continue; }
        if let Some(cluster) = estimate.cluster {
            if !clusters.contains_key(&cluster) {
                let existing = sqlx::query_as::<_, (String, String)>("SELECT id, name FROM meeting_speakers WHERE meeting_id = ? AND cluster_index = ?")
                    .bind(&meeting_id).bind(cluster as i64).fetch_optional(&mut *tx).await.map_err(db_error)?;
                let (id, name) = existing.unwrap_or_else(|| (Uuid::new_v4().to_string(), format!("Speaker {}", cluster + 1)));
                sqlx::query("INSERT OR IGNORE INTO meeting_speakers(id, meeting_id, name, source, cluster_index) VALUES (?, ?, ?, 'post-meeting-acoustic', ?)")
                    .bind(&id).bind(&meeting_id).bind(&name).bind(cluster as i64).execute(&mut *tx).await.map_err(db_error)?;
                clusters.insert(cluster, (id, name));
            }
            let (id, name) = &clusters[&cluster];
            let confidence = estimate.confidence.filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 1.0));
            write_assignment(&mut tx, &meeting_id, turn, Some(id), Some(name), "post-meeting-acoustic", confidence, false, &estimate.reason).await?;
            attribution_changed = true;
        } else if turn.channel().as_deref() != Some("microphone") {
            write_assignment(&mut tx, &meeting_id, turn, None, None, "unresolved-channel", None, false, &estimate.reason).await?;
            attribution_changed = true;
        }
    }
    changed(&mut tx, &meeting_id, attribution_changed).await?;
    sqlx::query("UPDATE meeting_speaker_state SET analyzed_at = ?, analyzed_transcript_fingerprint = ? WHERE meeting_id = ?")
        .bind(chrono::Utc::now().to_rfc3339()).bind(source_fingerprint).bind(&meeting_id).execute(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    drop(lifecycle_guard);
    drop(guard);
    load_review(pool, &meeting_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        let schema = "
            PRAGMA foreign_keys = ON;
            CREATE TABLE meetings(id TEXT PRIMARY KEY, folder_path TEXT, updated_at TEXT, deleted_at TEXT);
            CREATE TABLE transcripts(id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, transcript TEXT NOT NULL, timestamp TEXT NOT NULL, audio_start_time REAL, audio_end_time REAL, speaker TEXT, speaker_label TEXT, speaker_source TEXT, speaker_confidence REAL);
            CREATE TABLE summary_processes(meeting_id TEXT PRIMARY KEY, status TEXT, result TEXT, start_time TEXT, end_time TEXT);
            CREATE TABLE meeting_evidence(meeting_id TEXT, transcript_id TEXT, speaker_label TEXT);
            CREATE TABLE meeting_memory_documents(meeting_id TEXT);
            CREATE TABLE meeting_memory_state(meeting_id TEXT);
            INSERT INTO meetings(id) VALUES ('m'), ('other');
            INSERT INTO transcripts(id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, speaker, speaker_label, speaker_source) VALUES ('t', 'm', 'I can send the draft.', '2026-10-13', 2.0, 5.0, 'remote-unknown', 'Other party', 'system');
            INSERT INTO transcripts(id, meeting_id, transcript, timestamp) VALUES ('other-turn', 'other', 'Different meeting.', '2026-10-13');
            INSERT INTO summary_processes(meeting_id, status, result, start_time, end_time) VALUES ('m', 'completed', '{}', '2026-10-12T00:00:00Z', '2026-10-12T00:01:00Z');
            INSERT INTO meeting_evidence(meeting_id, transcript_id, speaker_label) VALUES ('m', 't', 'Other party');
        ";
        for sql in [schema, include_str!("../../migrations/20261013090000_meeting_speaker_review.sql")] {
            let sql = sql.lines().filter(|line| !line.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n");
            for statement in sql.split(';').filter(|statement| !statement.trim().is_empty()) {
                sqlx::query(statement).execute(&pool).await.unwrap();
            }
        }
        sqlx::query("INSERT INTO meeting_speakers(id, meeting_id, name, source) VALUES ('alex', 'm', 'Alex', 'post-meeting-acoustic'), ('other-person', 'other', 'Morgan', 'manual')")
            .execute(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn migration_rejects_cross_meeting_speaker_and_transcript_ids() {
        let pool = fixture().await;
        for (transcript, speaker) in [("t", "other-person"), ("other-turn", "alex")] {
            let result = sqlx::query("INSERT INTO transcript_speaker_reviews(transcript_id, meeting_id, speaker_id, source, reason) VALUES (?, 'm', ?, 'manual', 'Reviewed')")
                .bind(transcript).bind(speaker).execute(&pool).await;
            assert!(result.is_err(), "both speaker and transcript must belong to the meeting");
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcript_speaker_reviews").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn assignment_and_evidence_roll_back_together_and_unknown_survives() {
        let pool = fixture().await;
        let mut tx = pool.begin().await.unwrap();
        lock_meeting(&mut tx, "m").await.unwrap();
        let original = fetch_turns(&mut tx, "m").await.unwrap().remove(0);
        write_assignment(&mut tx, "m", &original, Some("alex"), Some("Alex"), "manual", None, true, "Reviewed").await.unwrap();
        changed(&mut tx, "m", true).await.unwrap();
        tx.rollback().await.unwrap();
        let mut connection = pool.acquire().await.unwrap();
        assert_eq!(fetch_turns(&mut connection, "m").await.unwrap()[0], original);
        assert_eq!(revision(&mut connection, "m").await.unwrap(), 0);
        let label: String = sqlx::query_scalar("SELECT speaker_label FROM meeting_evidence WHERE transcript_id = 't'")
            .fetch_one(&mut *connection).await.unwrap();
        assert_eq!(label, "Other party");
        drop(connection);

        let mut tx = pool.begin().await.unwrap();
        lock_meeting(&mut tx, "m").await.unwrap();
        write_assignment(&mut tx, "m", &original, None, None, "manual", None, true, "Reviewed; unknown").await.unwrap();
        changed(&mut tx, "m", true).await.unwrap();
        tx.commit().await.unwrap();
        let mut connection = pool.acquire().await.unwrap();
        let reviewed = fetch_turns(&mut connection, "m").await.unwrap().remove(0);
        assert!(reviewed.is_reviewed(), "analysis must skip manually reviewed Unknown turns");
        assert_eq!(reviewed.speaker_source.as_deref(), Some("manual-unknown"));
        assert_eq!(reviewed.channel().as_deref(), Some("system"));
        assert!(reviewed.speaker_id.is_none());
    }

    #[tokio::test]
    async fn summary_stays_stale_until_success_for_current_revision() {
        let pool = fixture().await;
        let mut tx = pool.begin().await.unwrap();
        changed(&mut tx, "m", true).await.unwrap();
        tx.commit().await.unwrap();
        assert!(load_review(&pool, "m").await.unwrap().summary_needs_review);
        // Editing summary text cannot acknowledge changed attribution.
        sqlx::query("UPDATE summary_processes SET result = '{\"markdown\":\"Edited\"}' WHERE meeting_id = 'm'").execute(&pool).await.unwrap();
        assert!(load_review(&pool, "m").await.unwrap().summary_needs_review);
        sqlx::query("UPDATE meeting_speaker_state SET summary_input_revision = revision WHERE meeting_id = 'm'").execute(&pool).await.unwrap();
        // A failed or pending regeneration can still carry the old result.
        for status in ["pending", "processing", "failed", "cancelled"] {
            sqlx::query("UPDATE summary_processes SET status = ? WHERE meeting_id = 'm'").bind(status).execute(&pool).await.unwrap();
            assert!(load_review(&pool, "m").await.unwrap().summary_needs_review);
        }
        sqlx::query("UPDATE summary_processes SET status = 'completed', start_time = '2026-10-13T12:00:00Z', end_time = '2026-10-13T12:01:00Z' WHERE meeting_id = 'm'").execute(&pool).await.unwrap();
        assert!(!load_review(&pool, "m").await.unwrap().summary_needs_review);
        sqlx::query("UPDATE meeting_speaker_state SET revision = revision + 1 WHERE meeting_id = 'm'").execute(&pool).await.unwrap();
        assert!(load_review(&pool, "m").await.unwrap().summary_needs_review);
    }

    #[tokio::test]
    async fn deleted_meeting_cannot_be_locked_for_review() {
        let pool = fixture().await;
        sqlx::query("UPDATE meetings SET deleted_at = '2026-10-13' WHERE id = 'm'").execute(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        assert!(lock_meeting(&mut tx, "m").await.is_err());
        assert!(meeting_folder(&mut tx, "m").await.is_err());
    }

    #[test]
    fn names_reject_empty_control_and_unknown_aliases() {
        for invalid in ["", "  ", "Unknown", "unknown speaker", "A\nB", "Other party", "System audio"] { assert!(valid_name(invalid).is_err()); }
        assert_eq!(valid_name("  Alex Chen  ").unwrap(), "Alex Chen");
        assert!(valid_name(&"a".repeat(81)).is_err());
    }

    fn turn() -> RawTurn {
        RawTurn { id: "t1".into(), transcript: "I can send the draft.".into(), timestamp: "now".into(),
            audio_start_time: Some(2.0), audio_end_time: Some(5.0), speaker: Some("remote-unknown".into()),
            speaker_label: Some("Other party".into()), speaker_source: Some("system".into()), speaker_confidence: None,
            review_id: None, speaker_id: None, capture_channel: None, review_source: None,
            review_confidence: None, reviewed: None, reason: None }
    }

    #[test]
    fn assigning_unknown_preserves_original_channel_and_review() {
        let mut value = turn();
        value.capture_channel = value.channel();
        value.review_id = Some(value.id.clone());
        value.speaker = Some("unknown".into());
        value.speaker_label = None;
        value.speaker_source = Some("manual-unknown".into());
        value.review_source = Some("manual".into());
        value.reviewed = Some(true);
        let review = value.into_review();
        assert!(review.reviewed);
        assert_eq!(review.capture_channel.as_deref(), Some("system"));
        assert!(review.speaker_id.is_none());
        assert_eq!(review.source, "manual");
    }

    #[test]
    fn naming_does_not_confirm_an_estimate_or_change_group_snapshot() {
        let mut estimate = turn();
        estimate.review_id = Some(estimate.id.clone());
        estimate.capture_channel = Some("system".into());
        estimate.speaker_id = Some("meeting-local-id".into());
        estimate.speaker_source = Some("post-meeting-acoustic".into());
        estimate.review_source = Some("post-meeting-acoustic".into());
        estimate.review_confidence = Some(0.7);
        estimate.reviewed = Some(false);
        let before = transcript_fingerprint(&[estimate.clone()]);
        estimate.speaker_label = Some("Alex".into());
        assert_eq!(before, transcript_fingerprint(&[estimate.clone()]));
        let mut replacement = estimate.clone();
        replacement.id = "replacement-turn".into();
        assert_ne!(before, transcript_fingerprint(&[replacement]));
        let review = estimate.into_review();
        assert!(!review.reviewed);
        assert_eq!(review.source, "post-meeting-acoustic");
        assert_eq!(review.confidence, Some(0.7));
    }

    #[test]
    fn audio_retention_opt_out_and_path_escape_are_respected() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("audio.wav"), b"audio").unwrap();
        std::fs::write(dir.path().join("metadata.json"), r#"{"audio_file":""}"#).unwrap();
        assert!(audio_path(dir.path()).is_err());
        std::fs::write(dir.path().join("metadata.json"), r#"{"audio_file":"../audio.wav"}"#).unwrap();
        assert!(audio_path(dir.path()).is_err());
        std::fs::write(dir.path().join("metadata.json"), r#"{"audio_file":"audio.wav"}"#).unwrap();
        assert_eq!(audio_path(dir.path()).unwrap(), dir.path().join("audio.wav").canonicalize().unwrap());
    }
}
