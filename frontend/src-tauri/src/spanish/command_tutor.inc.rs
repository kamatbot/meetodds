// Included by commands.rs after the unchanged microphone and voice commands.
use crate::spanish as core;
use crate::spanish::tutor::{EventSink as _, Model as _};

static TUTOR_GATE: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
static CURRENT_TUTOR: Lazy<Mutex<Option<(String, CancellationToken)>>> = Lazy::new(|| Mutex::new(None));
static TUTOR_HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none()).build().expect("valid native HTTP configuration")
});
struct TutorRegistration(String);
impl Drop for TutorRegistration {
    fn drop(&mut self) {
        if let Ok(mut active) = CURRENT_TUTOR.lock() {
            if active.as_ref().is_some_and(|(id, _)| id == &self.0) { active.take(); }
        }
    }
}
fn cancel_active_tutor() {
    if let Ok(active) = CURRENT_TUTOR.lock() { if let Some((_, token)) = active.as_ref() { token.cancel(); } }
}
fn parse_level(level: &str) -> Result<core::Level, String> {
    match level { "beginner" => Ok(core::Level::Beginner), "intermediate" => Ok(core::Level::Intermediate), "advanced" => Ok(core::Level::Advanced), _ => Err("Choose a supported learner level.".into()) }
}
fn scene_id(situation: Option<&str>) -> &'static str {
    match situation.unwrap_or("").trim() {
        "Ordering food" | "ordering_food" => "ordering_food",
        "Meeting someone new" | "meeting_someone" => "meeting_someone",
        "Telling what happened at school" | "school_day" => "school_day",
        "Planning the weekend" | "weekend_plans" => "weekend_plans",
        "Asking for directions" | "asking_directions" => "asking_directions",
        "Shopping for clothes" | "shopping" => "shopping",
        "Checking into a hotel" | "hotel_checkin" => "hotel_checkin",
        "Planning a party" | "planning_party" => "planning_party",
        _ => "just_talk", // Older free-form situations remain loadable.
    }
}
fn core_profile(profile: &SpanishProfile) -> Result<core::SpanishProfile, String> {
    Ok(core::SpanishProfile { id: profile.id.clone(), name: profile.name.clone(), level: parse_level(&profile.level)?, variety: profile.variety.clone(), topics: profile.topics.clone(), practicing: profile.practicing.clone() })
}
async fn load_profile(pool: &sqlx::SqlitePool, id: &str) -> Result<SpanishProfile, String> {
    sqlx::query_as::<_, ProfileRow>("SELECT id, name, level, variety, topics, practicing, created_at, updated_at FROM spanish_profiles WHERE id = ?")
        .bind(id).fetch_optional(pool).await.map_err(|_| "Cannot load this learner.".to_string())?
        .map(ProfileRow::into_profile).ok_or_else(|| "This learner no longer exists.".into())
}
fn snapshot(turns: &str) -> Option<core::SessionState> {
    let value: serde_json::Value = serde_json::from_str(turns).ok()?;
    value.as_array()?.iter().rev().find_map(|turn| turn.get("spanishTutorState")?.get("state"))
        .and_then(|saved| serde_json::from_value(saved.clone()).ok())
}
fn attach_recaps(sessions: &mut [SpanishSession], profile: &core::SpanishProfile) {
    let reports: Vec<Option<serde_json::Value>> = sessions.iter().enumerate().map(|(i, session)| {
        let state = session.tutor_state.as_ref()?;
        let recent: Vec<core::policy::SessionResult> = sessions[i..].iter().filter(|s| s.ended_at.is_some())
            .filter_map(|s| s.tutor_state.as_ref()).take(3).map(|s| core::policy::SessionResult {
                session_id: s.session_id.clone(), level: s.level, final_dial: s.dial,
                assessed_turns: s.assessed_turns, error_turns: s.error_turns,
            }).collect::<Vec<_>>().into_iter().rev().collect();
        serde_json::to_value(core::policy::recap(state, profile, &recent)).ok()
    }).collect();
    for (session, report) in sessions.iter_mut().zip(reports) { session.recap = report; }
}

// Control-only turns never need provider configuration or external-text consent.
enum SessionModel { ControlOnly, Configured(crate::spanish_provider::MeetOddsModel) }
impl core::tutor::Model for SessionModel {
    fn token_count(&self, text: &str) -> usize { match self { Self::ControlOnly => text.len(), Self::Configured(model) => model.token_count(text) } }
    fn generate<'a>(&'a self, prompt: core::tutor::Prompt, cancel: CancellationToken) -> core::tutor::ModelFuture<'a> {
        match self { Self::ControlOnly => Box::pin(async { Err("No model should be called for this control turn.".into()) }), Self::Configured(model) => model.generate(prompt, cancel) }
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
    fn diagnostic(&self, diagnostic: core::tutor::Diagnostic) { self.window.diagnostic(diagnostic); }
}

#[tauri::command]
pub async fn spanish_tutor_turn<R: Runtime>(
    app: AppHandle<R>, window: tauri::WebviewWindow<R>, state: State<'_, AppState>, request: TutorRequest,
) -> Result<core::tutor::TutorResponse, String> {
    if crate::audio::recording_commands::is_recording().await { return Err("Stop the meeting recording before practicing.".into()); }
    let mode = match request.mode.as_str() {
        "open" => core::tutor::Mode::Open, "reply" => core::tutor::Mode::Reply,
        "help" => core::tutor::Mode::Help, "stuck" => core::tutor::Mode::Stuck,
        _ => return Err("Unsupported tutor mode.".into()),
    };
    let request_id = request.request_id.filter(|id| !id.is_empty()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if request_id.len() > 128 { return Err("Invalid tutor request identifier.".into()); }
    let cancel = CancellationToken::new();
    {
        let mut active = CURRENT_TUTOR.lock().map_err(|_| "Tutor cancellation unavailable.")?;
        if let Some((_, previous)) = active.replace((request_id.clone(), cancel.clone())) { previous.cancel(); }
    }
    let _registration = TutorRegistration(request_id.clone());
    let _gate = tokio::select! { biased; _ = cancel.cancelled() => return Err("Practice turn cancelled".into()), gate = TUTOR_GATE.lock() => gate };
    let pool = state.db_manager.pool();
    let profile = load_profile(pool, &request.profile.id).await?;
    let mut learner = core_profile(&profile)?;
    let session_id = match request.session_id.filter(|id| !id.is_empty()) {
        Some(id) => id,
        None => {
            let ids: Vec<(String,)> = sqlx::query_as("SELECT id FROM spanish_sessions WHERE profile_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 2")
                .bind(&profile.id).fetch_all(pool).await.map_err(|_| "Cannot find the active practice session.")?;
            if ids.len() != 1 { return Err("Open one practice session before requesting a tutor turn.".into()); }
            ids[0].0.clone()
        }
    };
    let row = sqlx::query_as::<_, SessionRow>("SELECT id, profile_id, situation, started_at, ended_at, turns, feedback, level_signal FROM spanish_sessions WHERE id = ? AND profile_id = ?")
        .bind(&session_id).bind(&profile.id).fetch_optional(pool).await.map_err(|_| "Cannot load the practice session.")?
        .ok_or("This practice session does not belong to the selected learner.")?;
    if row.ended_at.is_some() { return Err("This practice session has ended.".into()); }
    let mut tutoring = core::persistence::restore(&row.turns, core::SessionState::new(&session_id, scene_id(row.situation.as_deref()), learner.level))?;
    if tutoring.opener_history.is_empty() && mode == core::tutor::Mode::Open {
        let history: Vec<(String, String)> = sqlx::query_as("SELECT id, turns FROM spanish_sessions WHERE profile_id = ? AND id <> ? ORDER BY started_at DESC LIMIT 5")
            .bind(&profile.id).bind(&session_id).fetch_all(pool).await.map_err(|_| "Cannot load practice history.")?;
        for (id, turns) in history.into_iter().rev() {
            if let Some(saved) = snapshot(&turns) {
                if let Some(opener) = saved.opener_history.into_iter().find(|used| used.session_id == id) { tutoring.opener_history.push(opener); }
            }
        }
    }
    let text = request.learner_text.unwrap_or_default();
    let intent = core::text::classify(&text);
    let learner_input = mode == core::tutor::Mode::Reply && !matches!(intent, core::text::Intent::EmptyOrNoise | core::text::Intent::MetaRequest);
    let needs_model = mode == core::tutor::Mode::Help || (learner_input && !(intent == core::text::Intent::Minimal && tutoring.minimal_streak >= 1));
    let model = if needs_model {
        let cfg = crate::live_translation::resolve_provider_config(pool).await?;
        SessionModel::Configured(crate::spanish_provider::MeetOddsModel::new(TUTOR_HTTP_CLIENT.clone(), crate::spanish_provider::ProviderConfig {
            provider: cfg.provider, model: cfg.model_name, api_key: cfg.api_key,
            app_data_dir: app.path().app_data_dir().map_err(|_| "App storage unavailable.")?,
            ollama_endpoint: cfg.ollama_endpoint, custom_endpoint: cfg.custom_openai_endpoint,
            allow_external_text: request.allow_external_text, cloud_sampling_supported: false,
        })?)
    } else { SessionModel::ControlOnly };
    let engine = core::tutor::TutorEngine::new(Arc::new(model));
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = JournalSink { window: crate::spanish_provider::WindowSink { window, sensitive_diagnostics: None }, events: events.clone() };
    let before = tutoring.clone();
    let outcome = engine.spanish_tutor_turn(core::tutor::TutorRequest { mode, text: text.clone(), request_id, now_ms: chrono::Utc::now().timestamp_millis().max(0) as u64 }, &mut learner, &mut tutoring, &sink, &cancel).await;
    let journal = events.lock().map_err(|_| "Speech journal unavailable.")?.clone();
    let audible: Vec<_> = journal.iter().filter(|event| !event.filler && !event.repeat).collect();
    if outcome.is_err() && audible.is_empty() { return Err(outcome.err().unwrap().to_string()); }
    if outcome.is_err() {
        // A new utterance may cancel the judge AFTER the prior reply was heard.
        // Preserve that real conversation, without grading the cancelled turn.
        tutoring = before.clone();
        if learner_input {
            tutoring.turn_index += 1;
            tutoring.remember("learner", &text);
            tutoring.previous_correction = None;
            core::policy::observe(&mut tutoring, &learner, core::Observation { tokens: core::text::words(&text).len(), error: None, english_mixed: intent == core::text::Intent::EnglishMixed });
            core::scenes::advance(&mut tutoring, false);
        }
        for event in &audible { tutoring.remember("tutor", &event.text); tutoring.last_reply = event.text.clone(); }
        tutoring.previous_turn_filler = journal.iter().any(|event| event.filler);
    }
    let mut turns: Vec<serde_json::Value> = serde_json::from_str(&row.turns).map_err(|_| "Invalid saved practice history.")?;
    if tutoring.turn_index > before.turn_index && learner_input { turns.push(serde_json::json!({"role":"learner","text":text})); }
    for event in &audible {
        if mode != core::tutor::Mode::Open || before.last_reply.is_empty() { turns.push(serde_json::json!({"role":"tutor","text":event.text})); }
    }
    if !turns.is_empty() {
        let update = core::persistence::prepare_update(&serde_json::to_string(&turns).map_err(|_| "Cannot save conversation.")?, &row.feedback, &tutoring, &learner)?;
        let mut transaction = pool.begin().await.map_err(|_| "Cannot start practice save.")?;
        let saved = sqlx::query("UPDATE spanish_sessions SET turns = ?, feedback = ? WHERE id = ? AND profile_id = ? AND ended_at IS NULL")
            .bind(update.turns_json).bind(update.feedback_json).bind(&session_id).bind(&profile.id).execute(&mut *transaction).await.map_err(|_| "Cannot save practice progress.")?;
        if saved.rows_affected() != 1 { return Err("The session changed before progress could be saved.".into()); }
        sqlx::query("UPDATE spanish_profiles SET practicing = ?, updated_at = ? WHERE id = ?")
            .bind(update.practicing_json).bind(chrono::Utc::now().to_rfc3339()).bind(&profile.id).execute(&mut *transaction).await.map_err(|_| "Cannot save learning phrases.")?;
        transaction.commit().await.map_err(|_| "Cannot commit practice progress.")?;
    }
    outcome.map_err(|error| error.to_string())
}
