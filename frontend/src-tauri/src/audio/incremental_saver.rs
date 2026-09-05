use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use super::ffmpeg::find_ffmpeg_path;
use super::recording_state::AudioChunk;
#[path = "pcm_journal.rs"]
mod pcm_journal;
use pcm_journal::{JournalReceipt, PcmJournal};

const JOURNAL_NAME: &str = "audio.pcmj";
fn active() -> &'static Mutex<HashSet<PathBuf>> {
    static ACTIVE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}
fn ensure_inactive(folder: &Path) -> Result<()> {
    if active().lock().map_err(|_| anyhow!("Recording registry unavailable"))?.contains(folder) {
        return Err(anyhow!("Stop this recording before recovering or deleting its checkpoints"));
    }
    Ok(())
}
fn sync_file(path: &Path) -> Result<()> {
    OpenOptions::new().read(true).write(true).open(path)?.sync_all()?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() { File::open(parent)?.sync_all()?; }
    Ok(())
}
fn command() -> Result<std::process::Command> {
    let mut command = std::process::Command::new(find_ffmpeg_path().ok_or_else(|| anyhow!("FFmpeg is unavailable; audio checkpoints are retained for recovery"))?);
    command.args(["-nostdin", "-hide_banner", "-loglevel", "error"]);
    #[cfg(target_os = "windows")] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command)
}
fn publish(mut process: std::process::Command, folder: &Path, _recovered: bool) -> Result<PathBuf> {
    let temp = tempfile::Builder::new().prefix(".audio-finalizing-").suffix(".mp4").tempfile_in(folder)?;
    let temp_path = temp.into_temp_path();
    let result = process.args(["-y"]).arg(temp_path.as_os_str()).output()?;
    if !result.status.success() { return Err(anyhow!("Audio encoding failed; source checkpoints have been retained")); }
    if std::fs::metadata(&temp_path)?.len() < 32 { return Err(anyhow!("Encoded audio is empty; source checkpoints have been retained")); }
    sync_file(&temp_path)?;
    let preferred = folder.join("audio.mp4");
    let destination = if preferred.exists() {
        folder.join(format!("audio-recovered-{}.mp4", uuid::Uuid::new_v4()))
    } else { preferred };
    temp_path.persist_noclobber(&destination).map_err(|error| anyhow!("Cannot publish audio: {}", error.error))?;
    sync_file(&destination)?;
    Ok(destination)
}
fn encode_journal(folder: &Path, recovered: bool) -> Result<(PathBuf, JournalReceipt)> {
    let journal = folder.join(".checkpoints").join(JOURNAL_NAME);
    let mut pcm = tempfile::Builder::new().prefix(".recovery-").suffix(".f32le").tempfile_in(folder)?;
    let receipt = pcm_journal::replay(&journal, pcm.as_file_mut())?;
    if receipt.samples == 0 { return Err(anyhow!("No acknowledged audio frames to recover")); }
    pcm.flush()?;
    let mut process = command()?;
    process.args(["-f", "f32le", "-ar", &receipt.sample_rate.to_string(), "-ac", "1", "-i"])
        .arg(pcm.path()).args(["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]);
    Ok((publish(process, folder, recovered)?, receipt))
}
fn legacy_checkpoints(folder: &Path) -> Result<Vec<PathBuf>> {
    let directory = folder.join(".checkpoints");
    if !directory.exists() { return Ok(Vec::new()); }
    let mut files = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(number) = name.strip_prefix("audio_chunk_").and_then(|value| value.strip_suffix(".mp4")) {
            if let Ok(index) = number.parse::<u64>() { files.push((index, entry.path())); }
        }
    }
    files.sort_by_key(|(index, _)| *index);
    Ok(files.into_iter().map(|(_, path)| path).collect())
}
fn merge_legacy(folder: &Path, files: &[PathBuf]) -> Result<PathBuf> {
    let mut list = tempfile::Builder::new().prefix("concat-").suffix(".txt").tempfile_in(folder.join(".checkpoints"))?;
    for path in files {
        let name = path.file_name().and_then(|name| name.to_str()).ok_or_else(|| anyhow!("Invalid checkpoint name"))?;
        writeln!(list, "file '{name}'")?;
    }
    list.flush()?;
    let mut process = command()?;
    process.args(["-f", "concat", "-safe", "1", "-i"]).arg(list.path()).args(["-c", "copy"]);
    publish(process, folder, true)
}

/// Compatible facade; audio is now journaled at every mixed chunk, not buffered for 30 seconds.
pub struct IncrementalAudioSaver {
    journal: Option<PcmJournal>,
    meeting_folder: PathBuf,
    finalized: Option<PathBuf>,
}
impl IncrementalAudioSaver {
    pub fn new(meeting_folder: PathBuf, sample_rate: u32) -> Result<Self> {
        let folder = meeting_folder.canonicalize()?;
        let directory = folder.join(".checkpoints");
        if !directory.is_dir() || std::fs::symlink_metadata(&directory)?.file_type().is_symlink() {
            return Err(anyhow!("Invalid checkpoint directory"));
        }
        let journal = PcmJournal::create(&directory.join(JOURNAL_NAME), sample_rate)?;
        active().lock().map_err(|_| anyhow!("Recording registry unavailable"))?.insert(folder.clone());
        Ok(Self { journal: Some(journal), meeting_folder: folder, finalized: None })
    }
    pub fn add_chunk(&mut self, chunk: AudioChunk) -> Result<()> {
        self.journal.as_mut().ok_or_else(|| anyhow!("Recording has already been finalized"))?.append(&chunk.data, chunk.sample_rate)?;
        Ok(())
    }
    pub fn get_checkpoint_count(&self) -> u32 {
        self.journal.as_ref().map(|journal| journal.receipt().frames.min(u32::MAX as u64) as u32).unwrap_or(0)
    }
    pub fn get_meeting_folder(&self) -> &PathBuf { &self.meeting_folder }
    pub fn finish_commit(&mut self) -> Result<()> {
        if self.finalized.is_none() { return Err(anyhow!("Audio has not been finalized")); }
        self.journal.take();
        cleanup_committed_checkpoints(&self.meeting_folder)
    }
    pub async fn finalize(&mut self) -> Result<PathBuf> {
        if let Some(path) = &self.finalized { return Ok(path.clone()); }
        let expected = self.journal.as_ref().ok_or_else(|| anyhow!("Recording journal unavailable"))?.receipt();
        if expected.samples == 0 { return Err(anyhow!("No audio checkpoints to finalize")); }
        let (path, verified) = encode_journal(&self.meeting_folder, false)?;
        if verified != expected { return Err(anyhow!("Audio journal failed verification; preserve the recovery folder")); }
        self.finalized = Some(path.clone());
        // The outer saver must durably commit metadata + transcript before journal cleanup.
        Ok(path)
    }
}
impl Drop for IncrementalAudioSaver {
    fn drop(&mut self) {
        self.journal.take();
        if let Ok(mut active) = active().lock() { active.remove(&self.meeting_folder); }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioRecoveryStatus {
    pub status: String,
    pub chunk_count: u32,
    pub estimated_duration_seconds: f64,
    pub audio_file_path: Option<String>,
    pub message: String,
}
#[tauri::command]
pub async fn recover_audio_from_checkpoints(meeting_folder: String, _sample_rate: u32) -> Result<AudioRecoveryStatus, String> {
    tokio::task::spawn_blocking(move || -> Result<AudioRecoveryStatus> {
        let folder = PathBuf::from(meeting_folder).canonicalize()?;
        ensure_inactive(&folder)?;
        let journal = folder.join(".checkpoints").join(JOURNAL_NAME);
        if journal.is_file() {
            let (audio, receipt) = encode_journal(&folder, true)?;
            return Ok(AudioRecoveryStatus {
                status: "partial".to_string(), chunk_count: receipt.frames.min(u32::MAX as u64) as u32,
                estimated_duration_seconds: receipt.duration_seconds(), audio_file_path: Some(audio.to_string_lossy().to_string()),
                message: format!("Recovered {:.2} seconds from {} verified audio frames. {}Audio after the last durable frame cannot be confirmed. Original checkpoints are retained.",
                    receipt.duration_seconds(), receipt.frames, if receipt.incomplete_tail { "An incomplete or damaged suffix was excluded. " } else { "" }),
            });
        }
        let files = legacy_checkpoints(&folder)?;
        if files.is_empty() { return Ok(AudioRecoveryStatus { status: "none".to_string(), chunk_count: 0,
            estimated_duration_seconds: 0.0, audio_file_path: None, message: "No audio checkpoints found".to_string() }); }
        let path = merge_legacy(&folder, &files)?;
        Ok(AudioRecoveryStatus { status: "partial".to_string(), chunk_count: files.len().min(u32::MAX as usize) as u32,
            estimated_duration_seconds: files.len() as f64 * 30.0, audio_file_path: Some(path.to_string_lossy().to_string()),
            message: "Recovered legacy compressed checkpoints. Duration is estimated; the last buffered audio and any missing checkpoints cannot be confirmed. Originals retained.".to_string() })
    }).await.map_err(|_| "Audio recovery worker failed".to_string())?.map_err(|e| e.to_string())
}

/// Called only after the outer recorder commits completed metadata and transcript files.
pub fn cleanup_committed_checkpoints(folder: &Path) -> Result<()> {
    let metadata: serde_json::Value = serde_json::from_slice(&std::fs::read(folder.join("metadata.json"))?)?;
    if metadata["status"] != "completed" { return Err(anyhow!("Recording is not fully committed; checkpoints retained")); }
    let filename = metadata["audio_file"].as_str().filter(|name| !name.is_empty()).ok_or_else(|| anyhow!("No committed audio receipt"))?;
    if Path::new(filename).components().count() != 1 { return Err(anyhow!("Invalid audio filename")); }
    let audio = folder.join(filename);
    if std::fs::metadata(&audio)?.len() < 32 || !folder.join("transcripts.json").is_file() { return Err(anyhow!("Committed recording is incomplete")); }
    sync_file(&audio)?;
    sync_file(&folder.join("metadata.json"))?;
    sync_file(&folder.join("transcripts.json"))?;
    let checkpoints = folder.join(".checkpoints");
    if checkpoints.exists() {
        if std::fs::symlink_metadata(&checkpoints)?.file_type().is_symlink() { return Err(anyhow!("Refusing symlink checkpoint cleanup")); }
        std::fs::remove_dir_all(checkpoints)?;
        #[cfg(unix)] File::open(folder)?.sync_all()?;
    }
    Ok(())
}
#[tauri::command]
pub async fn cleanup_checkpoints(meeting_folder: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<()> {
        let folder = PathBuf::from(meeting_folder).canonicalize()?;
        ensure_inactive(&folder)?;
        cleanup_committed_checkpoints(&folder)
    }).await.map_err(|_| "Checkpoint cleanup worker failed".to_string())?.map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn has_audio_checkpoints(meeting_folder: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || -> Result<bool> {
        let folder = PathBuf::from(meeting_folder);
        let journal = folder.join(".checkpoints").join(JOURNAL_NAME);
        if journal.is_file() { return Ok(std::fs::metadata(journal)?.len() > 16); }
        Ok(!legacy_checkpoints(&folder)?.is_empty())
    }).await.map_err(|_| "Checkpoint lookup worker failed".to_string())?.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test] async fn empty_recording_does_not_produce_a_false_receipt() {
        let temp = tempfile::tempdir().unwrap(); std::fs::create_dir(temp.path().join(".checkpoints")).unwrap();
        let mut saver = IncrementalAudioSaver::new(temp.path().to_path_buf(), 48_000).unwrap();
        assert!(saver.finalize().await.unwrap_err().to_string().contains("No audio checkpoints"));
    }
    #[test] fn active_recording_cannot_be_recovered_or_cleaned() {
        let temp = tempfile::tempdir().unwrap(); std::fs::create_dir(temp.path().join(".checkpoints")).unwrap();
        let saver = IncrementalAudioSaver::new(temp.path().to_path_buf(), 48_000).unwrap();
        let folder = temp.path().canonicalize().unwrap(); assert!(ensure_inactive(&folder).is_err());
        drop(saver); assert!(ensure_inactive(&folder).is_ok());
    }
    #[test] fn legacy_files_sort_numerically_after_chunk_999() {
        let temp = tempfile::tempdir().unwrap(); let directory = temp.path().join(".checkpoints"); std::fs::create_dir(&directory).unwrap();
        for name in ["audio_chunk_999.mp4", "audio_chunk_1000.mp4", "unrelated.mp4", "audio_chunk_no.mp4"] { std::fs::write(directory.join(name), b"test").unwrap(); }
        let files = legacy_checkpoints(temp.path()).unwrap(); assert_eq!(files.len(), 2);
        assert!(files[0].ends_with("audio_chunk_999.mp4")); assert!(files[1].ends_with("audio_chunk_1000.mp4"));
    }
    #[test] fn incomplete_metadata_cannot_delete_recovery_audio() {
        let temp = tempfile::tempdir().unwrap(); std::fs::create_dir(temp.path().join(".checkpoints")).unwrap();
        std::fs::write(temp.path().join("metadata.json"), br#"{"status":"recording","audio_file":"audio.mp4"}"#).unwrap();
        assert!(cleanup_committed_checkpoints(temp.path()).is_err()); assert!(temp.path().join(".checkpoints").exists());
    }
    #[tokio::test]
    async fn real_codec_finalization_keeps_journal_until_metadata_commit() {
        let temp = tempfile::tempdir().unwrap(); let folder = temp.path();
        std::fs::create_dir(folder.join(".checkpoints")).unwrap();
        let mut saver = IncrementalAudioSaver::new(folder.to_path_buf(), 48_000).unwrap();
        saver.add_chunk(AudioChunk { data: vec![0.1; 12_000], sample_rate: 48_000, timestamp: 0.0, chunk_id: 0,
            device_type: super::super::recording_state::DeviceType::Microphone }).unwrap();
        let path = saver.finalize().await.unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > 32);
        assert!(folder.join(".checkpoints/audio.pcmj").exists());
        std::fs::write(folder.join("transcripts.json"), b"{\"segments\":[]}").unwrap();
        std::fs::write(folder.join("metadata.json"), br#"{"status":"completed","audio_file":"audio.mp4"}"#).unwrap();
        saver.finish_commit().unwrap();
        assert!(!folder.join(".checkpoints").exists());
        assert!(path.exists());
    }

}
