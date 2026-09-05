from pathlib import Path

def edit(path, old, new, count=1):
    p=Path(path); text=p.read_text()
    if text.count(old)!=count: raise RuntimeError(f'{path}: expected {count} anchors, got {text.count(old)}: {old[:100]}')
    p.write_text(text.replace(old,new))
def region(path, first, last, replacement):
    p=Path(path); text=p.read_text()
    if text.count(first)!=1: raise RuntimeError(f'{path}: ambiguous start')
    start=text.index(first); end=text.index(last,start)
    p.write_text(text[:start]+replacement+text[end:])

p='frontend/src-tauri/src/audio/recording_saver.rs'
edit(p, 'pub fn start_accumulation(&mut self, auto_save: bool) -> mpsc::UnboundedSender<AudioChunk>', 'pub fn start_accumulation(&mut self, auto_save: bool) -> mpsc::Sender<AudioChunk>')
edit(p, 'let (sender, receiver) = mpsc::unbounded_channel();', 'let (sender, receiver) = mpsc::channel(64);')
edit(p, 'save_worker::drain_until_closed(receiver', 'save_worker::drain_bounded_until_closed(receiver')
p='frontend/src-tauri/src/audio/pipeline.rs'
edit(p, 'recording_sender_for_mixed: Option<mpsc::UnboundedSender<AudioChunk>>', 'recording_sender_for_mixed: Option<mpsc::Sender<AudioChunk>>')
# Only the mixed-recorder argument changes; raw AudioCapture compatibility channels are untouched.
start=Path(p).read_text().index('impl AudioPipelineManager {')
s=Path(p).read_text(); tail=s[start:]
old='recording_sender: Option<mpsc::UnboundedSender<AudioChunk>>'
if tail.count(old)!=1: raise RuntimeError('mixed sender argument not unique')
Path(p).write_text(s[:start]+tail.replace(old,'recording_sender: Option<mpsc::Sender<AudioChunk>>'))
edit(p, '                                let _ = sender.send(recording_chunk);', '                                if sender.try_send(recording_chunk).is_err() {\n                                    self.state.stop_recording();\n                                    self.state.report_error(AudioError::BufferOverflow);\n                                    return Err(anyhow::anyhow!("Recording storage cannot keep up. Capture stopped; acknowledged audio remains recoverable."));\n                                }')
# Recording writes have priority over VAD/ASR work for the same source audio.
region(p, '                    // STEP 1: Transcribe each source independently', '                    // STEP 2: Add raw audio', '')
edit(p, '.add_samples(chunk.device_type.clone(), chunk.data);', '.add_samples(chunk.device_type.clone(), chunk.data.clone());')
edit(p, '                }\n                Ok(None) => {', '                    if let Err(error) = self.process_source_audio(chunk.device_type, &chunk.data) {\n                        warn!("Transcription processing failed; recording audio was retained: {}", error);\n                    }\n                }\n                Ok(None) => {')
# Drain the final fraction of a mixing window instead of discarding it during stop.
edit(p, '    fn can_mix(&self) -> bool {', '    fn extract_tail(&mut self) -> Option<(Vec<f32>, Vec<f32>)> {\n        let count = self.mic_buffer.len().max(self.system_buffer.len());\n        if count == 0 { return None; }\n        let mut microphone: Vec<f32> = self.mic_buffer.drain(..).collect();\n        let mut system: Vec<f32> = self.system_buffer.drain(..).collect();\n        microphone.resize(count, 0.0); system.resize(count, 0.0);\n        Some((microphone, system))\n    }\n\n    fn can_mix(&self) -> bool {')
edit(p, '    fn flush_remaining_audio(&mut self) -> Result<()> {', '    fn flush_remaining_audio(&mut self) -> Result<()> {\n        if let Some((microphone, system)) = self.ring_buffer.extract_tail() {\n            let mixed = self.mixer.mix_window(&microphone, &system);\n            if let Some(sender) = self.recording_sender_for_mixed.as_ref() {\n                sender.try_send(AudioChunk { data: mixed, sample_rate: self.sample_rate,\n                    timestamp: self.state.get_active_recording_duration().unwrap_or(0.0),\n                    chunk_id: self.chunk_id_counter, device_type: DeviceType::Microphone })\n                    .map_err(|_| anyhow::anyhow!("Final recording window could not be queued; recovery is required"))?;\n            }\n        }')

p='frontend/src-tauri/src/summary/mod.rs'
Path(p).write_text(Path(p).read_text()+'\npub(crate) mod inference_priority;\n')
p='frontend/src-tauri/src/summary/commands.rs'
edit(p, '    if execution.local && crate::audio::recording_commands::is_recording().await {', '    let scheduling_guard = if execution.local { Some(crate::audio::common::acquire_engine_lifecycle_lock().await) } else { None };\n    if execution.local && crate::audio::recording_commands::is_recording().await {')
edit(p, '    let lease = execution_gate::SummaryLease::acquire(&m_id)?;', '    let lease = execution_gate::SummaryLease::acquire(&m_id)?;\n    let cancellation_token = tokio_util::sync::CancellationToken::new();\n    let local_lease = if execution.local { Some(crate::summary::inference_priority::register(&m_id, cancellation_token.clone())?) } else { None };\n    drop(scheduling_guard);')
edit(p, '            execution,\n        )', '            execution,\n            cancellation_token,\n        )')
edit(p, '        drop(lease);', '        drop(local_lease);\n        drop(lease);')
p='frontend/src-tauri/src/summary/service.rs'
edit(p, 'fn register_cancellation_token(meeting_id: &str) -> CancellationToken {\n        let token = CancellationToken::new();', 'fn register_cancellation_token(meeting_id: &str, token: CancellationToken) -> CancellationToken {')
edit(p, '        execution: crate::summary::commands::execution_config::ResolvedSummaryConfig,', '        execution: crate::summary::commands::execution_config::ResolvedSummaryConfig,\n        supplied_cancellation_token: CancellationToken,')
edit(p, 'Self::register_cancellation_token(&meeting_id)', 'Self::register_cancellation_token(&meeting_id, supplied_cancellation_token)')
edit(p, '        // Frozen before dispatch:', '        if cancellation_token.is_cancelled() {\n            let _ = SummaryProcessesRepository::update_process_cancelled(&pool, &meeting_id).await;\n            Self::cleanup_cancellation_token(&meeting_id);\n            return;\n        }\n\n        // Frozen before dispatch:')
p='frontend/src-tauri/src/audio/recording_commands.rs'
edit(p, '    let engine_lifecycle_guard = super::common::acquire_engine_lifecycle_lock().await;', '    let engine_lifecycle_guard = super::common::acquire_engine_lifecycle_lock().await;\n    if crate::summary::inference_priority::cancel_for_capture() > 0 {\n        let _ = crate::summary::summary_engine::client::shutdown_sidecar_gracefully().await;\n        let _ = app.emit("local-summary-yielded", serde_json::json!({"message": "Local summary work was cancelled to prioritize recording. It can be restarted after this meeting."}));\n    }', count=2)

p='frontend/src-tauri/src/openai_codex.rs'
region(p, 'fn write_auth(path: &Path, auth: &CodexAuthState) -> Result<(), String> {', '\nfn remove_auth(', '''fn write_auth(path: &Path, auth: &CodexAuthState) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| "Credential directory is unavailable".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "Credential directory could not be created".to_string())?;
    // NamedTempFile is private from creation on Unix; never write a public file then chmod it.
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "Credential file could not be created".to_string())?;
    serde_json::to_writer(file.as_file_mut(), auth).map_err(|_| "Credentials could not be serialized".to_string())?;
    file.flush().and_then(|_| file.as_file().sync_all()).map_err(|_| "Credentials could not be flushed".to_string())?;
    file.persist(path).map_err(|_| "Credentials could not be committed".to_string())?;
    #[cfg(unix)]
    std::fs::File::open(parent).and_then(|directory| directory.sync_all()).map_err(|_| "Credential directory could not be flushed".to_string())?;
    Ok(())
}
''')
edit(p, '    let bytes =\n        std::fs::read(path)', '    if std::fs::symlink_metadata(path).map_err(|_| "Credential metadata unavailable".to_string())?.file_type().is_symlink() {\n        return Err("Refusing a symbolic-link credential file".to_string());\n    }\n    let bytes =\n        std::fs::read(path)')
# Do not guess account models or advertise unavailable model names when discovery fails.
region(p, 'const CODEX_FALLBACK_MODELS:', '\nstatic AUTH_LOCK', '')
region(p, '    if models.is_empty() {\n        models = CODEX_FALLBACK_MODELS', '\n\n    Ok(models.into_iter()', '    if models.is_empty() {\n        return Err("No summary-capable models were returned for this ChatGPT account. Reconnect or refresh the model list; no fallback model was selected.".to_string());\n    }')
p='frontend/src/components/ModelSettingsModal.tsx'
region(p, 'const CODEX_FALLBACK_MODELS = [', '\n\nconst CLAUDE_FALLBACK_MODELS', 'const CODEX_FALLBACK_MODELS: string[] = []; // Account discovery is authoritative.')

# Include the new cancellation registry tests in the isolated production-core harness.
p='tools/recovery/verify-core.py'
edit(p, 'once_cell = "1"', 'once_cell = "1"\ntokio-util = "0.7"')
edit(p, "    (crate/'src/execution_gate.rs').write_text((summary/'execution_gate.rs').read_text())", "    (crate/'src/execution_gate.rs').write_text((summary/'execution_gate.rs').read_text())\n    (crate/'src/inference_priority.rs').write_text((summary/'inference_priority.rs').read_text())\n    modules.append('mod inference_priority;')")
p='tools/recovery/check-types.cjs'
edit(p, 'let introduced = 0;', "for (const [key,count] of before) console.log(`Baseline (${count}): ${key}`);\nlet introduced = 0;")
print('Integrated bounded capture-first saving, final-window preservation and private atomic credentials.')
