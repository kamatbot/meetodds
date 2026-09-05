use anyhow::{anyhow, Result};
use log::{error, warn};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio::task::JoinHandle;

use super::audio_processing::create_meeting_folder;
use super::incremental_saver::IncrementalAudioSaver;
use super::recording_state::AudioChunk;
#[path = "save_worker.rs"]
mod save_worker;

type FailureCallback = Arc<dyn Fn() + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: String, pub text: String,
    pub audio_start_time: f64, pub audio_end_time: f64, pub duration: f64,
    pub display_time: String, pub confidence: f32, pub sequence_id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingMetadata {
    pub version: String, pub meeting_id: Option<String>, pub meeting_name: Option<String>,
    pub created_at: String, pub completed_at: Option<String>, pub duration_seconds: Option<f64>,
    pub devices: DeviceInfo, pub audio_file: String, pub transcript_file: String,
    pub sample_rate: u32, pub status: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo { pub microphone: Option<String>, pub system_audio: Option<String> }

/// Flush data before replacing a recovery document. Unique temp names avoid writer collisions.
fn durable_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow!("Missing checkpoint directory"))?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(file.as_file_mut(), value)?;
    file.flush()?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| anyhow!("Could not replace recovery checkpoint: {}", e.error))?;
    #[cfg(unix)]
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

fn remember_failure(error: &Arc<Mutex<Option<String>>>, callback: &Arc<Mutex<Option<FailureCallback>>>, message: &str) {
    let first = match error.lock() {
        Ok(mut saved) => { let first = saved.is_none(); if first { *saved = Some(message.to_string()); } first }
        Err(_) => true,
    };
    if first {
        // Clone and release the callback lock before entering recording-state error handling.
        let notify = callback.lock().ok().and_then(|notify| notify.clone());
        if let Some(notify) = notify { notify(); }
    }
}

pub struct RecordingSaver {
    incremental_saver: Option<Arc<AsyncMutex<IncrementalAudioSaver>>>,
    meeting_folder: Option<PathBuf>, meeting_name: Option<String>, metadata: Option<MeetingMetadata>,
    transcript_segments: Arc<Mutex<Vec<TranscriptSegment>>>,
    transcript_write_lock: Mutex<()>,
    failure: Arc<Mutex<Option<String>>>,
    failure_callback: Arc<Mutex<Option<FailureCallback>>>,
    worker: Option<JoinHandle<Result<(), String>>>, shutdown: Option<oneshot::Sender<()>>,
    capture_session_id: String,
    recording_folder: Option<PathBuf>,
    finalized_audio: Option<String>, saved_result: Option<Option<String>>,
}

impl RecordingSaver {
    pub fn new() -> Self {
        Self {
            incremental_saver: None, meeting_folder: None, meeting_name: None, metadata: None,
            transcript_segments: Arc::new(Mutex::new(Vec::new())), transcript_write_lock: Mutex::new(()),
            failure: Arc::new(Mutex::new(None)), failure_callback: Arc::new(Mutex::new(None)),
            worker: None, shutdown: None, capture_session_id: uuid::Uuid::new_v4().to_string(),
            finalized_audio: None, saved_result: None, recording_folder: None,
        }
    }
    pub fn set_meeting_name(&mut self, name: Option<String>) { self.meeting_name = name; }
    pub fn set_recording_folder(&mut self, folder: PathBuf) { self.recording_folder = Some(folder); }
    pub fn set_failure_callback(&self, callback: impl Fn() + Send + Sync + 'static) {
        if let Ok(mut stored) = self.failure_callback.lock() { *stored = Some(Arc::new(callback)); }
    }
    pub fn last_failure(&self) -> Option<String> {
        self.failure.lock().map(|e| e.clone()).unwrap_or_else(|_| Some("Recording save state is unavailable".to_string()))
    }
    fn fail(&self, message: &str) { remember_failure(&self.failure, &self.failure_callback, message); }
    pub fn mark_incomplete(&self, message: &str) { self.fail(message); }
    pub fn ensure_initialized(&self) -> Result<()> {
        if let Some(error) = self.last_failure() { return Err(anyhow!(error)); }
        if self.meeting_folder.is_none() || self.worker.is_none() { return Err(anyhow!("Recording storage was not initialized")); }
        Ok(())
    }
    pub fn set_device_info(&mut self, microphone: Option<String>, system_audio: Option<String>) {
        if let Some(metadata) = self.metadata.as_mut() {
            metadata.devices = DeviceInfo { microphone, system_audio };
        }
        if let (Some(folder), Some(metadata)) = (&self.meeting_folder, &self.metadata) {
            if self.write_metadata(folder, metadata).is_err() { self.fail("Recording metadata could not be saved. Check disk space and folder permissions."); }
        }
    }
    pub fn add_transcript_segment(&self, segment: TranscriptSegment) {
        // Serialize update + snapshot + persistence, not just vector access. Older writes cannot win.
        let result = (|| -> Result<()> {
            let _write = self.transcript_write_lock.lock().map_err(|_| anyhow!("Transcript writer unavailable"))?;
            {
                let mut segments = self.transcript_segments.lock().map_err(|_| anyhow!("Transcript state unavailable"))?;
                if let Some(existing) = segments.iter_mut().find(|s| s.sequence_id == segment.sequence_id) { *existing = segment; }
                else { segments.push(segment); }
            }
            if let Some(folder) = &self.meeting_folder { self.write_transcripts_json(folder)?; }
            Ok(())
        })();
        if result.is_err() { self.fail("Transcript checkpoint could not be saved. Check disk space and folder permissions; stop and recover this recording."); }
    }
    pub fn add_transcript_chunk(&self, text: String) {
        self.add_transcript_segment(TranscriptSegment {
            id: format!("seg_{}", chrono::Utc::now().timestamp_millis()), text,
            audio_start_time: 0.0, audio_end_time: 0.0, duration: 0.0, display_time: "[00:00]".to_string(),
            confidence: 1.0, sequence_id: 0, speaker: None, speaker_label: None, speaker_source: None, speaker_confidence: None,
        });
    }

    /// Existing sender type is preserved. The manager must call ensure_initialized before opening streams.
    pub fn start_accumulation(&mut self, auto_save: bool) -> mpsc::UnboundedSender<AudioChunk> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let name = self.meeting_name.clone().unwrap_or_else(|| format!("Meeting {}", self.capture_session_id));
        if self.initialize_meeting_folder(&name, auto_save).is_err() {
            self.fail("Recording storage is unavailable. Check free space and folder permissions before starting.");
            drop(receiver);
            return sender;
        }
        let (shutdown, stopped) = oneshot::channel();
        self.shutdown = Some(shutdown);
        let saver = self.incremental_saver.clone();
        let failure = self.failure.clone();
        let notify = self.failure_callback.clone();
        self.worker = Some(tokio::spawn(async move {
            let result = save_worker::drain_until_closed(receiver, stopped, move |chunk| {
                let saver = saver.clone();
                async move {
                    if let Some(saver) = saver {
                        // Checkpoint encoding and filesystem calls never block the async audio executor.
                        tokio::task::spawn_blocking(move || saver.blocking_lock().add_chunk(chunk))
                            .await.map_err(|_| "Recording checkpoint worker failed".to_string())?
                            .map_err(|_| "Audio checkpoint could not be written. Check disk space and folder permissions.".to_string())?;
                    }
                    Ok(())
                }
            }).await;
            if let Err(message) = &result { remember_failure(&failure, &notify, message); }
            result
        }));
        sender
    }
    fn initialize_meeting_folder(&mut self, name: &str, audio: bool) -> Result<()> {
        // This preserves the existing effective location. Configured-folder routing is a separate migration.
        let base = self.recording_folder.clone().unwrap_or_else(super::recording_preferences::get_default_recordings_folder);
        let folder = create_meeting_folder(&base, name, audio)?;
        let metadata = MeetingMetadata {
            version: "1.0".to_string(), meeting_id: None, meeting_name: Some(name.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(), completed_at: None, duration_seconds: None,
            devices: DeviceInfo { microphone: None, system_audio: None },
            audio_file: if audio { "audio.mp4".to_string() } else { String::new() },
            transcript_file: "transcripts.json".to_string(), sample_rate: 48000, status: "recording".to_string(),
        };
        self.write_metadata(&folder, &metadata)?;
        #[cfg(unix)]
        std::fs::File::open(&base)?.sync_all()?;
        self.write_transcripts_json(&folder)?;
        if audio { self.incremental_saver = Some(Arc::new(AsyncMutex::new(IncrementalAudioSaver::new(folder.clone(), 48000)?))); }
        self.meeting_folder = Some(folder); self.metadata = Some(metadata);
        Ok(())
    }
    fn write_metadata(&self, folder: &Path, metadata: &MeetingMetadata) -> Result<()> {
        let mut value = serde_json::to_value(metadata)?;
        // Capture identity is distinct from the DB meeting row created later in the existing lifecycle.
        value["capture_session_id"] = serde_json::json!(self.capture_session_id);
        durable_json(&folder.join("metadata.json"), &value)
    }
    fn write_transcripts_json(&self, folder: &Path) -> Result<()> {
        let segments = self.transcript_segments.lock().map_err(|_| anyhow!("Transcript state unavailable"))?.clone();
        durable_json(&folder.join("transcripts.json"), &serde_json::json!({
            "version": "1.0", "segments": segments, "last_updated": chrono::Utc::now().to_rfc3339(), "total_segments": segments.len(),
        }))
    }
    pub fn get_stats(&self) -> (usize, u32) {
        (self.incremental_saver.as_ref().and_then(|saver| saver.try_lock().ok().map(|s| s.get_checkpoint_count() as usize)).unwrap_or(0), 48000)
    }
    async fn drain(&mut self) -> Result<(), String> {
        if let Some(shutdown) = self.shutdown.take() { let _ = shutdown.send(()); }
        if let Some(mut worker) = self.worker.take() {
            match tokio::time::timeout(std::time::Duration::from_secs(60), &mut worker).await {
                Ok(Ok(result)) => result?,
                Ok(Err(_)) => {
                    let message = "Recording checkpoint worker failed. Preserve the recovery folder.";
                    self.fail(message);
                    return Err(message.to_string());
                }
                Err(_) => {
                    // Do not abort a disk write. Preserve the handle and on-disk checkpoints for retry/recovery.
                    self.worker = Some(worker);
                    return Err("Saving has not finished. Keep the app open; existing checkpoints are preserved.".to_string());
                }
            }
        }
        Ok(())
    }
    pub async fn stop_and_save<R: Runtime>(&mut self, app: &AppHandle<R>, duration: Option<f64>) -> Result<Option<String>, String> {
        if let Some(result) = &self.saved_result { return Ok(result.clone()); }
        self.drain().await?;
        let folder = self.meeting_folder.clone().ok_or_else(|| "Recording folder is unavailable".to_string())?;
        self.write_transcripts_json(&folder).map_err(|_| "Final transcript checkpoint could not be saved".to_string())?;
        if let Some(error) = self.last_failure() {
            if let Some(metadata) = self.metadata.as_mut() { metadata.status = "error".to_string(); }
            if let Some(metadata) = &self.metadata { let _ = self.write_metadata(&folder, metadata); }
            return Err(error);
        }
        let audio = if let Some(path) = &self.finalized_audio { Some(path.clone()) }
        else if let Some(saver) = self.incremental_saver.clone() {
            let runtime = tokio::runtime::Handle::current();
            let path = tokio::task::spawn_blocking(move || runtime.block_on(async move {
                saver.lock().await.finalize().await
            })).await.map_err(|_| "Audio finalization worker failed".to_string())?
                .map_err(|_| "Audio finalization failed. Keep the recording folder for recovery.".to_string())?;
            std::fs::OpenOptions::new().read(true).write(true).open(&path).and_then(|file| file.sync_all())
                .map_err(|_| "Final audio could not be flushed to disk".to_string())?;
            let path = path.to_string_lossy().to_string();
            self.finalized_audio = Some(path.clone());
            Some(path)
        } else { None };
        if let Some(metadata) = self.metadata.as_mut() {
            metadata.status = "completed".to_string(); metadata.completed_at = Some(chrono::Utc::now().to_rfc3339());
            metadata.duration_seconds = duration.filter(|d| d.is_finite() && *d >= 0.0);
            metadata.audio_file = audio.as_ref().and_then(|path| Path::new(path).file_name()).map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        }
        if let Some(metadata) = &self.metadata { self.write_metadata(&folder, metadata).map_err(|_| "Final recording metadata could not be saved".to_string())?; }
        if let Some(saver) = self.incremental_saver.clone() {
            let cleanup = tokio::task::spawn_blocking(move || saver.blocking_lock().finish_commit()).await;
            if !matches!(cleanup, Ok(Ok(()))) { warn!("Recording committed; recovery checkpoints could not be removed"); }
        }
        let receipt = serde_json::json!({
            "audio_file": audio.clone().unwrap_or_default(), "audio_retained": audio.is_some(),
            "transcript_file": folder.join("transcripts.json").to_string_lossy(),
            "meeting_name": self.meeting_name, "meeting_folder": folder.to_string_lossy(), "capture_session_id": self.capture_session_id,
        });
        if app.emit("recording-saved", receipt).is_err() { warn!("Recording saved, but the UI acknowledgement could not be delivered"); }
        if let Ok(mut segments) = self.transcript_segments.lock() { segments.clear(); }
        self.saved_result = Some(audio.clone());
        Ok(audio)
    }
    pub fn get_meeting_folder(&self) -> Option<&PathBuf> { self.meeting_folder.as_ref() }
    pub fn get_transcript_segments(&self) -> Vec<TranscriptSegment> { self.transcript_segments.lock().map(|s| s.clone()).unwrap_or_default() }
    pub fn get_meeting_name(&self) -> Option<String> { self.meeting_name.clone() }
}
impl Default for RecordingSaver { fn default() -> Self { Self::new() } }
impl Drop for RecordingSaver {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() { let _ = shutdown.send(()); }
        if self.last_failure().is_some() { error!("Recording saver closed with a persistence failure; preserve its recovery folder"); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_snapshot_replaces_a_previous_revision() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("transcripts.json");
        durable_json(&path, &serde_json::json!({"revision": 1})).unwrap();
        durable_json(&path, &serde_json::json!({"revision": 2})).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&std::fs::read(path).unwrap()).unwrap()["revision"], 2);
    }
    #[test]
    fn capture_id_is_not_a_fabricated_database_meeting_id() {
        let first = RecordingSaver::new(); let second = RecordingSaver::new();
        assert_ne!(first.capture_session_id, second.capture_session_id);
        assert!(first.metadata.is_none());
    }
}
