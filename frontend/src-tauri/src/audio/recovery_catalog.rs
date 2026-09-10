//! Disk-backed recovery independent of the webview's IndexedDB cache.
use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime, State};
use crate::state::AppState;
use super::incremental_saver::AudioRecoveryStatus;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    meeting_id: String, title: String, start_time: i64, last_updated: i64,
    transcript_count: usize, saved_to_sqlite: bool, folder_path: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredCapture { success: bool, meeting_id: String, audio_recovery_status: AudioRecoveryStatus }
fn json(path: &Path, maximum: u64) -> Result<Value> {
    if std::fs::metadata(path)?.len() > maximum { return Err(anyhow!("Recovery file exceeds the supported size; preserve the original folder")); }
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
fn valid_folder(folder: &Path, roots: &[PathBuf]) -> Result<PathBuf> {
    if std::fs::symlink_metadata(folder)?.file_type().is_symlink() { return Err(anyhow!("Recovery cannot follow a symbolic-link folder")); }
    let folder = folder.canonicalize()?;
    if !roots.iter().filter_map(|root| root.canonicalize().ok()).any(|root| folder.parent() == Some(root.as_path())) {
        return Err(anyhow!("Select this recording's parent folder in Recording settings before recovering it"));
    }
    if !folder.join("metadata.json").is_file() { return Err(anyhow!("Recording metadata is missing")); }
    Ok(folder)
}
fn read_turns(folder: &Path) -> Result<Vec<Value>> {
    let mut turns = Vec::new();
    let path = folder.join("transcripts.json");
    if path.exists() {
        if let Ok(data) = json(&path, 64 * 1024 * 1024) {
            if let Some(segments) = data.get("segments").and_then(Value::as_array) {
                turns = segments.clone();
            }
        }
    }
    // Check if append-only journal contains any additional turns from an interrupted session
    let journal_path = folder.join("transcripts.jsonl");
    if journal_path.is_file() {
        if let Ok(content) = std::fs::read_to_string(&journal_path) {
            let mut seen_ids: HashSet<String> = turns.iter()
                .filter_map(|s| s.get("sequence_id").and_then(|id| id.as_u64().map(|n| n.to_string())))
                .collect();
            for line in content.lines() {
                if let Ok(seg) = serde_json::from_str::<Value>(line) {
                    let seq_id = seg.get("sequence_id").and_then(|id| id.as_u64().map(|n| n.to_string())).unwrap_or_default();
                    if !seq_id.is_empty() && !seen_ids.contains(&seq_id) {
                        seen_ids.insert(seq_id);
                        turns.push(seg);
                    }
                }
            }
        }
    }
    Ok(turns)
}
fn publish_metadata(folder: &Path, metadata: &Value) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(folder)?;
    serde_json::to_writer_pretty(temp.as_file_mut(), metadata)?;
    temp.flush()?; temp.as_file().sync_all()?;
    temp.persist(folder.join("metadata.json")).map_err(|e| anyhow!(e.error))?;
    #[cfg(unix)] std::fs::File::open(folder)?.sync_all()?;
    Ok(())
}
fn scan(roots: &[PathBuf], saved: &HashSet<PathBuf>) -> Result<Vec<RecoveryEntry>> {
    let mut entries = HashMap::new();
    for root in roots {
        if !root.exists() { continue; }
        for child in std::fs::read_dir(root)? {
            let child = child?;
            if !child.file_type()?.is_dir() { continue; }
            let folder = match valid_folder(&child.path(), roots) { Ok(folder) => folder, Err(_) => continue };
            let metadata = match json(&folder.join("metadata.json"), 1024 * 1024) { Ok(data) => data, Err(_) => continue };
            let status = metadata["status"].as_str().unwrap_or("recording");
            if status == "discarded" || (saved.contains(&folder) && matches!(status, "completed" | "recovered")) { continue; }
            let transcripts = read_turns(&folder).unwrap_or_default();
            let audio = folder.join(".checkpoints").is_dir() || folder.join("audio.mp4").is_file();
            if transcripts.is_empty() && !audio { continue; }
            let started = metadata["created_at"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|time| time.timestamp_millis()).unwrap_or(0);
            let path = folder.to_string_lossy().to_string();
            entries.insert(path.clone(), RecoveryEntry { meeting_id: format!("disk:{path}"),
                title: metadata["meeting_name"].as_str().unwrap_or("Interrupted meeting").to_string(),
                start_time: started, last_updated: started, transcript_count: transcripts.len(), saved_to_sqlite: false, folder_path: path });
        }
    }
    let mut entries: Vec<_> = entries.into_values().collect();
    entries.sort_by(|left, right| right.start_time.cmp(&left.start_time));
    Ok(entries)
}
async fn roots<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<PathBuf>, String> {
    let prefs = super::recording_preferences::load_recording_preferences(app).await.map_err(|_| "Recording preferences are unavailable".to_string())?;
    Ok(vec![prefs.save_folder, super::recording_preferences::get_default_recordings_folder()])
}

#[tauri::command]
pub async fn list_recoverable_captures<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> Result<Vec<RecoveryEntry>, String> {
    if super::recording_commands::is_recording().await { return Ok(Vec::new()); }
    let roots = roots(&app).await?;
    let saved: Vec<String> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE folder_path IS NOT NULL")
        .fetch_all(state.db_manager.pool()).await.map_err(|_| "Meeting library could not be checked for recovery".to_string())?;
    tokio::task::spawn_blocking(move || {
        let saved = saved.into_iter().filter_map(|path| PathBuf::from(path).canonicalize().ok()).collect();
        scan(&roots, &saved).map_err(|e| e.to_string())
    }).await.map_err(|_| "Recovery catalog worker failed".to_string())?
}
#[tauri::command]
pub async fn read_capture_recovery_transcripts<R: Runtime>(app: AppHandle<R>, meeting_folder: String) -> Result<Vec<Value>, String> {
    let roots = roots(&app).await?;
    tokio::task::spawn_blocking(move || -> Result<Vec<Value>> {
        let folder = valid_folder(Path::new(&meeting_folder), &roots)?;
        let metadata = json(&folder.join("metadata.json"), 1024 * 1024)?;
        Ok(read_turns(&folder)?.into_iter().enumerate().map(|(index, mut turn)| {
            turn["meetingId"] = Value::String(format!("disk:{}", folder.to_string_lossy()));
            turn["sequenceId"] = turn.get("sequence_id").cloned().unwrap_or_else(|| index.into());
            turn["timestamp"] = metadata["created_at"].clone();
            turn["storedAt"] = 0.into();
            turn
        }).collect())
    }).await.map_err(|_| "Transcript recovery worker failed".to_string())?.map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn recover_capture<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, meeting_folder: String) -> Result<RecoveredCapture, String> {
    // Serialize against recorder start and competing recoveries. A summary does not own recovery data.
    let _guard = super::common::acquire_engine_lifecycle_lock().await;
    if super::recording_commands::is_recording().await { return Err("Stop recording before recovering another meeting".to_string()); }
    let roots = roots(&app).await?;
    let folder = valid_folder(Path::new(&meeting_folder), &roots).map_err(|e| e.to_string())?;
    let mut metadata = json(&folder.join("metadata.json"), 1024 * 1024).map_err(|e| e.to_string())?;
    let turns = read_turns(&folder).map_err(|e| e.to_string())?;
    let folder_string = folder.to_string_lossy().to_string();
    let audio = match super::incremental_saver::recover_audio_from_checkpoints(folder_string.clone(), 48_000).await {
        Ok(audio) => audio,
        Err(error) => return Err(format!("Audio could not be recovered; all source files are retained. {error}")),
    };
    if turns.is_empty() && audio.audio_file_path.is_none() && !folder.join("audio.mp4").is_file() {
        return Err("No verified audio or transcript was found. Source files were not deleted.".to_string());
    }
    let transcript: Vec<crate::api::TranscriptSegment> = turns.into_iter().map(|mut value| {
        value["timestamp"] = metadata["created_at"].as_str().unwrap_or("").into();
        serde_json::from_value(value).map_err(|_| "A saved transcript segment is invalid; source files are retained".to_string())
    }).collect::<Result<_, _>>()?;
    let existing: Option<String> = sqlx::query_scalar("SELECT id FROM meetings WHERE folder_path = ? LIMIT 1")
        .bind(&folder_string).fetch_optional(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    let id = if let Some(id) = existing { id } else {
        crate::database::repositories::transcript::TranscriptsRepository::save_transcript(state.db_manager.pool(),
            metadata["meeting_name"].as_str().unwrap_or("Recovered meeting"), &transcript, Some(folder_string)).await.map_err(|e| e.to_string())?
    };
    metadata["status"] = "recovered".into(); metadata["meeting_id"] = id.clone().into();
    if let Some(path) = &audio.audio_file_path {
        metadata["audio_file"] = Path::new(path).file_name().and_then(|name| name.to_str()).unwrap_or("audio.mp4").into();
        metadata["recovered_audio_duration_seconds"] = audio.estimated_duration_seconds.into();
    }
    metadata["recovery_note"] = "Recovered verified data. Original checkpoints retained; audio beyond the last committed frame is unconfirmed.".into();
    publish_metadata(&folder, &metadata).map_err(|e| e.to_string())?;
    Ok(RecoveredCapture { success: true, meeting_id: id, audio_recovery_status: audio })
}
#[tauri::command]
pub async fn discard_capture_recovery<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, meeting_folder: String) -> Result<(), String> {
    let _guard = super::common::acquire_engine_lifecycle_lock().await;
    if super::recording_commands::is_recording().await { return Err("Stop recording before discarding recovery data".to_string()); }
    let folder = valid_folder(Path::new(&meeting_folder), &roots(&app).await?).map_err(|e| e.to_string())?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings WHERE folder_path = ?")
        .bind(folder.to_string_lossy().as_ref()).fetch_one(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    if count != 0 { return Err("This recording is already in your library. Delete it there instead.".to_string()); }
    tokio::task::spawn_blocking(move || std::fs::remove_dir_all(folder).map_err(|e| e.to_string())).await.map_err(|_| "Recovery deletion worker failed".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn catalog_finds_audio_before_a_transcript_or_browser_index_exists() {
        let root = tempfile::tempdir().unwrap(); let folder = root.path().join("early-crash");
        std::fs::create_dir_all(folder.join(".checkpoints")).unwrap();
        std::fs::write(folder.join("metadata.json"), br#"{"status":"recording","meeting_name":"Early crash","created_at":"2026-09-05T00:00:00Z"}"#).unwrap();
        let entries = scan(&[root.path().to_path_buf()], &HashSet::new()).unwrap();
        assert_eq!(entries.len(), 1); assert_eq!(entries[0].transcript_count, 0);
    }
    #[test] fn completed_library_recordings_are_not_recovered_twice() {
        let root = tempfile::tempdir().unwrap(); let folder = root.path().join("complete");
        std::fs::create_dir_all(folder.join(".checkpoints")).unwrap();
        std::fs::write(folder.join("metadata.json"), br#"{"status":"completed"}"#).unwrap();
        let saved = [folder.canonicalize().unwrap()].into_iter().collect();
        assert!(scan(&[root.path().to_path_buf()], &saved).unwrap().is_empty());
        assert_eq!(scan(&[root.path().to_path_buf()], &HashSet::new()).unwrap().len(), 1);
    }
    #[test] fn recovery_rejects_folders_outside_configured_roots() {
        let root = tempfile::tempdir().unwrap(); let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("metadata.json"), b"{}").unwrap();
        assert!(valid_folder(outside.path(), &[root.path().to_path_buf()]).is_err());
    }
}
