//! Spanish practice: profiles/sessions persistence, mic-only live listening (VAD + STT),
//! macOS `say` playback, and an LLM tutor turn. One file, all Tauri commands for the feature.
use crate::audio::devices::{default_input_device, parse_audio_device};
use crate::audio::recording_state::{AudioChunk, DeviceType, RecordingState};
use crate::audio::stream::AudioStream;
use crate::audio::transcription::{
    get_or_init_transcription_engine, validate_transcription_model_ready, TranscriptionEngine,
};
use crate::audio::vad::ContinuousVadProcessor;
use crate::state::AppState;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

// ============================================================================
// Types (contract shared with the frontend agent — do not rename/reshape)
// ============================================================================

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpanishProfile {
    pub id: String,
    pub name: String,
    pub level: String,
    pub variety: String,
    pub topics: Vec<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub role: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub kind: String,
    pub you_said: String,
    pub try_this: String,
    pub why: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpanishSession {
    pub id: String,
    pub profile_id: String,
    pub situation: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub turns: Vec<Turn>,
    pub feedback: Vec<Feedback>,
    pub level_signal: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TutorRequest {
    pub profile: SpanishProfile,
    pub situation: Option<String>,
    pub history: Vec<Turn>,
    pub learner_text: Option<String>,
    pub mode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TutorResponse {
    pub reply: String,
    pub feedback: Option<Feedback>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub whisper_model: Option<String>,
    pub whisper_ready: bool,
    pub llm_provider: Option<String>,
    pub llm_model: Option<String>,
    pub llm_ready: bool,
    pub message: Option<String>,
}

// ============================================================================
// Persistence (sqlx + AppState, mirrors api/manual_notes.rs)
// ============================================================================

#[derive(sqlx::FromRow)]
struct ProfileRow {
    id: String,
    name: String,
    level: String,
    variety: String,
    topics: String,
    created_at: String,
    updated_at: String,
}

impl ProfileRow {
    fn into_profile(self) -> SpanishProfile {
        SpanishProfile {
            id: self.id,
            name: self.name,
            level: self.level,
            variety: self.variety,
            topics: serde_json::from_str(&self.topics).unwrap_or_default(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: String,
    profile_id: String,
    situation: Option<String>,
    started_at: String,
    ended_at: Option<String>,
    turns: String,
    feedback: String,
    level_signal: Option<String>,
}

impl SessionRow {
    fn into_session(self) -> SpanishSession {
        SpanishSession {
            id: self.id,
            profile_id: self.profile_id,
            situation: self.situation,
            started_at: self.started_at,
            ended_at: self.ended_at,
            turns: serde_json::from_str(&self.turns).unwrap_or_default(),
            feedback: serde_json::from_str(&self.feedback).unwrap_or_default(),
            level_signal: self.level_signal,
        }
    }
}

#[tauri::command]
pub async fn spanish_list_profiles(state: State<'_, AppState>) -> Result<Vec<SpanishProfile>, String> {
    let rows = sqlx::query_as::<_, ProfileRow>(
        "SELECT id, name, level, variety, topics, created_at, updated_at FROM spanish_profiles ORDER BY created_at ASC",
    )
    .fetch_all(state.db_manager.pool())
    .await
    .map_err(|e| format!("Failed to list Spanish profiles: {e}"))?;
    Ok(rows.into_iter().map(ProfileRow::into_profile).collect())
}

#[tauri::command]
pub async fn spanish_save_profile(
    state: State<'_, AppState>,
    mut profile: SpanishProfile,
) -> Result<SpanishProfile, String> {
    if profile.id.trim().is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    let now = chrono::Utc::now().to_rfc3339();
    // created_at is only honored on first insert: the ON CONFLICT clause below never
    // touches the column, so an update keeps whatever value is already stored.
    let created_at = if profile.created_at.trim().is_empty() {
        now.clone()
    } else {
        profile.created_at.clone()
    };
    let topics_json = serde_json::to_string(&profile.topics).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "INSERT INTO spanish_profiles (id, name, level, variety, topics, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, level = excluded.level, variety = excluded.variety, \
             topics = excluded.topics, updated_at = excluded.updated_at",
    )
    .bind(&profile.id)
    .bind(&profile.name)
    .bind(&profile.level)
    .bind(&profile.variety)
    .bind(&topics_json)
    .bind(&created_at)
    .bind(&now)
    .execute(state.db_manager.pool())
    .await
    .map_err(|e| format!("Failed to save Spanish profile: {e}"))?;

    let row = sqlx::query_as::<_, ProfileRow>(
        "SELECT id, name, level, variety, topics, created_at, updated_at FROM spanish_profiles WHERE id = ?",
    )
    .bind(&profile.id)
    .fetch_one(state.db_manager.pool())
    .await
    .map_err(|e| format!("Failed to reload saved Spanish profile: {e}"))?;
    Ok(row.into_profile())
}

#[tauri::command]
pub async fn spanish_delete_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    sqlx::query("DELETE FROM spanish_profiles WHERE id = ?")
        .bind(&id)
        .execute(state.db_manager.pool())
        .await
        .map_err(|e| format!("Failed to delete Spanish profile: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn spanish_list_sessions(
    state: State<'_, AppState>,
    profile_id: String,
    limit: u32,
) -> Result<Vec<SpanishSession>, String> {
    let limit: i64 = if limit == 0 { i64::MAX } else { limit.into() };
    let rows = sqlx::query_as::<_, SessionRow>(
        "SELECT id, profile_id, situation, started_at, ended_at, turns, feedback, level_signal \
         FROM spanish_sessions WHERE profile_id = ? ORDER BY started_at DESC LIMIT ?",
    )
    .bind(&profile_id)
    .bind(limit)
    .fetch_all(state.db_manager.pool())
    .await
    .map_err(|e| format!("Failed to list Spanish sessions: {e}"))?;
    Ok(rows.into_iter().map(SessionRow::into_session).collect())
}

#[tauri::command]
pub async fn spanish_save_session(state: State<'_, AppState>, session: SpanishSession) -> Result<(), String> {
    if session.id.trim().is_empty() {
        return Err("session id cannot be empty".to_string());
    }
    let turns_json = serde_json::to_string(&session.turns).unwrap_or_else(|_| "[]".to_string());
    let feedback_json = serde_json::to_string(&session.feedback).unwrap_or_else(|_| "[]".to_string());
    sqlx::query(
        "INSERT INTO spanish_sessions (id, profile_id, situation, started_at, ended_at, turns, feedback, level_signal) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, situation = excluded.situation, \
             started_at = excluded.started_at, ended_at = excluded.ended_at, turns = excluded.turns, \
             feedback = excluded.feedback, level_signal = excluded.level_signal",
    )
    .bind(&session.id)
    .bind(&session.profile_id)
    .bind(&session.situation)
    .bind(&session.started_at)
    .bind(&session.ended_at)
    .bind(&turns_json)
    .bind(&feedback_json)
    .bind(&session.level_signal)
    .execute(state.db_manager.pool())
    .await
    .map_err(|e| format!("Failed to save Spanish session: {e}"))?;
    Ok(())
}

// ============================================================================
// Readiness
// ============================================================================

/// Not multilingual when it's an English-only Whisper model (".en") or a Parakeet v2
/// model (Parakeet v2 is English-only; v3 is multilingual).
fn is_multilingual_model(model: &str) -> bool {
    let lower = model.to_lowercase();
    if lower.contains(".en") {
        return false;
    }
    if lower.contains("v2") && !lower.contains("v3") {
        return false;
    }
    true
}

#[tauri::command]
pub async fn spanish_check_readiness<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Readiness, String> {
    let config = crate::api::api::api_get_transcript_config(app.clone(), app.clone().state(), None)
        .await
        .ok()
        .flatten();
    let (provider, model) = match config {
        Some(cfg) if !cfg.model.trim().is_empty() => (cfg.provider, cfg.model),
        _ => ("localWhisper".to_string(), crate::config::DEFAULT_WHISPER_MODEL.to_string()),
    };
    let prefix = if provider == "parakeet" { "parakeet" } else { "whisper" };
    let whisper_model = Some(format!("{prefix}:{model}"));
    let whisper_ready = is_multilingual_model(&model);

    let (llm_provider, llm_model, llm_ready, llm_message) =
        match crate::live_translation::resolve_provider_config(state.db_manager.pool()).await {
            Ok(cfg) => {
                // The built-in provider is "configured" as soon as a model is selected, even
                // before its GGUF is downloaded, so check the file too.
                let missing_builtin = cfg.provider == crate::summary::llm_client::LLMProvider::BuiltInAI
                    && app
                        .path()
                        .app_data_dir()
                        .ok()
                        .and_then(|dir| {
                            crate::summary::summary_engine::models::get_model_path(&dir, &cfg.model_name).ok()
                        })
                        .map_or(true, |path| !path.exists());
                if missing_builtin {
                    (
                        Some(cfg.provider_name),
                        Some(cfg.model_name.clone()),
                        false,
                        Some(format!(
                            "The built-in summary model ({}) is not downloaded yet. Download it in Settings → Summary model.",
                            cfg.model_name
                        )),
                    )
                } else {
                    (Some(cfg.provider_name), Some(cfg.model_name), true, None)
                }
            }
            Err(e) => (None, None, false, Some(e)),
        };

    let message = if !whisper_ready {
        let base = format!(
            "The configured transcription model ({model}) is English-only. Pick a multilingual Whisper or Parakeet v3 model in Settings."
        );
        Some(match llm_message {
            Some(m) => format!("{base} {m}"),
            None => base,
        })
    } else {
        llm_message
    };

    Ok(Readiness {
        whisper_model,
        whisper_ready,
        llm_provider,
        llm_model,
        llm_ready,
        message,
    })
}

// ============================================================================
// Live listening: mic-only capture + VAD + STT, mirrors capture_preflight's probe_source
// ============================================================================

static LISTEN_TOKEN: Lazy<Mutex<Option<CancellationToken>>> = Lazy::new(|| Mutex::new(None));
/// Set while `spanish_speak` is playing TTS so the listening loop drops the app's own voice
/// instead of transcribing it back.
static SPEAKING: AtomicBool = AtomicBool::new(false);

/// Skip transcripts that are pure punctuation/brackets, e.g. "[Música]" noise tokens.
fn is_noise_transcript(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }
    if (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || (trimmed.starts_with('(') && trimmed.ends_with(')'))
    {
        return true;
    }
    !trimmed.chars().any(|c| c.is_alphanumeric())
}

async fn transcribe_segment(engine: &TranscriptionEngine, samples: Vec<f32>) -> Result<String, String> {
    match engine {
        TranscriptionEngine::Whisper(e) => e
            .transcribe_audio(samples, Some("es".to_string()))
            .await
            .map_err(|e| e.to_string()),
        TranscriptionEngine::Parakeet(e) => e.transcribe_audio(samples).await.map_err(|e| e.to_string()),
        TranscriptionEngine::Provider(p) => p
            .transcribe(samples, Some("es".to_string()))
            .await
            .map(|r| r.text)
            .map_err(|e| e.to_string()),
    }
}

/// Guards `LISTEN_TOKEN`: clears it on Drop unless disarmed, so any early `?` return during
/// setup releases the reservation (mirrors `ProbeGuard` in capture_preflight.rs).
struct ListenGuard(bool);
impl Drop for ListenGuard {
    fn drop(&mut self) {
        if self.0 {
            if let Ok(mut guard) = LISTEN_TOKEN.lock() {
                guard.take();
            }
        }
    }
}

#[tauri::command]
pub async fn spanish_start_listening<R: Runtime>(
    app: AppHandle<R>,
    device_name: Option<String>,
) -> Result<(), String> {
    if crate::audio::recording_commands::is_recording().await {
        return Err("Stop the meeting recording first.".to_string());
    }

    let token = CancellationToken::new();
    {
        let mut guard = LISTEN_TOKEN.lock().unwrap();
        if guard.is_some() {
            return Err("Spanish practice listening is already running.".to_string());
        }
        *guard = Some(token.clone());
    }
    let mut listen_guard = ListenGuard(true);

    validate_transcription_model_ready(&app).await?;
    let engine = get_or_init_transcription_engine(&app).await?;
    if let Some(model) = engine.get_current_model().await {
        if !is_multilingual_model(&model) {
            return Err(
                "The selected transcription model is English-only. Pick a multilingual Whisper or Parakeet v3 model in Settings."
                    .to_string(),
            );
        }
    }

    let device = match device_name.filter(|name| !name.trim().is_empty()) {
        Some(name) => parse_audio_device(&name).map_err(|e| e.to_string())?,
        None => default_input_device().map_err(|e| e.to_string())?,
    };

    let state = RecordingState::new();
    let (sender, mut receiver) = mpsc::unbounded_channel::<AudioChunk>();
    state.set_audio_sender(sender);
    state.start_recording().map_err(|e| e.to_string())?;
    let stream = AudioStream::create(Arc::new(device), state.clone(), DeviceType::Microphone, None)
        .await
        .map_err(|e| {
            state.stop_recording();
            state.cleanup();
            e.to_string()
        })?;

    // Setup succeeded: the spawned task below now owns clearing LISTEN_TOKEN when it exits.
    listen_guard.0 = false;

    let _ = app.emit("spanish-listening", serde_json::json!({ "active": true }));

    let app_task = app.clone();
    let cancel = token;
    tauri::async_runtime::spawn(async move {
        let _stream = stream; // keep the mic stream alive for the task's lifetime
        let mut vad: Option<ContinuousVadProcessor> = None;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                chunk = receiver.recv() => {
                    let Some(chunk) = chunk else { break; };
                    if SPEAKING.load(Ordering::SeqCst) {
                        // ponytail: hard-drop our own TTS audio rather than echo-cancel it.
                        continue;
                    }
                    if vad.is_none() {
                        match ContinuousVadProcessor::new(chunk.sample_rate, 700) {
                            Ok(processor) => vad = Some(processor),
                            Err(_) => continue,
                        }
                    }
                    let Some(processor) = vad.as_mut() else { continue };
                    let segments = match processor.process_audio(&chunk.data) {
                        Ok(segments) => segments,
                        Err(_) => continue,
                    };
                    // ponytail: transcribing inline blocks chunk intake briefly; VAD segments
                    // are short (<=9s) so this is fine. Move to a worker queue if that changes.
                    for seg in segments {
                        if seg.samples.len() < 8000 {
                            continue;
                        }
                        let text = match transcribe_segment(&engine, seg.samples).await {
                            Ok(text) => text,
                            Err(_) => continue,
                        };
                        let text = text.trim().to_string();
                        if is_noise_transcript(&text) {
                            continue;
                        }
                        let _ = app_task.emit(
                            "spanish-partial",
                            serde_json::json!({ "text": text, "tSec": seg.end_timestamp_ms / 1000.0 }),
                        );
                    }
                }
            }
        }
        state.stop_recording();
        state.cleanup();
        if let Ok(mut guard) = LISTEN_TOKEN.lock() {
            guard.take();
        }
        let _ = app_task.emit("spanish-listening", serde_json::json!({ "active": false }));
    });

    Ok(())
}

#[tauri::command]
pub async fn spanish_stop_listening() -> Result<(), String> {
    if let Ok(guard) = LISTEN_TOKEN.lock() {
        if let Some(token) = guard.as_ref() {
            token.cancel();
        }
    }
    Ok(())
}

// ============================================================================
// macOS `say` playback
// ============================================================================

#[cfg(target_os = "macos")]
static SAY_PID: Lazy<Mutex<Option<u32>>> = Lazy::new(|| Mutex::new(None));

#[cfg(target_os = "macos")]
fn kill_running_say() {
    if let Ok(mut guard) = SAY_PID.lock() {
        if let Some(pid) = guard.take() {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn spanish_speak(text: String, variety: String, rate: u32) -> Result<(), String> {
    kill_running_say();
    let voice = if variety.trim() == "es_ES" { "Mónica" } else { "Paulina" };

    SPEAKING.store(true, Ordering::SeqCst);
    let spawned = tokio::process::Command::new("/usr/bin/say")
        .arg("-v")
        .arg(voice)
        .arg("-r")
        .arg(rate.to_string())
        .arg(&text)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            SPEAKING.store(false, Ordering::SeqCst);
            return Err(format!("Failed to start say: {e}"));
        }
    };
    if let Some(pid) = child.id() {
        if let Ok(mut guard) = SAY_PID.lock() {
            *guard = Some(pid);
        }
    }

    let wait_result = child.wait().await;
    if let Ok(mut guard) = SAY_PID.lock() {
        guard.take();
    }
    // Let the room's echo tail settle before re-enabling the listening loop.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    SPEAKING.store(false, Ordering::SeqCst);

    match wait_result {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("say exited with {status}")),
        Err(e) => Err(format!("say failed: {e}")),
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn spanish_speak(_text: String, _variety: String, _rate: u32) -> Result<(), String> {
    Err("Spanish voice is Mac-only for now".to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn spanish_stop_speaking() -> Result<(), String> {
    kill_running_say();
    SPEAKING.store(false, Ordering::SeqCst);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn spanish_stop_speaking() -> Result<(), String> {
    Ok(())
}

// ============================================================================
// LLM tutor turn
// ============================================================================

static TUTOR_HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

fn variety_label(variety: &str) -> &'static str {
    if variety.trim() == "es_ES" {
        "Castilian Spanish, informal tú"
    } else {
        "Mexican Spanish, informal tú"
    }
}

fn build_tutor_system_prompt(profile: &SpanishProfile) -> String {
    format!(
        "You are a warm, patient Spanish conversation partner for a {level} learner named {name}. \
Use {variety} Spanish. Keep the conversation going naturally. Rules: (1) 'reply' is ALWAYS in Spanish, \
1-2 short sentences, and ends with a question that invites the learner to keep talking. Never switch to \
English in 'reply'. Never say the learner was wrong inside 'reply'. Level guide: beginner = present tense, \
very common words, short sentences; intermediate = past tenses, everyday vocabulary; advanced = natural \
native pace, idioms. (2) 'feedback': if the learner's last sentence has ONE clear grammar or word-choice \
error, return {{\"kind\": \"correction\", \"youSaid\": the learner's sentence, \"tryThis\": the corrected \
full sentence, \"why\": ONE plain-English sentence explaining the rule}}. If it is correct and uses a \
phrase worth highlighting, occasionally return {{\"kind\": \"praise\", \"youSaid\": sentence, \"tryThis\": \
same sentence, \"why\": one English sentence on why it is good}}. Otherwise return null. Do not invent \
corrections for minor accent marks or transcription artifacts. Output ONLY a JSON object: \
{{\"reply\": string, \"feedback\": object|null}}.",
        level = profile.level,
        name = profile.name,
        variety = variety_label(&profile.variety),
    )
}

fn situation_line(situation: &Option<String>, topics: &[String]) -> String {
    match situation.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(situation) => format!("Situation: {situation}."),
        None => format!(
            "Situation: free conversation about topics the learner likes: {}.",
            topics.join(", ")
        ),
    }
}

fn conversation_so_far(history: &[Turn]) -> String {
    let recent = if history.len() > 12 {
        &history[history.len() - 12..]
    } else {
        history
    };
    recent
        .iter()
        .map(|turn| {
            let speaker = if turn.role == "tutor" { "Tutor" } else { "Learner" };
            format!("{speaker}: {}", turn.text)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_tutor_user_prompt(request: &TutorRequest) -> Result<String, String> {
    let situation = situation_line(&request.situation, &request.profile.topics);
    match request.mode.as_str() {
        "open" => Ok(format!(
            "{situation} Start the conversation with your first line in Spanish. feedback must be null."
        )),
        "reply" => {
            let learner_text = request
                .learner_text
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .ok_or_else(|| "learner_text is required for reply mode".to_string())?;
            let conversation = conversation_so_far(&request.history);
            Ok(format!(
                "{situation}\nConversation so far:\n{conversation}\nLearner just said: \"{learner_text}\"\nRespond as JSON."
            ))
        }
        "help" => {
            let conversation = conversation_so_far(&request.history);
            Ok(format!(
                "{situation}\nConversation so far:\n{conversation}\nThe learner is stuck. In 'reply' give ONE \
short example sentence in Spanish they could say next (at their level). feedback must be null."
            ))
        }
        other => Err(format!("Unknown tutor mode: {other}")),
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawFeedback {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    you_said: String,
    #[serde(default)]
    try_this: String,
    #[serde(default)]
    why: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawTutorOutput {
    #[serde(default)]
    reply: String,
    #[serde(default)]
    feedback: Option<RawFeedback>,
}

fn strip_think_blocks(input: &str) -> String {
    let mut s = input.to_string();
    loop {
        let Some(start) = s.find("<think>") else { break };
        match s[start..].find("</think>") {
            Some(end_rel) => {
                let end = start + end_rel + "</think>".len();
                s.replace_range(start..end, "");
            }
            None => {
                s.truncate(start);
                break;
            }
        }
    }
    s
}

fn strip_fences(input: &str) -> String {
    input.replace("```json", "").replace("```JSON", "").replace("```", "")
}

fn extract_json_slice(input: &str) -> Option<&str> {
    let start = input.find('{')?;
    let end = input.rfind('}')?;
    if end < start {
        return None;
    }
    Some(&input[start..=end])
}

const FALLBACK_REPLY: &str = "¿Puedes repetir eso, por favor?";

fn parse_tutor_output(raw: &str) -> TutorResponse {
    let cleaned = strip_fences(&strip_think_blocks(raw));
    let fallback = || {
        let trimmed = cleaned.trim();
        if trimmed.is_empty() {
            FALLBACK_REPLY.to_string()
        } else {
            trimmed.chars().take(300).collect::<String>()
        }
    };

    let Some(json_slice) = extract_json_slice(&cleaned) else {
        return TutorResponse { reply: fallback(), feedback: None };
    };
    let Ok(parsed) = serde_json::from_str::<RawTutorOutput>(json_slice) else {
        return TutorResponse { reply: fallback(), feedback: None };
    };

    let reply = {
        let trimmed = parsed.reply.trim();
        if trimmed.is_empty() {
            FALLBACK_REPLY.to_string()
        } else {
            trimmed.to_string()
        }
    };
    let feedback = parsed.feedback.and_then(|f| {
        let kind = f.kind.trim().to_string();
        if (kind == "correction" || kind == "praise") && !f.try_this.trim().is_empty() {
            Some(Feedback {
                kind,
                you_said: f.you_said,
                try_this: f.try_this,
                why: f.why,
            })
        } else {
            None
        }
    });

    TutorResponse { reply, feedback }
}

#[tauri::command]
pub async fn spanish_tutor_turn<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    request: TutorRequest,
) -> Result<TutorResponse, String> {
    let cfg = crate::live_translation::resolve_provider_config(state.db_manager.pool()).await?;
    let system_prompt = build_tutor_system_prompt(&request.profile);
    let user_prompt = build_tutor_user_prompt(&request)?;
    let app_data_dir = app.path().app_data_dir().ok();

    let raw = crate::summary::llm_client::generate_summary(
        &TUTOR_HTTP_CLIENT,
        &cfg.provider,
        &cfg.model_name,
        &cfg.api_key,
        &system_prompt,
        &user_prompt,
        cfg.ollama_endpoint.as_deref(),
        cfg.custom_openai_endpoint.as_deref(),
        Some(350),
        cfg.temperature,
        cfg.top_p,
        app_data_dir.as_ref(),
        None,
    )
    .await?;

    Ok(parse_tutor_output(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_json() {
        let raw = r#"{"reply": "Hola, ¿cómo estás?", "feedback": null}"#;
        let out = parse_tutor_output(raw);
        assert_eq!(out.reply, "Hola, ¿cómo estás?");
        assert!(out.feedback.is_none());
    }

    #[test]
    fn parses_fenced_json_with_think_block() {
        let raw = "<think>reasoning the model should not show</think>```json\n{\"reply\": \"\u{00bf}Qu\u{00e9} tal?\", \"feedback\": {\"kind\": \"correction\", \"youSaid\": \"Yo tengo 20 anos\", \"tryThis\": \"Yo tengo 20 a\u{00f1}os\", \"why\": \"Use \u{00f1} for the tilde sound.\"}}\n```";
        let out = parse_tutor_output(raw);
        assert_eq!(out.reply, "¿Qué tal?");
        let feedback = out.feedback.expect("feedback expected");
        assert_eq!(feedback.kind, "correction");
        assert_eq!(feedback.try_this, "Yo tengo 20 años");
    }

    #[test]
    fn garbage_input_falls_back_to_cleaned_text() {
        let raw = "lo siento, no puedo procesar esto ahora mismo";
        let out = parse_tutor_output(raw);
        assert_eq!(out.reply, raw);
        assert!(out.feedback.is_none());
    }

    #[test]
    fn unknown_feedback_kind_is_dropped() {
        let raw = r#"{"reply": "Vale, sigamos.", "feedback": {"kind": "warning", "youSaid": "x", "tryThis": "y", "why": "z"}}"#;
        let out = parse_tutor_output(raw);
        assert_eq!(out.reply, "Vale, sigamos.");
        assert!(out.feedback.is_none());
    }

    #[test]
    fn empty_input_falls_back_to_prompt_question() {
        let out = parse_tutor_output("");
        assert_eq!(out.reply, FALLBACK_REPLY);
    }
}
