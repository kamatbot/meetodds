//! Real source validation. Test buffers are discarded: no recording files, ASR or network.
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use super::devices::{default_input_device, default_output_device, parse_audio_device, AudioDevice, DeviceType as DeviceKind};
use super::recording_state::{AudioChunk, DeviceType, RecordingState};
use super::stream::AudioStream;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCheck {
    pub device_name: Option<String>,
    pub source: String,
    /// signal | silent | no_frames | unavailable | permission_denied | cancelled
    pub status: String,
    pub samples_received: u64,
    pub rms: f64,
    pub peak: f32,
    pub message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePreflight {
    pub microphone: SourceCheck,
    pub system_audio: SourceCheck,
    pub audio_retained: bool,
    pub recording_folder: String,
    pub storage_writable: bool,
    pub storage_message: String,
}

struct ProbeGuard { state: Arc<RecordingState>, stream: Option<AudioStream> }
impl Drop for ProbeGuard {
    fn drop(&mut self) { self.state.stop_recording(); self.stream.take(); self.state.cleanup(); }
}
fn unavailable(source: &str, error: &str) -> SourceCheck {
    let lower = error.to_lowercase();
    let denied = lower.contains("permission") || lower.contains("denied") || lower.contains("not authorized");
    SourceCheck { device_name: None, source: source.to_string(), status: if denied { "permission_denied" } else { "unavailable" }.to_string(),
        samples_received: 0, rms: 0.0, peak: 0.0,
        message: if denied { "Allow this source in system privacy settings, then test again." } else { "This source could not be opened. Check its connection and selection, then test again." }.to_string() }
}
fn device(name: Option<String>, system: bool) -> Result<AudioDevice> {
    let device = match name.filter(|name| !name.trim().is_empty()) {
        Some(name) => parse_audio_device(&name)?,
        None if system => default_output_device()?,
        None => default_input_device()?,
    };
    let expected = if system { DeviceKind::Output } else { DeviceKind::Input };
    if device.device_type != expected { return Err(anyhow!("Wrong audio source type")); }
    Ok(device)
}

pub async fn probe_source<R: Runtime>(app: &AppHandle<R>, requested: Result<AudioDevice>, system: bool, cancel: CancellationToken) -> SourceCheck {
    let source = if system { "system" } else { "microphone" };
    let device = match requested { Ok(device) => device, Err(error) => return unavailable(source, &error.to_string()) };
    let name = device.to_string();
    let state = RecordingState::new();
    let (sender, mut receiver) = mpsc::unbounded_channel::<AudioChunk>();
    state.set_audio_sender(sender);
    if state.start_recording().is_err() { return unavailable(source, "Audio state could not start"); }
    let mut guard = ProbeGuard { state: state.clone(), stream: None };
    let kind = if system { DeviceType::System } else { DeviceType::Microphone };
    let stream = tokio::select! {
        _ = cancel.cancelled() => return SourceCheck { status: "cancelled".to_string(), ..unavailable(source, "cancelled") },
        stream = tokio::time::timeout(Duration::from_secs(8), AudioStream::create(Arc::new(device), state, kind, None)) => stream,
    };
    guard.stream = match stream {
        Ok(Ok(stream)) => Some(stream),
        Ok(Err(error)) => { let mut check = unavailable(source, &error.to_string()); check.device_name = Some(name); return check; }
        Err(_) => { let mut check = unavailable(source, "Audio source timed out"); check.device_name = Some(name); return check; }
    };
    let deadline = Instant::now() + Duration::from_millis(2500);
    let mut samples = 0_u64;
    let mut sum_squares = 0.0_f64;
    let mut peak = 0.0_f32;
    let mut last_emit = Instant::now();
    while Instant::now() < deadline && !cancel.is_cancelled() {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_millis(100)) => {},
            chunk = receiver.recv() => {
                let Some(chunk) = chunk else { break; };
                for sample in chunk.data.iter().copied().filter(|v| v.is_finite()) {
                    samples += 1; sum_squares += f64::from(sample).powi(2); peak = peak.max(sample.abs());
                }
            }
        }
        if last_emit.elapsed() >= Duration::from_millis(100) {
            let rms = if samples == 0 { 0.0 } else { (sum_squares / samples as f64).sqrt() };
            let _ = app.emit("audio-levels", serde_json::json!({
                "timestamp": chrono::Utc::now().timestamp_millis(),
                "levels": [{"device_name": name, "device_type": if system { "output" } else { "input" },
                    "rms_level": rms, "peak_level": peak, "is_active": rms >= 0.0003,
                    "samples_received": samples, "measured": true}]
            }));
            last_emit = Instant::now();
        }
    }
    let rms = if samples == 0 { 0.0 } else { (sum_squares / samples as f64).sqrt() };
    let (status, message) = if cancel.is_cancelled() { ("cancelled", "Audio test cancelled.") }
        else if samples == 0 { ("no_frames", "No audio frames arrived. Check capture permissions and the selected source; silence alone cannot diagnose permission.") }
        else if rms < 0.0003 { ("silent", "The source is open but was silent. Speak or play meeting audio and test again, or explicitly continue with silence.") }
        else { ("signal", "Audio samples received. This verifies capture, not speech recognition accuracy.") };
    SourceCheck { device_name: Some(name), source: source.to_string(), status: status.to_string(), samples_received: samples, rms, peak, message: message.to_string() }
}

pub async fn probe_named_sources<R: Runtime>(app: &AppHandle<R>, names: Vec<String>, cancel: CancellationToken) -> Result<()> {
    if names.is_empty() || names.len() > 2 { return Err(anyhow!("Select one microphone and/or one system source to test")); }
    // Prevent testing streams from competing with an actual recording or another engine lifecycle operation.
    let _guard = super::common::acquire_engine_lifecycle_lock().await;
    if super::recording_commands::is_recording().await { return Err(anyhow!("Stop recording before testing audio sources")); }
    for name in names {
        if cancel.is_cancelled() { break; }
        let parsed = parse_audio_device(&name)?;
        let system = parsed.device_type == DeviceKind::Output;
        let check = probe_source(app, Ok(parsed), system, cancel.child_token()).await;
        let _ = app.emit("capture-preflight-source", &check);
    }
    Ok(())
}

#[tauri::command]
pub async fn run_capture_preflight<R: Runtime>(app: AppHandle<R>, mic_device_name: Option<String>, system_device_name: Option<String>, include_system: bool) -> Result<CapturePreflight, String> {
    let _guard = super::common::acquire_engine_lifecycle_lock().await;
    if super::recording_commands::is_recording().await { return Err("Stop recording before running an audio test".to_string()); }
    let preferences = super::recording_preferences::load_recording_preferences(&app).await.map_err(|_| "Recording preferences could not be read; retention was not changed".to_string())?;
    let folder = preferences.save_folder.clone();
    let storage = tokio::task::spawn_blocking(move || -> Result<()> {
        std::fs::create_dir_all(&folder)?;
        let mut test = tempfile::NamedTempFile::new_in(&folder)?;
        use std::io::Write;
        test.write_all(b"MeetOdds writable storage check")?;
        test.as_file().sync_all()?;
        Ok(())
    }).await;
    let writable = matches!(storage, Ok(Ok(())));
    let mic = device(mic_device_name, false);
    let cancel = CancellationToken::new();
    let microphone;
    let system_audio;
    if include_system {
        (microphone, system_audio) = tokio::join!(
            probe_source(&app, mic, false, cancel.child_token()),
            probe_source(&app, device(system_device_name, true), true, cancel.child_token())
        );
    } else {
        microphone = probe_source(&app, mic, false, cancel).await;
        system_audio = SourceCheck { status: "disabled".to_string(), message: "Microphone-only capture explicitly selected.".to_string(), ..unavailable("system", "disabled") };
    }
    Ok(CapturePreflight { microphone, system_audio, audio_retained: preferences.auto_save,
        recording_folder: preferences.save_folder.to_string_lossy().to_string(), storage_writable: writable,
        storage_message: if writable { "A temporary local file was written and flushed successfully. Free capacity is not guaranteed for a full meeting." } else { "The recording folder could not be written. Check free space and permissions before recording." }.to_string() })
}
