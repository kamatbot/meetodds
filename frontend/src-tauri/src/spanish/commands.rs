//! Spanish practice: profiles/sessions persistence, mic-only live listening (VAD + STT),
//! macOS `say` playback, and the LLM tutor turn (delegates to the `spanish` tutoring
//! engine — see spanish/tutor.rs, policy.rs, scenes.rs, text.rs, persistence.rs).
use crate::audio::devices::{default_input_device, parse_audio_device};
use crate::audio::recording_state::{AudioChunk, DeviceType, RecordingState};
use crate::audio::stream::AudioStream;
use crate::audio::transcription::{
    get_or_init_transcription_engine, validate_transcription_model_ready, TranscriptionEngine,
};
use crate::audio::vad::ContinuousVadProcessor;
use crate::spanish as core;
use crate::state::AppState;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
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
    /// Target language id (nb, es, en, fr, de, it, pt, zh). Blank from a client
    /// that predates language selection; resolved to Spanish on the way in, to
    /// match the `DEFAULT 'es'` backfill on spanish_profiles.language.
    #[serde(default)]
    pub language: String,
    pub variety: String,
    pub topics: Vec<String>,
    /// Owned by the tutoring engine (spanish_tutor_turn); the client may echo
    /// this back but spanish_save_profile never persists it from the request.
    #[serde(default)]
    pub practicing: Vec<core::PracticingPhrase>,
    /// Client-editable: explicit per-profile consent to send learner text to a
    /// non-loopback (cloud) provider. See spanish_provider::MeetOddsModel::new.
    #[serde(default)]
    pub allow_cloud: bool,
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
    // Additive: populated by the tutoring engine's own Feedback (category/severity
    // are its snake_case enum strings); absent/None for older saved cards.
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub shown: Option<bool>,
    #[serde(default)]
    pub turn_index: Option<usize>,
    #[serde(default)]
    pub count: Option<usize>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCounts {
    pub learner_turns: usize,
    pub corrections: usize,
    pub praise: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecap {
    pub session: SpanishSession,
    pub recap: core::policy::Recap,
    pub counts: SessionCounts,
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
    language: String,
    variety: String,
    topics: String,
    practicing: String,
    allow_cloud: bool,
    created_at: String,
    updated_at: String,
}

impl ProfileRow {
    fn into_profile(self) -> SpanishProfile {
        SpanishProfile {
            id: self.id,
            name: self.name,
            level: self.level,
            language: self.language,
            variety: self.variety,
            topics: serde_json::from_str(&self.topics).unwrap_or_default(),
            practicing: serde_json::from_str(&self.practicing).unwrap_or_default(),
            allow_cloud: self.allow_cloud,
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

const PROFILE_COLUMNS: &str =
    "id, name, level, language, variety, topics, practicing, allow_cloud, created_at, updated_at";
const SESSION_COLUMNS: &str =
    "id, profile_id, situation, started_at, ended_at, turns, feedback, level_signal";

#[tauri::command]
pub async fn spanish_list_profiles(state: State<'_, AppState>) -> Result<Vec<SpanishProfile>, String> {
    let rows = sqlx::query_as::<_, ProfileRow>(&format!(
        "SELECT {PROFILE_COLUMNS} FROM spanish_profiles ORDER BY created_at ASC"
    ))
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
    // An unknown id would strand the profile on a language with no scenes, so it
    // resolves to Spanish here rather than being stored as-is.
    let language = resolve_language(&profile.language);

    // `practicing` is deliberately absent from the UPDATE SET below: the tutoring
    // engine (spanish_tutor_turn) is the only writer of that column. A brand new
    // profile starts with '[]'; an existing one keeps whatever the engine wrote.
    sqlx::query(
        "INSERT INTO spanish_profiles (id, name, level, language, variety, topics, practicing, allow_cloud, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, level = excluded.level, \
             language = excluded.language, variety = excluded.variety, \
             topics = excluded.topics, allow_cloud = excluded.allow_cloud, updated_at = excluded.updated_at",
    )
    .bind(&profile.id)
    .bind(&profile.name)
    .bind(&profile.level)
    .bind(language)
    .bind(&profile.variety)
    .bind(&topics_json)
    .bind(profile.allow_cloud)
    .bind(&created_at)
    .bind(&now)
    .execute(state.db_manager.pool())
    .await
    .map_err(|e| format!("Failed to save Spanish profile: {e}"))?;

    let row = sqlx::query_as::<_, ProfileRow>(&format!(
        "SELECT {PROFILE_COLUMNS} FROM spanish_profiles WHERE id = ?"
    ))
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

// ============================================================================
// Sessions
// ============================================================================

#[tauri::command]
pub async fn spanish_start_session(
    state: State<'_, AppState>,
    profile_id: String,
    situation: Option<String>,
) -> Result<SpanishSession, String> {
    let pool = state.db_manager.pool();
    let now = chrono::Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = pool.begin().await.map_err(|e| format!("Cannot start a practice session: {e}"))?;
    // Exactly one open session per profile: close any other first.
    sqlx::query("UPDATE spanish_sessions SET ended_at = ? WHERE profile_id = ? AND ended_at IS NULL")
        .bind(&now)
        .bind(&profile_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("Failed to close the previous practice session: {e}"))?;
    sqlx::query(
        "INSERT INTO spanish_sessions (id, profile_id, situation, started_at, ended_at, turns, feedback, level_signal) \
         VALUES (?, ?, ?, ?, NULL, '[]', '[]', NULL)",
    )
    .bind(&id)
    .bind(&profile_id)
    .bind(&situation)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("Failed to start a practice session: {e}"))?;
    tx.commit().await.map_err(|e| format!("Failed to start a practice session: {e}"))?;
    Ok(SpanishSession {
        id,
        profile_id,
        situation,
        started_at: now,
        ended_at: None,
        turns: Vec::new(),
        feedback: Vec::new(),
        level_signal: None,
    })
}

/// Read the tutoring engine's own snapshot, if any, out of a session's stored
/// `turns` blob. Mirrors `persistence::prepare_update`'s `spanishTutorState` field.
fn session_engine_state(turns_json: &str) -> Option<core::SessionState> {
    let value: serde_json::Value = serde_json::from_str(turns_json).ok()?;
    value
        .as_array()?
        .iter()
        .rev()
        .find_map(|turn| turn.get("spanishTutorState")?.get("state"))
        .and_then(|saved| serde_json::from_value(saved.clone()).ok())
}

/// The engine does not persist a `Level` per session, only its numeric `dial`.
/// Using the profile's CURRENT level for historical sessions is a deliberate
/// simplification: this only affects the level-bump suggestion's lookback.
fn session_result(row: &SessionRow, level: core::Level) -> Option<core::policy::SessionResult> {
    let s = session_engine_state(&row.turns)?;
    Some(core::policy::SessionResult {
        session_id: s.session_id,
        level,
        final_dial: s.dial,
        assessed_turns: s.assessed_turns,
        error_turns: s.error_turns,
    })
}

fn empty_recap() -> core::policy::Recap {
    core::policy::Recap {
        focus_next_time: Vec::new(),
        findings: Vec::new(),
        mastered_phrases: Vec::new(),
        suggest_level_bump: false,
    }
}

fn count_session(session: &SpanishSession) -> SessionCounts {
    SessionCounts {
        learner_turns: session.turns.iter().filter(|t| t.role == "learner").count(),
        corrections: session.feedback.iter().filter(|f| f.kind == "correction").count(),
        praise: session.feedback.iter().filter(|f| f.kind == "praise").count(),
    }
}

#[tauri::command]
pub async fn spanish_end_session(
    state: State<'_, AppState>,
    session_id: String,
    level_signal: Option<String>,
) -> Result<SessionRecap, String> {
    let pool = state.db_manager.pool();
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE spanish_sessions SET ended_at = ?, level_signal = COALESCE(?, level_signal) WHERE id = ?")
        .bind(&now)
        .bind(&level_signal)
        .bind(&session_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to end the practice session: {e}"))?;

    let row = sqlx::query_as::<_, SessionRow>(&format!("SELECT {SESSION_COLUMNS} FROM spanish_sessions WHERE id = ?"))
        .bind(&session_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to load the practice session: {e}"))?
        .ok_or("This practice session no longer exists.")?;

    let profile_row = sqlx::query_as::<_, ProfileRow>(&format!(
        "SELECT {PROFILE_COLUMNS} FROM spanish_profiles WHERE id = ?"
    ))
    .bind(&row.profile_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to load the learner profile: {e}"))?
    .ok_or("This learner no longer exists.")?;
    let profile = profile_row.into_profile();
    let learner_level = parse_level(&profile.level).unwrap_or_default();

    let recap = match session_engine_state(&row.turns) {
        None => empty_recap(),
        Some(state) => {
            let recent_rows = sqlx::query_as::<_, SessionRow>(&format!(
                "SELECT {SESSION_COLUMNS} FROM spanish_sessions \
                 WHERE profile_id = ? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 3"
            ))
            .bind(&row.profile_id)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("Failed to load recent practice sessions: {e}"))?;
            let recent: Vec<core::policy::SessionResult> = recent_rows
                .iter()
                .rev() // oldest first
                .filter_map(|r| session_result(r, learner_level))
                .collect();
            let core_profile = core_profile(&profile).unwrap_or_default();
            core::policy::recap(&state, &core_profile, &recent)
        }
    };
    let session = row.into_session();
    let counts = count_session(&session);
    Ok(SessionRecap { session, recap, counts })
}

#[tauri::command]
pub async fn spanish_list_sessions(
    state: State<'_, AppState>,
    profile_id: String,
    limit: u32,
) -> Result<Vec<SpanishSession>, String> {
    let limit: i64 = if limit == 0 { i64::MAX } else { limit.into() };
    let rows = sqlx::query_as::<_, SessionRow>(&format!(
        "SELECT {SESSION_COLUMNS} FROM spanish_sessions WHERE profile_id = ? ORDER BY started_at DESC LIMIT ?"
    ))
    .bind(&profile_id)
    .bind(limit)
    .fetch_all(state.db_manager.pool())
    .await
    .map_err(|e| format!("Failed to list Spanish sessions: {e}"))?;
    Ok(rows.into_iter().map(SessionRow::into_session).collect())
}

/// ponytail: kept only for backward compatibility with the pre-engine contract.
/// The native engine (spanish_tutor_turn) is the sole writer of turns/feedback;
/// this now shares spanish_end_session's narrow update (level_signal/ended_at only).
#[tauri::command]
pub async fn spanish_save_session(state: State<'_, AppState>, session: SpanishSession) -> Result<(), String> {
    if session.id.trim().is_empty() {
        return Err("session id cannot be empty".to_string());
    }
    sqlx::query("UPDATE spanish_sessions SET level_signal = COALESCE(?, level_signal), ended_at = COALESCE(?, ended_at) WHERE id = ?")
        .bind(&session.level_signal)
        .bind(&session.ended_at)
        .bind(&session.id)
        .execute(state.db_manager.pool())
        .await
        .map_err(|e| format!("Failed to save Spanish session: {e}"))?;
    Ok(())
}


// ============================================================================
// Local-only model resolution for real-time tutoring
// ============================================================================

/// The tutor's reply and correction calls always run on a local model so the
/// conversation feels real time and learner speech never leaves the Mac. Cloud
/// providers are only used for offline work such as building class lessons.
pub(crate) struct LocalLlm {
    pub provider: crate::summary::llm_client::LLMProvider,
    pub provider_name: &'static str,
    pub model: String,
    pub ollama_endpoint: Option<String>,
    pub custom_endpoint: Option<String>,
}

pub(crate) async fn resolve_local_llm(
    pool: &sqlx::SqlitePool,
    app_data_dir: &std::path::PathBuf,
) -> Result<LocalLlm, String> {
    use crate::summary::llm_client::LLMProvider;
    use crate::summary::summary_engine::models::{get_available_models, get_model_path};
    let builtin_present = |name: &str| get_model_path(app_data_dir, name).map_or(false, |p| p.exists());
    if let Ok(cfg) = crate::live_translation::resolve_provider_config(pool).await {
        match cfg.provider {
            LLMProvider::BuiltInAI if builtin_present(&cfg.model_name) => {
                return Ok(LocalLlm { provider: LLMProvider::BuiltInAI, provider_name: "builtin-ai", model: cfg.model_name, ollama_endpoint: None, custom_endpoint: None });
            }
            LLMProvider::Ollama
                if crate::spanish_provider::loopback(cfg.ollama_endpoint.as_deref().unwrap_or("http://localhost:11434")) =>
            {
                return Ok(LocalLlm { provider: LLMProvider::Ollama, provider_name: "ollama", model: cfg.model_name, ollama_endpoint: cfg.ollama_endpoint, custom_endpoint: None });
            }
            LLMProvider::CustomOpenAI if cfg.custom_openai_endpoint.as_deref().is_some_and(crate::spanish_provider::loopback) => {
                return Ok(LocalLlm { provider: LLMProvider::CustomOpenAI, provider_name: "custom-openai", model: cfg.model_name, ollama_endpoint: None, custom_endpoint: cfg.custom_openai_endpoint });
            }
            _ => {}
        }
    }
    // Fall back to any downloaded built-in model, best first (models.rs order).
    if let Some(model) = get_available_models().into_iter().find(|m| builtin_present(&m.name)) {
        return Ok(LocalLlm { provider: LLMProvider::BuiltInAI, provider_name: "builtin-ai", model: model.name, ollama_endpoint: None, custom_endpoint: None });
    }
    Err("Real-time practice runs on a local model. Download one in Settings → Summary model (Qwen 3.5 2B is a good start); cloud models are only used for lesson summaries.".to_string())
}


/// Beginner aid: an English gloss of one tutor line, on the local model only.
#[tauri::command]
pub async fn spanish_translate_line<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    text: String,
) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() || text.len() > 600 {
        return Err("Nothing to translate.".to_string());
    }
    let app_data_dir = app.path().app_data_dir().map_err(|_| "App storage unavailable.")?;
    let llm = resolve_local_llm(state.db_manager.pool(), &app_data_dir).await?;
    let raw = crate::summary::llm_client::generate_summary(
        &TUTOR_HTTP_CLIENT,
        &llm.provider,
        &llm.model,
        "",
        "Translate the Spanish line into natural English. Output only the English sentence, nothing else. /no_think",
        text,
        llm.ollama_endpoint.as_deref(),
        llm.custom_endpoint.as_deref(),
        Some(120),
        None,
        None,
        Some(&app_data_dir),
        None,
    )
    .await?;
    let cleaned = core::text::strip_thinking(&raw);
    let line = cleaned.trim().trim_matches('"').trim();
    if line.is_empty() {
        return Err("The model returned no translation.".to_string());
    }
    Ok(line.to_string())
}

/// Example answer for "Help me answer". Stateless and local so the frontend can
/// prefetch it as soon as a tutor line arrives; it queues behind the judge on
/// the single built-in model slot.
#[tauri::command]
pub async fn spanish_help_suggestion<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    profile_id: String,
    question: String,
) -> Result<String, String> {
    let question = question.trim();
    if question.is_empty() || question.len() > 600 {
        return Err("Nothing to answer yet.".to_string());
    }
    let pool = state.db_manager.pool();
    let profile = load_profile(pool, &profile_id).await?;
    let (words, level) = match profile.level.as_str() {
        "beginner" => (8, "principiante"),
        "intermediate" => (14, "intermedio"),
        _ => (20, "avanzado"),
    };
    let app_data_dir = app.path().app_data_dir().map_err(|_| "App storage unavailable.")?;
    let llm = resolve_local_llm(pool, &app_data_dir).await?;
    let system = format!(
        "Eres un tutor de español. Da UNA frase corta de ejemplo (máximo {words} palabras, nivel {level}) que el alumno podría decir para responder a la pregunta. Solo la frase en español, sin comillas ni explicación. /no_think"
    );
    let raw = crate::summary::llm_client::generate_summary(
        &TUTOR_HTTP_CLIENT,
        &llm.provider,
        &llm.model,
        "",
        &system,
        question,
        llm.ollama_endpoint.as_deref(),
        llm.custom_endpoint.as_deref(),
        Some(48),
        None,
        None,
        Some(&app_data_dir),
        None,
    )
    .await?;
    let cleaned = core::text::strip_thinking(&raw);
    let line = core::text::limit_sentences(cleaned.trim().trim_matches('"').trim(), 1);
    if line.is_empty() || core::text::english_ratio(resolve_language(&profile.language), &line) >= 0.5 {
        return Err("The model did not return a Spanish example.".to_string());
    }
    Ok(line)
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

    let (llm_provider, llm_model, llm_ready, llm_message) = match app.path().app_data_dir() {
        Ok(dir) => match resolve_local_llm(state.db_manager.pool(), &dir).await {
            Ok(llm) => (Some(llm.provider_name.to_string()), Some(llm.model), true, None),
            Err(e) => (None, None, false, Some(e)),
        },
        Err(_) => (None, None, false, Some("App storage unavailable.".to_string())),
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
/// Bumped by every speak/stop so a superseded `say` never un-mutes the mic
/// or clears the pid of the utterance that replaced it.
static SPEAK_GEN: AtomicU64 = AtomicU64::new(0);

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
    let generation = SPEAK_GEN.fetch_add(1, Ordering::SeqCst) + 1;

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
    if SPEAK_GEN.load(Ordering::SeqCst) == generation {
        if let Ok(mut guard) = SAY_PID.lock() {
            guard.take();
        }
        // Let the room's echo tail settle before re-enabling the listening loop.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if SPEAK_GEN.load(Ordering::SeqCst) == generation {
            SPEAKING.store(false, Ordering::SeqCst);
        }
    }

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
    SPEAK_GEN.fetch_add(1, Ordering::SeqCst);
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
// LLM tutor turn — delegates to the `spanish` tutoring engine
// ============================================================================

static TUTOR_HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});
/// Guards against two overlapping turns ever reaching the shared local model at once.
static TUTOR_GATE: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
/// Single global "latest request" slot: a new turn cancels whatever came before it,
/// across all sessions. This mirrors the draft; per-session leases are additionally
/// enforced inside TutorEngine itself.
static CURRENT_TUTOR: Lazy<Mutex<Option<(String, CancellationToken)>>> = Lazy::new(|| Mutex::new(None));

struct TutorRegistration(String);
impl Drop for TutorRegistration {
    fn drop(&mut self) {
        if let Ok(mut active) = CURRENT_TUTOR.lock() {
            if active.as_ref().is_some_and(|(id, _)| id == &self.0) {
                active.take();
            }
        }
    }
}

fn parse_level(level: &str) -> Result<core::Level, String> {
    match level {
        "beginner" => Ok(core::Level::Beginner),
        "intermediate" => Ok(core::Level::Intermediate),
        "advanced" => Ok(core::Level::Advanced),
        _ => Err("Choose a supported learner level.".into()),
    }
}

/// Frontend situation labels are exact strings (see the situation picker); anything
/// else — including "Talking about your family", "At the doctor", a class-lesson
/// brief's free text, or no situation at all — falls back to open conversation.
/// First "Good questions to ask" prompt embedded by spanish_class::build_situation.
fn lesson_opener(situation: Option<&str>) -> Option<String> {
    let s = situation?;
    if !s.starts_with("Reviewing the learner's Spanish class") {
        return None;
    }
    let rest = s.split("Good questions to ask: ").nth(1)?;
    let q = rest.split(" / ").next()?.trim().trim_end_matches('.').trim();
    (!q.is_empty()).then(|| q.to_string())
}

fn scene_id(situation: Option<&str>) -> &'static str {
    match situation.unwrap_or("").trim() {
        "Ordering food" => "ordering_food",
        "Meeting someone new" => "meeting_someone",
        "Telling what happened at school" => "school_day",
        "Planning the weekend" => "weekend_plans",
        "Asking for directions" => "asking_directions",
        "Shopping for clothes" => "shopping",
        _ => "just_talk",
    }
}

/// Maps a stored or client-supplied language id onto one the engine can serve.
/// Blank (pre-multilingual profiles) and unrecognised ids both read as Spanish.
fn resolve_language(id: &str) -> &'static str {
    crate::languages::module(id.trim())
        .map(|m| m.id)
        .unwrap_or(core::LEGACY_LANGUAGE_ID)
}

fn core_profile(profile: &SpanishProfile) -> Result<core::LearnerProfile, String> {
    Ok(core::LearnerProfile {
        id: profile.id.clone(),
        name: profile.name.clone(),
        level: parse_level(&profile.level)?,
        language: resolve_language(&profile.language).to_string(),
        variety: profile.variety.clone(),
        topics: profile.topics.clone(),
        practicing: profile.practicing.clone(),
    })
}

async fn load_profile(pool: &sqlx::SqlitePool, id: &str) -> Result<SpanishProfile, String> {
    sqlx::query_as::<_, ProfileRow>(&format!("SELECT {PROFILE_COLUMNS} FROM spanish_profiles WHERE id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|_| "Cannot load this learner.".to_string())?
        .map(ProfileRow::into_profile)
        .ok_or_else(|| "This learner no longer exists.".into())
}

// Control-only turns never need provider configuration or external-text consent.
enum SessionModel {
    ControlOnly,
    Configured(crate::spanish_provider::MeetOddsModel),
}
impl core::tutor::Model for SessionModel {
    fn token_count(&self, text: &str) -> usize {
        match self {
            // ponytail: byte heuristic; no model is ever called for a control turn anyway.
            Self::ControlOnly => text.len() / 3 + 1,
            Self::Configured(model) => model.token_count(text),
        }
    }
    fn generate<'a>(&'a self, prompt: core::tutor::Prompt, cancel: CancellationToken) -> core::tutor::ModelFuture<'a> {
        match self {
            Self::ControlOnly => Box::pin(async { Err("No model should be called for this control turn.".into()) }),
            Self::Configured(model) => model.generate(prompt, cancel),
        }
    }
}

struct JournalSink<R: Runtime> {
    window: crate::spanish_provider::WindowSink<R>,
    events: Arc<Mutex<Vec<core::tutor::TutorReplyEvent>>>,
}
impl<R: Runtime> core::tutor::EventSink for JournalSink<R> {
    fn reply(&self, event: core::tutor::TutorReplyEvent) -> Result<(), String> {
        self.window.reply(event.clone())?;
        self.events.lock().map_err(|_| "Speech journal unavailable.")?.push(event);
        Ok(())
    }
    fn diagnostic(&self, diagnostic: core::tutor::Diagnostic) {
        self.window.diagnostic(diagnostic);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TutorTurnRequest {
    pub profile_id: String,
    pub session_id: String,
    pub mode: String,
    #[serde(default)]
    pub learner_text: Option<String>,
    pub request_id: String,
}

#[tauri::command]
pub async fn spanish_tutor_turn<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    request: TutorTurnRequest,
) -> Result<core::TutorResponse, String> {
    if crate::audio::recording_commands::is_recording().await {
        return Err("Stop the meeting recording before practicing.".into());
    }
    let mode = match request.mode.as_str() {
        "open" => core::tutor::Mode::Open,
        "reply" => core::tutor::Mode::Reply,
        "help" => core::tutor::Mode::Help,
        "stuck" => core::tutor::Mode::Stuck,
        _ => return Err("Unsupported tutor mode.".into()),
    };
    if request.request_id.is_empty() || request.request_id.len() > 128 {
        return Err("Invalid tutor request identifier.".into());
    }
    let request_id = request.request_id;
    let cancel = CancellationToken::new();
    {
        let mut active = CURRENT_TUTOR.lock().map_err(|_| "Tutor cancellation unavailable.")?;
        if let Some((_, previous)) = active.replace((request_id.clone(), cancel.clone())) {
            previous.cancel();
        }
    }
    let _registration = TutorRegistration(request_id.clone());
    let _gate = tokio::select! { biased; _ = cancel.cancelled() => return Err("Practice turn cancelled".into()), gate = TUTOR_GATE.lock() => gate };

    let pool = state.db_manager.pool();
    let profile = load_profile(pool, &request.profile_id).await?;
    let mut learner = core_profile(&profile)?;

    let row = sqlx::query_as::<_, SessionRow>(&format!(
        "SELECT {SESSION_COLUMNS} FROM spanish_sessions WHERE id = ? AND profile_id = ?"
    ))
    .bind(&request.session_id)
    .bind(&profile.id)
    .fetch_optional(pool)
    .await
    .map_err(|_| "Cannot load the practice session.")?
    .ok_or("This practice session does not belong to the selected learner.")?;
    if row.ended_at.is_some() {
        return Err("This practice session has ended.".into());
    }
    let scene = scene_id(row.situation.as_deref());
    let mut tutoring =
        core::persistence::restore(&row.turns, core::SessionState::new(&request.session_id, scene, learner.level))?;

    if tutoring.opener_history.is_empty() && mode == core::tutor::Mode::Open {
        let history: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, turns FROM spanish_sessions WHERE profile_id = ? AND id <> ? ORDER BY started_at DESC LIMIT 5",
        )
        .bind(&profile.id)
        .bind(&request.session_id)
        .fetch_all(pool)
        .await
        .map_err(|_| "Cannot load practice history.")?;
        for (id, turns) in history.into_iter().rev() {
            if let Some(saved) = session_engine_state(&turns) {
                if let Some(opener) = saved.opener_history.into_iter().find(|used| used.session_id == id) {
                    tutoring.opener_history.push(opener);
                }
            }
        }
    }

    let text = request.learner_text.unwrap_or_default();
    let intent = core::text::classify(learner.language_id(), &text);
    let learner_input =
        mode == core::tutor::Mode::Reply && !matches!(intent, core::text::Intent::EmptyOrNoise | core::text::Intent::MetaRequest);
    let needs_model =
        mode == core::tutor::Mode::Help || (learner_input && !(intent == core::text::Intent::Minimal && tutoring.minimal_streak >= 1));
    let model = if needs_model {
        let app_data_dir = app.path().app_data_dir().map_err(|_| "App storage unavailable.")?;
        let llm = resolve_local_llm(pool, &app_data_dir).await?;
        SessionModel::Configured(crate::spanish_provider::MeetOddsModel::new(
            TUTOR_HTTP_CLIENT.clone(),
            crate::spanish_provider::ProviderConfig {
                provider: llm.provider,
                model: llm.model,
                api_key: String::new(),
                app_data_dir,
                ollama_endpoint: llm.ollama_endpoint,
                custom_endpoint: llm.custom_endpoint,
                // resolve_local_llm only ever returns loopback/built-in providers.
                allow_external_text: false,
                cloud_sampling_supported: false,
            },
        )?)
    } else {
        SessionModel::ControlOnly
    };
    let engine = core::tutor::TutorEngine::new(Arc::new(model));
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = JournalSink {
        window: crate::spanish_provider::WindowSink { window, sensitive_diagnostics: None },
        events: events.clone(),
    };
    let before = tutoring.clone();
    // ponytail: a class lesson opens with one of its own questions. The brief's
    // prompts travel inside the situation text, so parse the first one back out.
    if mode == core::tutor::Mode::Open && tutoring.last_reply.is_empty() {
        if let Some(question) = lesson_opener(row.situation.as_deref()) {
            tutoring.remember("tutor", &question);
            tutoring.last_reply = question;
        }
    }
    let outcome = engine
        .spanish_tutor_turn(
            core::tutor::TutorRequest {
                mode,
                text: text.clone(),
                request_id,
                now_ms: chrono::Utc::now().timestamp_millis().max(0) as u64,
                // Lesson/free-text sessions (e.g. a class-lesson brief) carry their goal
                // in `situation`; the engine only consumes it for the just_talk scene.
                goal: row.situation.clone(),
            },
            &mut learner,
            &mut tutoring,
            &sink,
            &cancel,
        )
        .await;
    let journal = events.lock().map_err(|_| "Speech journal unavailable.")?.clone();
    let audible: Vec<_> = journal.iter().filter(|event| !event.filler && !event.repeat).collect();
    if outcome.is_err() && audible.is_empty() {
        return Err(outcome.err().unwrap().to_string());
    }
    if outcome.is_err() {
        // A new utterance may cancel the judge AFTER the prior reply was heard.
        // Preserve that real conversation, without grading the cancelled turn.
        tutoring = before.clone();
        if learner_input {
            tutoring.turn_index += 1;
            tutoring.remember("learner", &text);
            tutoring.previous_correction = None;
            core::policy::observe(
                &mut tutoring,
                &learner,
                core::Observation { tokens: core::text::words(learner.language_id(), &text).len(), error: None, english_mixed: intent == core::text::Intent::EnglishMixed },
            );
            core::scenes::advance(learner.language_id(), &mut tutoring, false);
        }
        for event in &audible {
            tutoring.remember("tutor", &event.text);
            tutoring.last_reply = event.text.clone();
        }
        tutoring.previous_turn_filler = journal.iter().any(|event| event.filler);
    }

    let mut turns: Vec<serde_json::Value> = serde_json::from_str(&row.turns).map_err(|_| "Invalid saved practice history.")?;
    if tutoring.turn_index > before.turn_index && learner_input {
        turns.push(serde_json::json!({"role":"learner","text":text}));
    }
    for event in &audible {
        if mode != core::tutor::Mode::Open || before.last_reply.is_empty() {
            turns.push(serde_json::json!({"role":"tutor","text":event.text}));
        }
    }
    if !turns.is_empty() {
        let update = core::persistence::prepare_update(
            &serde_json::to_string(&turns).map_err(|_| "Cannot save conversation.")?,
            &row.feedback,
            &tutoring,
            &learner,
        )?;
        let mut transaction = pool.begin().await.map_err(|_| "Cannot start practice save.")?;
        let saved = sqlx::query(
            "UPDATE spanish_sessions SET turns = ?, feedback = ? WHERE id = ? AND profile_id = ? AND ended_at IS NULL",
        )
        .bind(update.turns_json)
        .bind(update.feedback_json)
        .bind(&request.session_id)
        .bind(&profile.id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "Cannot save practice progress.")?;
        if saved.rows_affected() != 1 {
            return Err("The session changed before progress could be saved.".into());
        }
        sqlx::query("UPDATE spanish_profiles SET practicing = ?, updated_at = ? WHERE id = ?")
            .bind(update.practicing_json)
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(&profile.id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| "Cannot save learning phrases.")?;
        transaction.commit().await.map_err(|_| "Cannot commit practice progress.")?;
    }
    outcome.map_err(|error| error.to_string())
}

// ============================================================================
// Practice-it word-diff attempt
// ============================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeResult {
    pub score: f32,
    pub missed_word_indices: Vec<usize>,
    pub message: String,
    pub done: bool,
    pub succeeded: bool,
    pub attempts: u8,
}

#[tauri::command]
pub fn spanish_practice_attempt(
    target: String,
    attempt: String,
    previous_attempts: u8,
    // Optional so a client that predates language selection keeps working; an
    // absent or unknown value resolves to Spanish, as elsewhere.
    language: Option<String>,
) -> Result<PracticeResult, String> {
    let lang = resolve_language(language.as_deref().unwrap_or_default());
    let result = core::text::practice_attempt(lang, &target, &attempt, previous_attempts)
        .map_err(|e| e.to_string())?;
    Ok(PracticeResult {
        score: result.diff.score,
        missed_word_indices: result.diff.missed_word_indices,
        message: result.message,
        done: result.done,
        succeeded: result.succeeded,
        attempts: result.attempts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lesson_opener_uses_the_first_class_prompt() {
        let situation = "Reviewing the learner's Spanish class \"Clase 3\" about food. Good questions to ask: ¿Qué comiste hoy? / ¿Te gusta el pan?";
        assert_eq!(lesson_opener(Some(situation)).as_deref(), Some("¿Qué comiste hoy?"));
        assert_eq!(lesson_opener(Some("Ordering food")), None);
        assert_eq!(lesson_opener(None), None);
    }

    #[test]
    fn scene_id_maps_all_eight_frontend_situation_labels() {
        assert_eq!(scene_id(Some("Ordering food")), "ordering_food");
        assert_eq!(scene_id(Some("Meeting someone new")), "meeting_someone");
        assert_eq!(scene_id(Some("Telling what happened at school")), "school_day");
        assert_eq!(scene_id(Some("Planning the weekend")), "weekend_plans");
        assert_eq!(scene_id(Some("Asking for directions")), "asking_directions");
        assert_eq!(scene_id(Some("Talking about your family")), "just_talk");
        assert_eq!(scene_id(Some("At the doctor")), "just_talk");
        assert_eq!(scene_id(Some("Shopping for clothes")), "shopping");
        assert_eq!(scene_id(None), "just_talk");
        assert_eq!(
            scene_id(Some("Reviewing the learner's Spanish class \"Clase 3\".")),
            "just_talk"
        );
    }
}
