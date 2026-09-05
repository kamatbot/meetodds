from pathlib import Path

def edit(path, old, new, count=1):
    p=Path(path); text=p.read_text()
    if text.count(old) != count:
        raise RuntimeError(f'{path}: expected {count} anchors, found {text.count(old)}: {old[:90]}')
    p.write_text(text.replace(old,new))

def region(path, first, last, replacement):
    p=Path(path); text=p.read_text()
    if text.count(first)!=1 or last not in text: raise RuntimeError(f'{path}: region is ambiguous')
    start=text.index(first); end=text.index(last,start)
    p.write_text(text[:start]+replacement+text[end:])

edit('frontend/src-tauri/src/summary/commands.rs', 'mod execution_gate;', 'mod execution_gate;\n#[path = "execution_config.rs"]\npub(super) mod execution_config;')
edit('frontend/src-tauri/src/summary/commands.rs', '    _chunk_size: Option<i32>,', '    approved_target: Option<execution_config::DestinationApproval>,\n    _chunk_size: Option<i32>,')
edit('frontend/src-tauri/src/summary/commands.rs', '    // Acquire before any database reset.', '    let execution = execution_config::resolve(state.db_manager.pool(), &model, &model_name, approved_target.as_ref()).await?;\n    if execution.local && crate::audio::recording_commands::is_recording().await {\n        return Err("Finish recording before starting a local summary".to_string());\n    }\n    // Acquire before any database reset.')
edit('frontend/src-tauri/src/summary/commands.rs', '            summary_language,\n        )', '            summary_language,\n            execution,\n        )')
edit('frontend/src-tauri/src/summary/service.rs', '        summary_language: Option<String>,\n    ) {', '        summary_language: Option<String>,\n        execution: crate::summary::commands::execution_config::ResolvedSummaryConfig,\n    ) {')
region('frontend/src-tauri/src/summary/service.rs', '        // Parse provider\n', '        // Dynamically fetch context size', '        // Frozen before dispatch: never re-read mutable destinations inside the job.\n        let provider = execution.provider;\n        let final_api_key = execution.api_key;\n        let ollama_endpoint = execution.ollama_endpoint;\n        let custom_openai_endpoint = execution.custom_openai_endpoint;\n        let custom_openai_max_tokens = execution.max_tokens;\n        let custom_openai_temperature = execution.temperature;\n        let custom_openai_top_p = execution.top_p;\n\n')
edit('frontend/src/hooks/meeting-details/useSummaryGeneration.ts', 'text: approved.text, model: target.provider, modelName: target.model, meetingId: id,', 'text: approved.text, model: target.provider, modelName: target.model, meetingId: id,\n        approvedTarget: { provider: target.provider, model: target.model, destination: target.destination },')
p=Path('frontend/src-tauri/src/summary/llm_client.rs'); s=p.read_text(); old='.timeout(REQUEST_TIMEOUT_DURATION)'
if old not in s: raise RuntimeError('LLM client timeout anchor missing')
p.write_text(s.replace(old, '.redirect(reqwest::redirect::Policy::none())\n        '+old))

edit('frontend/src-tauri/src/audio/incremental_saver.rs', '    pub fn get_meeting_folder(&self) -> &PathBuf { &self.meeting_folder }', '    pub fn get_meeting_folder(&self) -> &PathBuf { &self.meeting_folder }\n    pub fn finish_commit(&mut self) -> Result<()> {\n        if self.finalized.is_none() { return Err(anyhow!("Audio has not been finalized")); }\n        self.journal.take();\n        cleanup_committed_checkpoints(&self.meeting_folder)\n    }')
edit('frontend/src-tauri/src/audio/recording_saver.rs', '            metadata.duration_seconds = duration.filter(|d| d.is_finite() && *d >= 0.0);', '            metadata.duration_seconds = duration.filter(|d| d.is_finite() && *d >= 0.0);\n            metadata.audio_file = audio.as_ref().and_then(|path| Path::new(path).file_name()).map(|name| name.to_string_lossy().to_string()).unwrap_or_default();')
edit('frontend/src-tauri/src/audio/recording_saver.rs', '        let receipt = serde_json::json!({', '        if let Some(saver) = self.incremental_saver.clone() {\n            let cleanup = tokio::task::spawn_blocking(move || saver.blocking_lock().finish_commit()).await;\n            if !matches!(cleanup, Ok(Ok(()))) { warn!("Recording committed; recovery checkpoints could not be removed"); }\n        }\n        let receipt = serde_json::json!({')
edit('frontend/src/app/page.tsx', 'await indexedDBService.deleteOldMeetings(7);', '// Interrupted meetings remain until explicit recovery or deletion.')

edit('frontend/src-tauri/src/audio/mod.rs', 'pub mod simple_level_monitor;', 'pub mod simple_level_monitor;\npub mod capture_preflight;')
edit('frontend/src-tauri/src/lib.rs', '            start_audio_level_monitoring,', '            audio::capture_preflight::run_capture_preflight,\n            start_audio_level_monitoring,')
region('frontend/src-tauri/src/audio/recording_preferences.rs', '    let store = match app.store("recording_preferences.json") {', '    // Try to get the preferences from store', '    let store = app.store("recording_preferences.json")\n        .map_err(|_| anyhow::anyhow!("Recording preferences unavailable; recording was not started"))?;\n\n')
edit('frontend/src-tauri/src/audio/recording_preferences.rs', '                warn!("Failed to deserialize preferences: {}, using defaults", e);\n                RecordingPreferences::default()', '                return Err(anyhow::anyhow!("Recording preferences are invalid; audio retention was not changed: {}", e));')
edit('frontend/src-tauri/src/audio/recording_saver.rs', '    capture_session_id: String,', '    capture_session_id: String,\n    recording_folder: Option<PathBuf>,')
edit('frontend/src-tauri/src/audio/recording_saver.rs', '            finalized_audio: None, saved_result: None,', '            finalized_audio: None, saved_result: None, recording_folder: None,')
edit('frontend/src-tauri/src/audio/recording_saver.rs', '    pub fn set_meeting_name(&mut self, name: Option<String>) { self.meeting_name = name; }', '    pub fn set_meeting_name(&mut self, name: Option<String>) { self.meeting_name = name; }\n    pub fn set_recording_folder(&mut self, folder: PathBuf) { self.recording_folder = Some(folder); }')
edit('frontend/src-tauri/src/audio/recording_saver.rs', 'let base = super::recording_preferences::get_default_recordings_folder();', 'let base = self.recording_folder.clone().unwrap_or_else(super::recording_preferences::get_default_recordings_folder);')
edit('frontend/src-tauri/src/audio/recording_manager.rs', '    pub fn set_meeting_name(&mut self, name: Option<String>) { self.recording_saver.set_meeting_name(name); }', '    pub fn set_meeting_name(&mut self, name: Option<String>) { self.recording_saver.set_meeting_name(name); }\n    pub fn set_recording_folder(&mut self, folder: std::path::PathBuf) { self.recording_saver.set_recording_folder(folder); }')
edit('frontend/src-tauri/src/audio/recording_commands.rs', '    let mut manager = RecordingManager::new();', '    let mut manager = RecordingManager::new();\n    let capture_preferences = super::recording_preferences::load_recording_preferences(&app).await\n        .map_err(|_| "Recording preferences could not be read. Audio retention was not changed.".to_string())?;\n    manager.set_recording_folder(capture_preferences.save_folder.clone());', count=2)
region('frontend/src-tauri/src/audio/recording_commands.rs', '    let auto_save = match super::recording_preferences::load_recording_preferences(&app).await {', '    // Always ensure a meeting name is set', '    let auto_save = capture_preferences.auto_save;\n\n')
region('frontend/src-tauri/src/audio/recording_commands.rs', '    let (auto_save, preferred_mic_name, preferred_system_name) =', '    // ============================================================================\n    // MICROPHONE DEVICE RESOLUTION', '    let (auto_save, preferred_mic_name, preferred_system_name) = (\n        capture_preferences.auto_save, capture_preferences.preferred_mic_device, capture_preferences.preferred_system_device,\n    );\n\n')
edit('frontend/src-tauri/src/audio/recording_commands.rs', '    let engine_lifecycle_guard = super::common::acquire_engine_lifecycle_lock().await;', '    let _ = super::simple_level_monitor::stop_monitoring().await;\n    let engine_lifecycle_guard = super::common::acquire_engine_lifecycle_lock().await;', count=2)
edit('frontend/src/hooks/useRecordingStart.ts', "import { useState, useEffect, useCallback } from 'react';", "import { useState, useEffect, useCallback, useRef } from 'react';")
edit('frontend/src/hooks/useRecordingStart.ts', '  const [isAutoStarting, setIsAutoStarting] = useState(false);', '  const [isAutoStarting, setIsAutoStarting] = useState(false);\n  const activeStart = useRef<AbortController | null>(null);\n  useEffect(() => () => activeStart.current?.abort(), []);')
edit('frontend/src/hooks/useRecordingStart.ts', '        const now = new Date();', "        const abort = new AbortController();\n        activeStart.current = abort;\n        const { reviewCaptureStart } = await import('@/components/Meeting/CapturePreflightReview');\n        const capture = await reviewCaptureStart(selectedDevices?.micDevice || null, selectedDevices?.systemDevice || null, abort.signal);\n        if (!capture || abort.signal.aborted) return;\n        const now = new Date();")
edit('frontend/src/hooks/useRecordingStart.ts', '          selectedDevices?.micDevice || null,\n          selectedDevices?.systemDevice || null,', '          capture.microphone,\n          capture.systemAudio,')
edit('frontend/src/hooks/useRecordingStart.ts', '        setIsAutoStarting(false);', '        activeStart.current = null;\n        setIsAutoStarting(false);')

p='frontend/src/hooks/useTranscriptRecovery.ts'
region(p, '      // Filter out meetings older than 7 days', '      // Verify audio checkpoint availability', '      const recentMeetings = meetings.filter(m => m.lastUpdated < Date.now() - 2000);\n\n')
edit(p, 'folderPath: hasAudio ? meeting.folderPath : undefined', 'folderPath: meeting.folderPath')
edit(p, 'return { ...meeting, folderPath: undefined };', 'return meeting;')
region(p, '      if (!folderPath) {', '      // 4. Attempt audio recovery', '      // Never borrow a folder from an unrelated live recording.\n\n')
edit(p, '      // 7. Mark as saved in IndexedDB', '      if (audioRecoveryStatus?.status === "failed") {\n        toast.warning("Transcript recovered; audio still needs attention", { description: "Original checkpoints were retained. Retry audio recovery before deleting this entry." });\n        return { success: true, audioRecoveryStatus, meetingId: savedMeetingId };\n      }\n\n      // 7. Mark as saved in IndexedDB')
region(p, '      // 8. Clean up checkpoint files', '      // 9. Remove from recoverable list', '      // Recovery retains source journals until explicitly committed.\n\n')
print('Applied capture, privacy and summary integration patches with exact source anchors.')
