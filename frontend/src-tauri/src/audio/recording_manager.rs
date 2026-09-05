use anyhow::Result;
use log::{debug, error, info, warn};
use std::sync::Arc;
use tokio::sync::mpsc;
use tauri::Emitter;
use super::devices::{list_audio_devices, AudioDevice};
#[cfg(target_os = "macos")]
use super::devices::get_safe_recording_devices_macos;
#[cfg(not(target_os = "macos"))]
use super::devices::{default_input_device, default_output_device};
use super::device_monitor::{AudioDeviceMonitor, DeviceEvent, DeviceMonitorType};
use super::pipeline::AudioPipelineManager;
use super::recording_saver::RecordingSaver;
use super::recording_state::{AudioChunk, AudioError, DeviceType as RecordingDeviceType, RecordingState};
use super::stream::AudioStreamManager;

pub enum StreamManagerType { Standard(AudioStreamManager) }

/// Coordinates capture, canonical transcription and the independent recording writer.
pub struct RecordingManager {
    state: Arc<RecordingState>,
    stream_manager: AudioStreamManager,
    pipeline_manager: AudioPipelineManager,
    recording_saver: RecordingSaver,
    device_monitor: Option<AudioDeviceMonitor>,
    device_event_receiver: Option<mpsc::UnboundedReceiver<DeviceEvent>>,
    stopped_duration: Option<f64>,
}
// SAFETY: Retains the existing platform audio-wrapper Send contract.
unsafe impl Send for RecordingManager {}

impl RecordingManager {
    pub fn new() -> Self {
        let state = RecordingState::new();
        let stream_manager = AudioStreamManager::new(state.clone());
        let (device_monitor, device_event_receiver) = AudioDeviceMonitor::new();
        let recording_saver = RecordingSaver::new();
        let weak_state = Arc::downgrade(&state);
        recording_saver.set_failure_callback(move || {
            if let Some(state) = weak_state.upgrade() {
                // Fail closed on persistence errors. The existing recording-error UI is notified;
                // the detailed storage failure is returned by save_recording_only.
                state.stop_recording();
                state.report_error(AudioError::ProcessingFailed);
            }
        });
        Self { state, stream_manager, pipeline_manager: AudioPipelineManager::new(), recording_saver,
            device_monitor: Some(device_monitor), device_event_receiver: Some(device_event_receiver), stopped_duration: None }
    }

    pub async fn start_recording(&mut self, microphone_device: Option<Arc<AudioDevice>>, system_device: Option<Arc<AudioDevice>>, auto_save: bool) -> Result<mpsc::UnboundedReceiver<AudioChunk>> {
        if microphone_device.is_none() && system_device.is_none() { return Err(anyhow::anyhow!("No audio source available")); }
        let (transcription_sender, transcription_receiver) = mpsc::unbounded_channel::<AudioChunk>();
        let recording_sender = self.recording_saver.start_accumulation(auto_save);
        // Do not open capture streams or show RECORDING when the recovery folder cannot be written.
        self.recording_saver.ensure_initialized()?;
        self.stopped_duration = None;
        self.state.start_recording()?;
        let (mic_name, mic_kind) = microphone_device.as_ref().map(|mic| (
            mic.name.clone(), super::device_detection::InputDeviceKind::detect(&mic.name, 512, 48000)
        )).unwrap_or_else(|| ("No Microphone".to_string(), super::device_detection::InputDeviceKind::Unknown));
        let (sys_name, sys_kind) = system_device.as_ref().map(|sys| (
            sys.name.clone(), super::device_detection::InputDeviceKind::detect(&sys.name, 512, 48000)
        )).unwrap_or_else(|| ("No System Audio".to_string(), super::device_detection::InputDeviceKind::Unknown));
        self.recording_saver.set_device_info(microphone_device.as_ref().map(|d| d.name.clone()), system_device.as_ref().map(|d| d.name.clone()));
        self.recording_saver.ensure_initialized()?;
        if let Err(failure) = self.pipeline_manager.start(self.state.clone(), transcription_sender, None, 0, 48000, Some(recording_sender), mic_name, mic_kind, sys_name, sys_kind) {
            self.state.stop_recording();
            self.recording_saver.mark_incomplete("The audio pipeline could not start. The recovery folder is preserved.");
            return Err(failure);
        }
        // Preserve existing stream-start sequencing; this is not a save acknowledgement.
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        if let Err(failure) = self.stream_manager.start_streams(microphone_device.clone(), system_device.clone(), None).await {
            self.state.stop_recording();
            let _ = self.stream_manager.stop_streams();
            let _ = self.pipeline_manager.stop().await;
            self.recording_saver.mark_incomplete("Audio capture could not start. Check device permissions and connections.");
            return Err(failure);
        }
        if let Some(monitor) = self.device_monitor.as_mut() {
            if let Err(failure) = monitor.start_monitoring(microphone_device, system_device) { warn!("Device monitoring could not start: {}", failure); }
        }
        info!("Recording started with {} active streams", self.stream_manager.active_stream_count());
        Ok(transcription_receiver)
    }

    /// Retains the existing macOS safe-device/Bluetooth fallback and other-platform defaults.
    pub async fn start_recording_with_defaults_and_auto_save(&mut self, auto_save: bool) -> Result<mpsc::UnboundedReceiver<AudioChunk>> {
        #[cfg(target_os = "macos")]
        let (microphone_device, system_device) = {
            let (mic, system) = get_safe_recording_devices_macos()?;
            (mic.map(Arc::new), system.map(Arc::new))
        };
        #[cfg(not(target_os = "macos"))]
        let (microphone_device, system_device) = (
            default_input_device().ok().map(Arc::new), default_output_device().ok().map(Arc::new)
        );
        if microphone_device.is_none() { return Err(anyhow::anyhow!("No microphone device available")); }
        self.start_recording(microphone_device, system_device, auto_save).await
    }

    fn snapshot_duration(&mut self) {
        if self.stopped_duration.is_none() { self.stopped_duration = self.state.get_active_recording_duration(); }
    }
    pub async fn stop_streams_only(&mut self) -> Result<()> {
        self.snapshot_duration();
        if let Some(monitor) = self.device_monitor.as_mut() { monitor.stop_monitoring().await; }
        self.state.stop_recording();
        if let Err(failure) = self.stream_manager.stop_streams() {
            error!("Audio streams did not stop cleanly: {}", failure);
            self.recording_saver.mark_incomplete("Audio streams did not stop cleanly. Preserve the recording folder for recovery.");
        }
        if let Err(failure) = self.pipeline_manager.stop().await {
            error!("Audio pipeline did not stop cleanly: {}", failure);
            self.recording_saver.mark_incomplete("Audio pipeline did not finish cleanly. Preserve the recording folder for recovery.");
        }
        Ok(())
    }
    pub async fn stop_streams_and_force_flush(&mut self) -> Result<()> {
        self.snapshot_duration();
        if let Some(monitor) = self.device_monitor.as_mut() { monitor.stop_monitoring().await; }
        self.state.stop_recording();
        if let Err(failure) = self.stream_manager.stop_streams() {
            error!("Audio streams did not stop cleanly: {}", failure);
            self.recording_saver.mark_incomplete("Audio streams did not stop cleanly. Preserve the recording folder for recovery.");
        }
        if let Err(failure) = self.pipeline_manager.force_flush_and_stop().await {
            error!("Audio pipeline flush failed: {}", failure);
            self.recording_saver.mark_incomplete("The final audio flush failed. Preserve the recording folder for recovery.");
        }
        // Duration was captured before cleanup; a later save must not lose it or count ASR drain time.
        self.state.cleanup();
        Ok(())
    }
    pub async fn save_recording_only<R: tauri::Runtime>(&mut self, app: &tauri::AppHandle<R>) -> Result<()> {
        let duration = self.stopped_duration.or_else(|| self.state.get_active_recording_duration());
        if let Err(failure) = self.recording_saver.stop_and_save(app, duration).await {
            // The outer shutdown command must still release devices. Report persistence separately
            // so its generic "recording-stopped" event cannot be mistaken for a save receipt.
            let _ = app.emit("recording-save-failed", serde_json::json!({
                "message": failure,
                "folder_path": self.get_meeting_folder(),
            }));
            let _ = app.emit("recording-error", format!("Recording save needs attention: {} Keep the recording folder for recovery.", failure));
            return Err(anyhow::Error::msg(failure));
        }
        debug!("Recording persistence acknowledged");
        Ok(())
    }
    pub async fn stop_recording<R: tauri::Runtime>(&mut self, app: &tauri::AppHandle<R>) -> Result<()> {
        self.stop_streams_and_force_flush().await?;
        self.save_recording_only(app).await
    }
    pub fn get_recording_stats(&self) -> (usize, u32) { self.recording_saver.get_stats() }
    pub fn is_recording(&self) -> bool { self.state.is_recording() }
    pub fn pause_recording(&self) -> Result<()> { self.state.pause_recording() }
    pub fn resume_recording(&self) -> Result<()> {
        if let Some(failure) = self.recording_saver.last_failure() { return Err(anyhow::Error::msg(failure)); }
        self.state.resume_recording()
    }
    pub fn is_paused(&self) -> bool { self.state.is_paused() }
    pub fn is_active(&self) -> bool { self.state.is_active() }
    pub fn get_stats(&self) -> super::recording_state::RecordingStats { self.state.get_stats() }
    pub fn get_recording_duration(&self) -> Option<f64> { self.state.get_recording_duration() }
    pub fn get_active_recording_duration(&self) -> Option<f64> { self.stopped_duration.or_else(|| self.state.get_active_recording_duration()) }
    pub fn get_total_pause_duration(&self) -> f64 { self.state.get_total_pause_duration() }
    pub fn get_current_pause_duration(&self) -> Option<f64> { self.state.get_current_pause_duration() }
    pub fn get_error_info(&self) -> (u32, Option<AudioError>) { (self.state.get_error_count(), self.state.get_last_error()) }
    pub fn active_stream_count(&self) -> usize { self.stream_manager.active_stream_count() }
    pub fn set_error_callback<F>(&self, callback: F) where F: Fn(&AudioError) + Send + Sync + 'static { self.state.set_error_callback(callback); }
    pub fn has_fatal_error(&self) -> bool { self.recording_saver.last_failure().is_some() || self.state.has_fatal_error() }
    pub fn set_meeting_name(&mut self, name: Option<String>) { self.recording_saver.set_meeting_name(name); }
    pub fn add_transcript_segment(&self, segment: super::recording_saver::TranscriptSegment) { self.recording_saver.add_transcript_segment(segment); }
    pub fn add_transcript_chunk(&self, text: String) { self.recording_saver.add_transcript_chunk(text); }
    pub fn get_transcript_segments(&self) -> Vec<super::recording_saver::TranscriptSegment> { self.recording_saver.get_transcript_segments() }
    pub fn get_meeting_name(&self) -> Option<String> { self.recording_saver.get_meeting_name() }
    pub async fn cleanup_without_save(&mut self) {
        // Also clean up after a fatal writer error has already marked state as stopped.
        if let Some(monitor) = self.device_monitor.as_mut() { monitor.stop_monitoring().await; }
        self.state.stop_recording();
        if let Err(failure) = self.stream_manager.stop_streams() { error!("Stream cleanup failed: {}", failure); }
        if let Err(failure) = self.pipeline_manager.stop().await { error!("Pipeline cleanup failed: {}", failure); }
        self.state.cleanup();
    }
    pub fn get_meeting_folder(&self) -> Option<std::path::PathBuf> { self.recording_saver.get_meeting_folder().cloned() }
    pub fn poll_device_events(&mut self) -> Option<DeviceEvent> { self.device_event_receiver.as_mut().and_then(|receiver| receiver.try_recv().ok()) }

    pub async fn attempt_device_reconnect(&mut self, device_name: &str, device_type: DeviceMonitorType) -> Result<bool> {
        let devices = list_audio_devices().await?;
        let Some(device) = devices.iter().find(|d| d.name == device_name).cloned() else { return Ok(false); };
        let device = Arc::new(device);
        match device_type {
            DeviceMonitorType::Microphone => {
                let system_device = self.state.get_system_device();
                self.stream_manager.stop_streams()?;
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                self.stream_manager.start_streams(Some(device.clone()), system_device, None).await?;
                self.state.set_microphone_device(device);
            }
            DeviceMonitorType::SystemAudio => {
                let microphone_device = self.state.get_microphone_device();
                self.stream_manager.stop_streams()?;
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                self.stream_manager.start_streams(microphone_device, Some(device.clone()), None).await?;
                self.state.set_system_device(device);
            }
        }
        Ok(true)
    }
    pub async fn handle_device_disconnect(&mut self, device_name: String, device_type: DeviceMonitorType) {
        warn!("Device disconnected: {} ({:?})", device_name, device_type);
        let device = match device_type {
            DeviceMonitorType::Microphone => self.state.get_microphone_device(),
            DeviceMonitorType::SystemAudio => self.state.get_system_device(),
        };
        if let Some(device) = device {
            let kind = match device_type { DeviceMonitorType::Microphone => RecordingDeviceType::Microphone, DeviceMonitorType::SystemAudio => RecordingDeviceType::System };
            self.state.start_reconnecting(device, kind);
        }
    }
    pub async fn handle_device_reconnect(&mut self, device_name: String, device_type: DeviceMonitorType) -> Result<()> {
        if self.attempt_device_reconnect(&device_name, device_type).await? { self.state.stop_reconnecting(); Ok(()) }
        else { Err(anyhow::anyhow!("Device not available")) }
    }
    pub fn is_reconnecting(&self) -> bool { self.state.is_reconnecting() }
    pub fn get_state(&self) -> &Arc<RecordingState> { &self.state }
}
impl Default for RecordingManager { fn default() -> Self { Self::new() } }
impl Drop for RecordingManager { fn drop(&mut self) { self.state.cleanup(); } }
