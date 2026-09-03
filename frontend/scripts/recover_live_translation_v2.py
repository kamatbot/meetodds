from pathlib import Path
import re
from textwrap import dedent


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old in text:
        return text.replace(old, new, 1)
    if new in text:
        return text
    raise SystemExit(f"missing anchor for {label}: {old[:180]!r}")


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count == 1:
        return updated
    if replacement in text:
        return text
    raise SystemExit(f"missing regex anchor for {label}: {pattern[:180]!r}")


# ---------------------------------------------------------------------------
# Native adaptive translation routing
# ---------------------------------------------------------------------------
rust_path = Path("frontend/src-tauri/src/live_translation.rs")
rust = rust_path.read_text()

rust = replace_once(
    rust,
    "const DELTA_EMIT_INTERVAL: Duration = Duration::from_millis(40);\n",
    dedent('''\
    const DELTA_EMIT_INTERVAL: Duration = Duration::from_millis(40);
    const FAST_GROQ_MODEL: &str = "llama-3.1-8b-instant";
    const FAST_OPENAI_MODEL: &str = "gpt-4o-mini";
    const FAST_CLAUDE_MODEL: &str = "claude-haiku-4-5-20251001";
    const PROVIDER_COOLDOWN: Duration = Duration::from_secs(45);
    '''),
    "translation constants",
)

rust = replace_once(
    rust,
    "static TRANSLATION_HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(reqwest::Client::new);",
    dedent('''\
    static TRANSLATION_HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_nodelay(true)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });'''),
    "shared low latency client",
)

rust = replace_once(
    rust,
    "static TRANSLATION_CACHE: Lazy<Mutex<TranslationCache>> =\n    Lazy::new(|| Mutex::new(TranslationCache::default()));",
    dedent('''\
    static TRANSLATION_CACHE: Lazy<Mutex<TranslationCache>> =
        Lazy::new(|| Mutex::new(TranslationCache::default()));
    static PROVIDER_HEALTH: Lazy<Mutex<HashMap<String, ProviderHealth>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));'''),
    "provider health registry",
)

rust = replace_once(
    rust,
    "#[derive(Debug, Clone)]\nstruct ActiveTranslation {",
    dedent('''\
    #[derive(Debug, Clone, Default)]
    struct ProviderHealth {
        consecutive_failures: u32,
        average_first_word_ms: Option<u64>,
        cooldown_until: Option<Instant>,
    }

    #[derive(Debug, Clone, Copy)]
    struct TranslationBudgets {
        first_word: Duration,
        attempt: Duration,
        total: Duration,
    }

    #[derive(Debug, Clone)]
    struct ActiveTranslation {'''),
    "provider health structs",
)

rust = regex_once(
    rust,
    r'#\[derive\(Debug, Clone, Serialize\)\]\n#\[serde\(rename_all = "camelCase"\)\]\npub struct LiveTranslationResponse \{.*?\n\}',
    dedent('''\
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct LiveTranslationResponse {
        pub request_id: String,
        pub translated_text: String,
        pub source_language: Option<String>,
        pub target_language: String,
        pub provider: String,
        pub model: String,
        pub latency_ms: u64,
        pub first_word_latency_ms: u64,
        pub fallback_reason: Option<String>,
        pub cached: bool,
    }'''),
    "translation response",
)

rust = replace_once(
    rust,
    "struct TranslationProviderConfig {",
    "#[derive(Clone)]\nstruct TranslationProviderConfig {",
    "provider config clone",
)

rust = regex_once(
    rust,
    r'fn build_translation_prompts\(.*?\n\}',
    dedent('''\
    fn build_translation_prompts(
        text: &str,
        source_language: Option<LanguageSpec>,
        target_language: LanguageSpec,
        context_text: Option<&str>,
        glossary: Option<&str>,
        context_hint: Option<&str>,
    ) -> (String, String) {
        let source = source_language
            .map(|language| language.name.to_string())
            .unwrap_or_else(|| "the automatically detected source language".to_string());

        let mut system_prompt = format!(
            "You are a simultaneous interpreter for a live business meeting. Translate from {source} to {}. \\\nReturn ONLY the translation of the CURRENT UTTERANCE. Never repeat the reference context. \\\nPrefer natural spoken language over literal word-for-word phrasing. Preserve names, product terms, numbers, dates, URLs, and intent. \\\nTranslate short turns such as Yes, No, Agreed, and interruptions; do not invent missing speech. \\\nIf the current utterance is already in {}, return it unchanged.",
            target_language.name, target_language.name
        );

        if let Some(hint) = context_hint.map(str::trim).filter(|value| !value.is_empty()) {
            system_prompt.push_str("\\nMeeting context: ");
            system_prompt.push_str(hint);
        }
        if let Some(terms) = glossary.map(str::trim).filter(|value| !value.is_empty()) {
            system_prompt.push_str("\\nTerminology / names to preserve consistently: ");
            system_prompt.push_str(terms);
        }
        if let Some(context) = context_text.map(str::trim).filter(|value| !value.is_empty()) {
            system_prompt.push_str("\\nReference-only previous turns (DO NOT translate or output these):\\n");
            system_prompt.push_str(context);
        }

        (system_prompt, text.to_string())
    }'''),
    "context-aware prompt",
)

rust = regex_once(
    rust,
    r'/// Read a server-sent-event body\..*?\nasync fn stream_sse\(.*?\n\}',
    dedent('''\
    /// Read a server-sent-event body while enforcing a time-to-first-text budget.
    async fn stream_sse(
        response: reqwest::Response,
        mut extract: impl FnMut(&Value) -> Result<Option<String>, String>,
        mut on_text: impl FnMut(&str, u64),
        attempt_started: Instant,
        first_word_budget: Duration,
    ) -> Result<(String, u64), String> {
        let mut stream = response.bytes_stream();
        let mut buffer: Vec<u8> = Vec::new();
        let mut text = String::new();
        let mut first_word_ms: Option<u64> = None;

        loop {
            let next_chunk = if first_word_ms.is_none() {
                let Some(remaining) = first_word_budget.checked_sub(attempt_started.elapsed()) else {
                    return Err(format!("first translated word exceeded {}ms", first_word_budget.as_millis()));
                };
                timeout(remaining, stream.next())
                    .await
                    .map_err(|_| format!("first translated word exceeded {}ms", first_word_budget.as_millis()))?
            } else {
                stream.next().await
            };

            let Some(chunk) = next_chunk else { break };
            let chunk = chunk.map_err(|error| format!("Translation stream failed: {error}"))?;
            buffer.extend_from_slice(&chunk);
            while let Some(newline) = buffer.iter().position(|byte| *byte == b'\\n') {
                let line: Vec<u8> = buffer.drain(..=newline).collect();
                let line = String::from_utf8_lossy(&line);
                let Some(data) = line.trim().strip_prefix("data:") else { continue };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" { continue; }
                let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
                if let Some(delta) = extract(&event)? {
                    if !delta.is_empty() {
                        text.push_str(&delta);
                        let first = *first_word_ms.get_or_insert_with(|| {
                            attempt_started.elapsed().as_millis().min(u64::MAX as u128) as u64
                        });
                        on_text(&text, first);
                    }
                }
            }
        }

        if text.trim().is_empty() {
            return Err("translation stream ended before producing text".to_string());
        }
        Ok((
            text,
            first_word_ms.unwrap_or_else(|| attempt_started.elapsed().as_millis() as u64),
        ))
    }'''),
    "first word streaming budget",
)

rust = regex_once(
    rust,
    r'fn cache_key\(.*?\n\}',
    dedent('''\
    fn cache_key(
        provider: &str,
        model: &str,
        source_language: Option<LanguageSpec>,
        target_language: LanguageSpec,
        text: &str,
        context_text: Option<&str>,
        glossary: Option<&str>,
        context_hint: Option<&str>,
    ) -> String {
        let mut hasher = DefaultHasher::new();
        provider.hash(&mut hasher);
        model.hash(&mut hasher);
        source_language.map(|language| language.code).hash(&mut hasher);
        target_language.code.hash(&mut hasher);
        text.hash(&mut hasher);
        context_text.unwrap_or_default().hash(&mut hasher);
        glossary.unwrap_or_default().hash(&mut hasher);
        context_hint.unwrap_or_default().hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    }'''),
    "context-aware cache key",
)

helpers = dedent(r'''
fn translation_budgets(speed: Option<&str>) -> TranslationBudgets {
    match speed.unwrap_or("instant").trim().to_ascii_lowercase().as_str() {
        "accurate" => TranslationBudgets {
            first_word: Duration::from_secs(10),
            attempt: Duration::from_secs(30),
            total: Duration::from_secs(32),
        },
        "balanced" => TranslationBudgets {
            first_word: Duration::from_millis(3200),
            attempt: Duration::from_secs(15),
            total: Duration::from_secs(22),
        },
        _ => TranslationBudgets {
            first_word: Duration::from_millis(1800),
            attempt: Duration::from_secs(8),
            total: Duration::from_secs(12),
        },
    }
}

fn fast_default_model(provider: &str) -> Option<&'static str> {
    match provider {
        "groq" => Some(FAST_GROQ_MODEL),
        "openai" => Some(FAST_OPENAI_MODEL),
        "claude" => Some(FAST_CLAUDE_MODEL),
        _ => None,
    }
}

fn provider_health_key(config: &TranslationProviderConfig) -> String {
    format!("{}:{}", config.provider_name, config.model_name)
}

async fn provider_is_cooling_down(config: &TranslationProviderConfig) -> bool {
    let key = provider_health_key(config);
    PROVIDER_HEALTH
        .lock()
        .await
        .get(&key)
        .and_then(|health| health.cooldown_until)
        .is_some_and(|until| until > Instant::now())
}

async fn record_provider_success(config: &TranslationProviderConfig, first_word_ms: u64) {
    let key = provider_health_key(config);
    let mut health = PROVIDER_HEALTH.lock().await;
    let entry = health.entry(key).or_default();
    entry.consecutive_failures = 0;
    entry.cooldown_until = None;
    entry.average_first_word_ms = Some(match entry.average_first_word_ms {
        Some(previous) => ((previous as f64 * 0.7) + (first_word_ms as f64 * 0.3)) as u64,
        None => first_word_ms,
    });
}

async fn record_provider_failure(config: &TranslationProviderConfig) {
    let key = provider_health_key(config);
    let mut health = PROVIDER_HEALTH.lock().await;
    let entry = health.entry(key).or_default();
    entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
    if entry.consecutive_failures >= 2 {
        entry.cooldown_until = Some(Instant::now() + PROVIDER_COOLDOWN);
    }
}

async fn resolve_fast_cloud_candidate(
    pool: &SqlitePool,
    provider_name: &str,
    model_override: Option<&str>,
) -> Result<Option<TranslationProviderConfig>, String> {
    let Some(api_key) = SettingsRepository::get_api_key(pool, provider_name)
        .await
        .map_err(|error| format!("Failed to load {provider_name} API key: {error}"))?
        .filter(|key| !key.trim().is_empty())
    else {
        return Ok(None);
    };

    let provider = LLMProvider::from_str(provider_name)?;
    let model_name = model_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| fast_default_model(provider_name).map(str::to_string))
        .ok_or_else(|| format!("No fast translation model is configured for {provider_name}"))?;

    Ok(Some(TranslationProviderConfig {
        provider,
        provider_name: provider_name.to_string(),
        model_name,
        api_key,
        ollama_endpoint: None,
        custom_openai_endpoint: None,
        max_tokens: None,
        temperature: None,
        top_p: None,
    }))
}

fn push_unique_candidate(
    candidates: &mut Vec<TranslationProviderConfig>,
    candidate: TranslationProviderConfig,
) {
    if candidates.iter().any(|existing| {
        existing.provider_name == candidate.provider_name && existing.model_name == candidate.model_name
    }) {
        return;
    }
    candidates.push(candidate);
}

async fn resolve_provider_candidates(
    pool: &SqlitePool,
    translation_engine: Option<&str>,
    model_override: Option<&str>,
) -> Result<Vec<TranslationProviderConfig>, String> {
    let engine = translation_engine
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto")
        .to_ascii_lowercase();
    let mut candidates = Vec::new();

    if engine == "auto" {
        for provider in ["groq", "openai", "claude"] {
            if let Some(candidate) = resolve_fast_cloud_candidate(pool, provider, None).await? {
                push_unique_candidate(&mut candidates, candidate);
            }
        }
        if let Ok(current) = resolve_provider_config(pool).await {
            push_unique_candidate(&mut candidates, current);
        }
    } else if engine == "summary" {
        let mut current = resolve_provider_config(pool).await?;
        if let Some(model) = model_override.map(str::trim).filter(|value| !value.is_empty()) {
            current.model_name = model.to_string();
        }
        push_unique_candidate(&mut candidates, current);
    } else if ["groq", "openai", "claude"].contains(&engine.as_str()) {
        let requested = resolve_fast_cloud_candidate(pool, &engine, model_override)
            .await?
            .ok_or_else(|| format!("{engine} is selected for live translation but no API key is configured"))?;
        push_unique_candidate(&mut candidates, requested);
        if let Ok(current) = resolve_provider_config(pool).await {
            push_unique_candidate(&mut candidates, current);
        }
    } else {
        return Err(format!("Unsupported live translation engine: {engine}"));
    }

    if candidates.is_empty() {
        return Err("No live translation provider is configured. Add Groq/OpenAI/Claude credentials or configure a summary provider.".to_string());
    }
    Ok(candidates)
}

async fn warm_ollama_candidate(config: &TranslationProviderConfig) -> Result<(), String> {
    if config.provider != LLMProvider::Ollama {
        return Ok(());
    }
    let host = config
        .ollama_endpoint
        .clone()
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    TRANSLATION_HTTP_CLIENT
        .post(format!("{}/api/generate", host.trim_end_matches('/')))
        .json(&serde_json::json!({
            "model": config.model_name,
            "keep_alive": "10m",
            "stream": false
        }))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|error| format!("Failed to warm Ollama model: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Failed to warm Ollama model: {error}"))?;
    Ok(())
}

async fn translate_with_candidate<R: Runtime>(
    app: &AppHandle<R>,
    config: &TranslationProviderConfig,
    request_id: &str,
    text: &str,
    source: Option<LanguageSpec>,
    target: LanguageSpec,
    context_text: Option<&str>,
    glossary: Option<&str>,
    context_hint: Option<&str>,
    cancellation_token: &CancellationToken,
    budgets: TranslationBudgets,
) -> Result<(String, u64), String> {
    let worker_pool = if uses_local_translation_worker(&config.provider) {
        &*LOCAL_TRANSLATION_SEMAPHORE
    } else {
        &*CLOUD_TRANSLATION_SEMAPHORE
    };
    let _permit = tokio::select! {
        permit = worker_pool.acquire() => permit.map_err(|_| "Live translation worker pool is unavailable.".to_string())?,
        _ = cancellation_token.cancelled() => return Err("Live translation was cancelled.".to_string()),
    };

    let attempt_started = Instant::now();
    let (system_prompt, user_prompt) = build_translation_prompts(
        text,
        source,
        target,
        context_text,
        glossary,
        context_hint,
    );
    let app_data_dir = app.path().app_data_dir().ok();
    let max_tokens = Some(LIVE_TRANSLATION_MAX_TOKENS);
    let provider_name = config.provider_name.clone();
    let model_name = config.model_name.clone();
    let emit_request_id = request_id.to_string();
    let mut last_emit: Option<Instant> = None;
    let mut emit_text = |translated: &str, first_word_ms: u64| {
        if last_emit.is_some_and(|at| at.elapsed() < DELTA_EMIT_INTERVAL) {
            return;
        }
        last_emit = Some(Instant::now());
        let _ = app.emit(
            "live-translation-delta",
            serde_json::json!({
                "requestId": emit_request_id,
                "text": clean_translation_output(translated),
                "provider": provider_name,
                "model": model_name,
                "firstWordLatencyMs": first_word_ms,
            }),
        );
    };

    if config.provider == LLMProvider::BuiltInAI {
        let future = generate_summary(
            &TRANSLATION_HTTP_CLIENT,
            &config.provider,
            &config.model_name,
            &config.api_key,
            &system_prompt,
            &user_prompt,
            None,
            None,
            max_tokens,
            None,
            None,
            app_data_dir.as_ref(),
            None,
        );
        let result = timeout(budgets.first_word, future)
            .await
            .map_err(|_| format!("first translated word exceeded {}ms", budgets.first_word.as_millis()))??;
        let first = attempt_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        emit_text(&result, first);
        return Ok((result, first));
    }

    if config.provider == LLMProvider::OpenAICodex {
        let dir = app_data_dir.as_deref().ok_or_else(|| {
            "app_data_dir is required for OpenAI Codex provider".to_string()
        })?;
        let response = timeout(
            budgets.first_word,
            crate::openai_codex::open_codex_stream(
                &TRANSLATION_HTTP_CLIENT,
                dir,
                &config.model_name,
                &system_prompt,
                &user_prompt,
                max_tokens,
            ),
        )
        .await
        .map_err(|_| format!("first translated word exceeded {}ms", budgets.first_word.as_millis()))??;
        return stream_sse(
            response,
            codex_delta,
            &mut emit_text,
            attempt_started,
            budgets.first_word,
        )
        .await;
    }

    let request = build_chat_request(
        &TRANSLATION_HTTP_CLIENT,
        &config.provider,
        &config.model_name,
        &config.api_key,
        &system_prompt,
        &user_prompt,
        config.ollama_endpoint.as_deref(),
        config.custom_openai_endpoint.as_deref(),
        max_tokens,
        if config.provider == LLMProvider::CustomOpenAI {
            config.temperature.or(Some(0.1))
        } else {
            config.temperature
        },
        config.top_p,
        true,
    )?;
    let response = timeout(budgets.first_word, request.send())
        .await
        .map_err(|_| format!("first translated word exceeded {}ms", budgets.first_word.as_millis()))?
        .map_err(|error| format!("Failed to send translation request: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("translation provider returned {status}: {body}"));
    }
    let extract: fn(&Value) -> Result<Option<String>, String> = if config.provider == LLMProvider::Claude {
        claude_delta
    } else {
        chat_delta
    };
    stream_sse(
        response,
        extract,
        &mut emit_text,
        attempt_started,
        budgets.first_word,
    )
    .await
}

''')

register_anchor = "async fn register_translation(request_id: &str) -> (u64, CancellationToken) {"
if "fn translation_budgets(" not in rust:
    if register_anchor not in rust:
        raise SystemExit("register_translation anchor missing")
    rust = rust.replace(register_anchor, helpers + register_anchor, 1)

command_pattern = r'#\[tauri::command\]\npub async fn api_warm_live_translation.*?\n#\[cfg\(test\)\]'
command_replacement = dedent(r'''
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranslationPreparation {
    pub provider: String,
    pub model: String,
    pub warmed: bool,
}

#[tauri::command]
pub async fn api_prepare_live_translation(
    state: tauri::State<'_, AppState>,
    translation_engine: Option<String>,
    speed_mode: Option<String>,
    model_override: Option<String>,
) -> Result<LiveTranslationPreparation, String> {
    let _ = translation_budgets(speed_mode.as_deref());
    let candidates = resolve_provider_candidates(
        state.db_manager.pool(),
        translation_engine.as_deref(),
        model_override.as_deref(),
    )
    .await?;
    let preferred = &candidates[0];
    let warmed = if preferred.provider == LLMProvider::Ollama {
        warm_ollama_candidate(preferred).await?;
        true
    } else {
        false
    };
    Ok(LiveTranslationPreparation {
        provider: preferred.provider_name.clone(),
        model: preferred.model_name.clone(),
        warmed,
    })
}

#[tauri::command]
pub async fn api_warm_live_translation(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let prepared = api_prepare_live_translation(state, Some("summary".to_string()), None, None).await?;
    Ok(prepared.warmed)
}

#[tauri::command]
pub async fn api_translate_live_text<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    request_id: String,
    text: String,
    source_language: Option<String>,
    target_language: String,
    translation_engine: Option<String>,
    speed_mode: Option<String>,
    model_override: Option<String>,
    context_text: Option<String>,
    glossary: Option<String>,
    context_hint: Option<String>,
) -> Result<LiveTranslationResponse, String> {
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() || request_id.chars().count() > 160 {
        return Err("Live translation request id is invalid.".to_string());
    }
    let text = text.trim();
    if text.chars().count() > MAX_LIVE_TEXT_CHARS {
        return Err(format!("Live translation segments are limited to {MAX_LIVE_TEXT_CHARS} characters."));
    }
    let target = resolve_language(&target_language)?;
    let source = resolve_source_language(source_language.as_deref())?;
    if text.is_empty() || source.is_some_and(|language| language.code == target.code) {
        return Ok(LiveTranslationResponse {
            request_id,
            translated_text: text.to_string(),
            source_language: source.map(|language| language.code.to_string()),
            target_language: target.code.to_string(),
            provider: "passthrough".to_string(),
            model: "none".to_string(),
            latency_ms: 0,
            first_word_latency_ms: 0,
            fallback_reason: None,
            cached: true,
        });
    }

    let budgets = translation_budgets(speed_mode.as_deref());
    let mut candidates = resolve_provider_candidates(
        state.db_manager.pool(),
        translation_engine.as_deref(),
        model_override.as_deref(),
    )
    .await?;
    if candidates.len() > 1 {
        let mut ready = Vec::new();
        let mut cooling = Vec::new();
        for candidate in candidates.drain(..) {
            if provider_is_cooling_down(&candidate).await {
                cooling.push(candidate);
            } else {
                ready.push(candidate);
            }
        }
        ready.extend(cooling);
        candidates = ready;
    }

    let (generation, cancellation_token) = register_translation(&request_id).await;
    let total_started = Instant::now();
    let mut last_error = None;
    let mut fallback_reason = None;

    for (index, config) in candidates.iter().enumerate() {
        if total_started.elapsed() >= budgets.total {
            last_error = Some(format!("live translation exceeded total {}ms latency budget", budgets.total.as_millis()));
            break;
        }

        let key = cache_key(
            &config.provider_name,
            &config.model_name,
            source,
            target,
            text,
            context_text.as_deref(),
            glossary.as_deref(),
            context_hint.as_deref(),
        );
        if let Some(translated_text) = TRANSLATION_CACHE.lock().await.get(&key) {
            cleanup_translation(&request_id, generation).await;
            return Ok(LiveTranslationResponse {
                request_id,
                translated_text,
                source_language: source.map(|language| language.code.to_string()),
                target_language: target.code.to_string(),
                provider: config.provider_name.clone(),
                model: config.model_name.clone(),
                latency_ms: 0,
                first_word_latency_ms: 0,
                fallback_reason,
                cached: true,
            });
        }

        let _ = app.emit(
            "live-translation-status",
            serde_json::json!({
                "requestId": request_id,
                "event": "started",
                "provider": config.provider_name,
                "model": config.model_name,
            }),
        );

        let remaining_total = budgets.total.saturating_sub(total_started.elapsed());
        let attempt_limit = budgets.attempt.min(remaining_total);
        let candidate_result = timeout(
            attempt_limit,
            translate_with_candidate(
                &app,
                config,
                &request_id,
                text,
                source,
                target,
                context_text.as_deref(),
                glossary.as_deref(),
                context_hint.as_deref(),
                &cancellation_token,
                budgets,
            ),
        )
        .await;

        let result = match candidate_result {
            Ok(result) => result,
            Err(_) => Err(format!(
                "{} / {} exceeded {}ms attempt budget",
                config.provider_name,
                config.model_name,
                attempt_limit.as_millis()
            )),
        };

        match result {
            Ok((raw, first_word_ms)) => {
                let translated_text = clean_translation_output(&raw);
                if translated_text.is_empty() {
                    record_provider_failure(config).await;
                    last_error = Some("translation model returned empty text".to_string());
                    continue;
                }
                record_provider_success(config, first_word_ms).await;
                TRANSLATION_CACHE.lock().await.insert(key, translated_text.clone());
                cleanup_translation(&request_id, generation).await;
                return Ok(LiveTranslationResponse {
                    request_id,
                    translated_text,
                    source_language: source.map(|language| language.code.to_string()),
                    target_language: target.code.to_string(),
                    provider: config.provider_name.clone(),
                    model: config.model_name.clone(),
                    latency_ms: total_started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    first_word_latency_ms: first_word_ms,
                    fallback_reason,
                    cached: false,
                });
            }
            Err(error) => {
                record_provider_failure(config).await;
                last_error = Some(error.clone());
                if let Some(next) = candidates.get(index + 1) {
                    fallback_reason = Some(format!(
                        "{} / {}: {}",
                        config.provider_name, config.model_name, error
                    ));
                    let _ = app.emit(
                        "live-translation-status",
                        serde_json::json!({
                            "requestId": request_id,
                            "event": "fallback",
                            "provider": config.provider_name,
                            "model": config.model_name,
                            "nextProvider": next.provider_name,
                            "nextModel": next.model_name,
                            "reason": error,
                        }),
                    );
                }
            }
        }
    }

    cleanup_translation(&request_id, generation).await;
    Err(last_error.unwrap_or_else(|| "All configured live translation providers failed.".to_string()))
}

#[cfg(test)]''')

rust = regex_once(rust, command_pattern, command_replacement, "translation commands")

if "fn instant_mode_has_tight_first_word_budget()" not in rust:
    test_anchor = "    #[test]\n    fn resolves_codes_and_names() {"
    tests = dedent('''\
        #[test]
        fn instant_mode_has_tight_first_word_budget() {
            let budget = translation_budgets(Some("instant"));
            assert_eq!(budget.first_word, Duration::from_millis(1800));
            assert_eq!(budget.total, Duration::from_secs(12));
        }

        #[test]
        fn fast_translation_models_are_not_summary_models() {
            assert_eq!(fast_default_model("groq"), Some(FAST_GROQ_MODEL));
            assert_eq!(fast_default_model("openai"), Some(FAST_OPENAI_MODEL));
            assert_eq!(fast_default_model("claude"), Some(FAST_CLAUDE_MODEL));
        }

    ''')
    if test_anchor not in rust:
        raise SystemExit("translation test anchor missing")
    rust = rust.replace(test_anchor, tests + test_anchor, 1)

rust_path.write_text(rust)

lib_path = Path("frontend/src-tauri/src/lib.rs")
lib = lib_path.read_text()
anchor = "            live_translation::api_warm_live_translation,\n"
addition = anchor + "            live_translation::api_prepare_live_translation,\n"
if "live_translation::api_prepare_live_translation" not in lib:
    if anchor not in lib:
        raise SystemExit("lib.rs command anchor missing")
    lib = lib.replace(anchor, addition, 1)
lib_path.write_text(lib)


# ---------------------------------------------------------------------------
# Frontend settings and scheduler
# ---------------------------------------------------------------------------
Path("frontend/src/lib/live-translation.ts").write_text(dedent(r'''\
export type TranslationDisplayMode = 'bilingual' | 'translated';
export type LiveTranslationStatus = 'queued' | 'translating' | 'translated' | 'error';
export type LiveTranslationSpeed = 'instant' | 'balanced' | 'accurate';
export type LiveTranslationEngine = 'auto' | 'summary' | 'groq' | 'openai' | 'claude';

export interface LiveTranslationLanguage {
  code: string;
  name: string;
  nativeName: string;
}

export interface LiveTranslationSettings {
  enabled: boolean;
  sourceLanguage: 'auto';
  targetLanguage: string;
  displayMode: TranslationDisplayMode;
  speed: LiveTranslationSpeed;
  engine: LiveTranslationEngine;
  contextTurns: 0 | 2 | 4;
  modelOverride: string;
  glossary: string;
  contextHint: string;
}

export interface LiveTranslationEntry {
  segmentKey: string;
  sourceText: string;
  translatedText?: string;
  targetLanguage: string;
  status: LiveTranslationStatus;
  error?: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
  firstWordLatencyMs?: number;
  fallbackReason?: string;
  cached?: boolean;
}

export interface LiveTranslationResponse {
  requestId: string;
  translatedText: string;
  sourceLanguage?: string | null;
  targetLanguage: string;
  provider: string;
  model: string;
  latencyMs: number;
  firstWordLatencyMs: number;
  fallbackReason?: string | null;
  cached: boolean;
}

export const LIVE_TRANSLATION_LANGUAGES: LiveTranslationLanguage[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
];

export const DEFAULT_LIVE_TRANSLATION_SETTINGS: LiveTranslationSettings = {
  enabled: false,
  sourceLanguage: 'auto',
  targetLanguage: 'en',
  displayMode: 'bilingual',
  speed: 'instant',
  engine: 'auto',
  contextTurns: 2,
  modelOverride: '',
  glossary: '',
  contextHint: '',
};

export const LIVE_TRANSLATION_STORAGE_KEY = 'meetodds.liveTranslation.v2';
const LEGACY_STORAGE_KEY = 'meetodds.liveTranslation.v1';

export function getLiveTranslationLanguage(code: string): LiveTranslationLanguage | undefined {
  return LIVE_TRANSLATION_LANGUAGES.find((language) => language.code === code);
}

export function loadLiveTranslationSettings(): LiveTranslationSettings {
  if (typeof window === 'undefined') return DEFAULT_LIVE_TRANSLATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(LIVE_TRANSLATION_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return DEFAULT_LIVE_TRANSLATION_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<LiveTranslationSettings>;
    const supportedTarget = LIVE_TRANSLATION_LANGUAGES.some(
      (language) => language.code === parsed.targetLanguage
    );
    const speed: LiveTranslationSpeed = ['instant', 'balanced', 'accurate'].includes(parsed.speed ?? '')
      ? parsed.speed as LiveTranslationSpeed
      : 'instant';
    const engine: LiveTranslationEngine = ['auto', 'summary', 'groq', 'openai', 'claude'].includes(parsed.engine ?? '')
      ? parsed.engine as LiveTranslationEngine
      : 'auto';
    const contextTurns: 0 | 2 | 4 = parsed.contextTurns === 0 || parsed.contextTurns === 4 ? parsed.contextTurns : 2;
    return {
      enabled: parsed.enabled === true,
      sourceLanguage: 'auto',
      targetLanguage: supportedTarget ? parsed.targetLanguage! : 'en',
      displayMode: parsed.displayMode === 'translated' ? 'translated' : 'bilingual',
      speed,
      engine,
      contextTurns,
      modelOverride: typeof parsed.modelOverride === 'string' ? parsed.modelOverride : '',
      glossary: typeof parsed.glossary === 'string' ? parsed.glossary : '',
      contextHint: typeof parsed.contextHint === 'string' ? parsed.contextHint : '',
    };
  } catch {
    return DEFAULT_LIVE_TRANSLATION_SETTINGS;
  }
}

export function saveLiveTranslationSettings(settings: LiveTranslationSettings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LIVE_TRANSLATION_STORAGE_KEY, JSON.stringify(settings));
}

export function liveTranslationSegmentKey(segment: { id: string; sequence_id?: number }): string {
  return segment.sequence_id === undefined ? segment.id : `sequence-${segment.sequence_id}`;
}
'''))

Path("frontend/src/hooks/useLiveTranslation.ts").write_text(dedent(r'''\
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Transcript } from '@/types';
import {
  DEFAULT_LIVE_TRANSLATION_SETTINGS,
  LiveTranslationEntry,
  LiveTranslationResponse,
  LiveTranslationSettings,
  liveTranslationSegmentKey,
  loadLiveTranslationSettings,
  saveLiveTranslationSettings,
} from '@/lib/live-translation';

const MAX_CONCURRENT_TRANSLATIONS = 2;
const MAX_QUEUED_TRANSLATIONS = 24;
const BACKFILL_SEGMENT_LIMIT = 3;
const RESULT_CACHE_LIMIT = 200;

interface TranslationJob {
  segmentKey: string;
  text: string;
  revision: string;
  requestId: string;
  sourceLanguage: 'auto';
  targetLanguage: string;
  generation: number;
  translationEngine: LiveTranslationSettings['engine'];
  speedMode: LiveTranslationSettings['speed'];
  modelOverride: string;
  contextText: string;
  glossary: string;
  contextHint: string;
}

interface LiveTranslationState {
  settings: LiveTranslationSettings;
  translations: Record<string, LiveTranslationEntry>;
  updateSettings: (update: Partial<LiveTranslationSettings>) => void;
  clearTranslations: () => void;
  queuedCount: number;
  activeCount: number;
  translatedCount: number;
  lastError: string | null;
  lastProvider: string | null;
  lastModel: string | null;
  lastLatencyMs: number | null;
  lastFirstWordLatencyMs: number | null;
  lastFallbackReason: string | null;
}

function cacheKey(job: TranslationJob): string {
  return [
    job.sourceLanguage,
    job.targetLanguage,
    job.translationEngine,
    job.modelOverride,
    job.contextText,
    job.glossary,
    job.contextHint,
    job.text,
  ].join('\u0000');
}

function trimCache(cache: Map<string, LiveTranslationResponse>): void {
  while (cache.size > RESULT_CACHE_LIMIT) {
    const firstKey = cache.keys().next().value as string | undefined;
    if (!firstKey) return;
    cache.delete(firstKey);
  }
}

function speakerLabel(transcript: Transcript): string {
  return transcript.speaker_label || transcript.speaker || 'Speaker';
}

function contextForTurn(transcripts: Transcript[], index: number, turns: 0 | 2 | 4): string {
  if (turns === 0 || index <= 0) return '';
  return transcripts
    .slice(Math.max(0, index - turns), index)
    .map((turn) => `${speakerLabel(turn)}: ${turn.text.trim()}`)
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

export function useLiveTranslation(transcripts: Transcript[]): LiveTranslationState {
  const [settings, setSettings] = useState<LiveTranslationSettings>(DEFAULT_LIVE_TRANSLATION_SETTINGS);
  const [translations, setTranslations] = useState<Record<string, LiveTranslationEntry>>({});
  const [queuedCount, setQueuedCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [lastModel, setLastModel] = useState<string | null>(null);
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const [lastFirstWordLatencyMs, setLastFirstWordLatencyMs] = useState<number | null>(null);
  const [lastFallbackReason, setLastFallbackReason] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const queueRef = useRef<TranslationJob[]>([]);
  const activeCountRef = useRef(0);
  const generationRef = useRef(0);
  const requestCounterRef = useRef(0);
  const latestRevisionRef = useRef(new Map<string, string>());
  const activeRequestIdsRef = useRef(new Map<string, string>());
  const activeJobsRef = useRef(new Map<string, TranslationJob>());
  const resultCacheRef = useRef(new Map<string, LiveTranslationResponse>());
  const drainQueueRef = useRef<() => void>(() => undefined);

  const updateCounts = useCallback(() => {
    if (!mountedRef.current) return;
    setQueuedCount(queueRef.current.length);
    setActiveCount(activeCountRef.current);
  }, []);

  const isCurrentJob = useCallback((job: TranslationJob): boolean => (
    mountedRef.current
    && job.generation === generationRef.current
    && latestRevisionRef.current.get(job.segmentKey) === job.revision
  ), []);

  const cancelNativeRequest = useCallback((requestId: string | undefined) => {
    if (!requestId) return;
    void invoke<boolean>('api_cancel_live_translation', { requestId }).catch(() => undefined);
  }, []);

  const drainQueue = useCallback(() => {
    while (activeCountRef.current < MAX_CONCURRENT_TRANSLATIONS && queueRef.current.length > 0) {
      const job = queueRef.current.shift()!;
      if (!isCurrentJob(job)) continue;
      activeCountRef.current += 1;
      activeRequestIdsRef.current.set(job.segmentKey, job.requestId);
      activeJobsRef.current.set(job.requestId, job);
      updateCounts();
      setTranslations((previous) => ({
        ...previous,
        [job.segmentKey]: {
          segmentKey: job.segmentKey,
          sourceText: job.text,
          targetLanguage: job.targetLanguage,
          status: 'translating',
        },
      }));

      void (async () => {
        try {
          const key = cacheKey(job);
          const cached = resultCacheRef.current.get(key);
          const response = cached ?? await invoke<LiveTranslationResponse>('api_translate_live_text', {
            requestId: job.requestId,
            text: job.text,
            sourceLanguage: job.sourceLanguage,
            targetLanguage: job.targetLanguage,
            translationEngine: job.translationEngine,
            speedMode: job.speedMode,
            modelOverride: job.modelOverride || null,
            contextText: job.contextText || null,
            glossary: job.glossary || null,
            contextHint: job.contextHint || null,
          });
          if (!cached) {
            resultCacheRef.current.set(key, response);
            trimCache(resultCacheRef.current);
          }
          if (!isCurrentJob(job)) return;
          const totalLatency = cached ? 0 : response.latencyMs;
          const firstWordLatency = cached ? 0 : response.firstWordLatencyMs;
          setTranslations((previous) => ({
            ...previous,
            [job.segmentKey]: {
              segmentKey: job.segmentKey,
              sourceText: job.text,
              translatedText: response.translatedText,
              targetLanguage: response.targetLanguage,
              status: 'translated',
              provider: response.provider,
              model: response.model,
              latencyMs: totalLatency,
              firstWordLatencyMs: firstWordLatency,
              fallbackReason: response.fallbackReason ?? undefined,
              cached: response.cached || Boolean(cached),
            },
          }));
          setLastError(null);
          setLastProvider(response.provider);
          setLastModel(response.model);
          setLastLatencyMs(totalLatency);
          setLastFirstWordLatencyMs(firstWordLatency);
          setLastFallbackReason(response.fallbackReason ?? null);
        } catch (error) {
          if (!isCurrentJob(job)) return;
          const message = error instanceof Error ? error.message : String(error);
          if (/cancelled/i.test(message)) return;
          setTranslations((previous) => ({
            ...previous,
            [job.segmentKey]: {
              ...(previous[job.segmentKey] ?? {}),
              segmentKey: job.segmentKey,
              sourceText: job.text,
              targetLanguage: job.targetLanguage,
              status: 'error',
              error: message,
            },
          }));
          setLastError(message);
        } finally {
          activeJobsRef.current.delete(job.requestId);
          if (activeRequestIdsRef.current.get(job.segmentKey) === job.requestId) {
            activeRequestIdsRef.current.delete(job.segmentKey);
          }
          activeCountRef.current = Math.max(0, activeCountRef.current - 1);
          updateCounts();
          queueMicrotask(() => drainQueueRef.current());
        }
      })();
    }
    updateCounts();
  }, [isCurrentJob, updateCounts]);

  drainQueueRef.current = drainQueue;

  const enqueueJob = useCallback((job: TranslationJob) => {
    if (!isCurrentJob(job)) return;
    queueRef.current = queueRef.current.filter((queued) => queued.segmentKey !== job.segmentKey);
    if (queueRef.current.length >= MAX_QUEUED_TRANSLATIONS) queueRef.current.pop();
    queueRef.current.unshift(job);
    updateCounts();
    queueMicrotask(() => drainQueueRef.current());
  }, [isCurrentJob, updateCounts]);

  const clearPendingWork = useCallback(() => {
    generationRef.current += 1;
    queueRef.current = [];
    for (const requestId of activeRequestIdsRef.current.values()) cancelNativeRequest(requestId);
    activeRequestIdsRef.current.clear();
    activeJobsRef.current.clear();
    latestRevisionRef.current.clear();
    updateCounts();
  }, [cancelNativeRequest, updateCounts]);

  const clearTranslations = useCallback(() => {
    clearPendingWork();
    setTranslations({});
    setLastError(null);
    setLastLatencyMs(null);
    setLastFirstWordLatencyMs(null);
    setLastFallbackReason(null);
  }, [clearPendingWork]);

  const updateSettings = useCallback((update: Partial<LiveTranslationSettings>) => {
    setSettings((previous) => {
      const next = { ...previous, ...update, sourceLanguage: 'auto' as const };
      saveLiveTranslationSettings(next);
      return next;
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let disposeDelta: (() => void) | undefined;
    let disposeStatus: (() => void) | undefined;
    void listen<{ requestId: string; text: string; provider?: string; model?: string; firstWordLatencyMs?: number }>(
      'live-translation-delta',
      (event) => {
        const job = activeJobsRef.current.get(event.payload.requestId);
        if (!job || !isCurrentJob(job)) return;
        setTranslations((previous) => ({
          ...previous,
          [job.segmentKey]: {
            ...(previous[job.segmentKey] ?? {}),
            segmentKey: job.segmentKey,
            sourceText: job.text,
            targetLanguage: job.targetLanguage,
            status: 'translating',
            translatedText: event.payload.text,
            provider: event.payload.provider,
            model: event.payload.model,
            firstWordLatencyMs: event.payload.firstWordLatencyMs,
          },
        }));
        if (event.payload.provider) setLastProvider(event.payload.provider);
        if (event.payload.model) setLastModel(event.payload.model);
        if (event.payload.firstWordLatencyMs !== undefined) setLastFirstWordLatencyMs(event.payload.firstWordLatencyMs);
      }
    ).then((dispose) => disposed ? dispose() : (disposeDelta = dispose));

    void listen<{
      requestId: string;
      event: 'started' | 'fallback';
      provider?: string;
      model?: string;
      reason?: string;
      nextProvider?: string;
      nextModel?: string;
    }>('live-translation-status', (event) => {
      const job = activeJobsRef.current.get(event.payload.requestId);
      if (!job || !isCurrentJob(job)) return;
      if (event.payload.event === 'started') {
        if (event.payload.provider) setLastProvider(event.payload.provider);
        if (event.payload.model) setLastModel(event.payload.model);
        return;
      }
      const reason = event.payload.reason ?? 'Provider was too slow or unavailable';
      setLastFallbackReason(reason);
      setTranslations((previous) => ({
        ...previous,
        [job.segmentKey]: {
          ...(previous[job.segmentKey] ?? {}),
          segmentKey: job.segmentKey,
          sourceText: job.text,
          targetLanguage: job.targetLanguage,
          status: 'translating',
          translatedText: undefined,
          fallbackReason: reason,
          provider: event.payload.nextProvider,
          model: event.payload.nextModel,
        },
      }));
    }).then((dispose) => disposed ? dispose() : (disposeStatus = dispose));

    return () => {
      disposed = true;
      disposeDelta?.();
      disposeStatus?.();
    };
  }, [isCurrentJob]);

  useEffect(() => {
    mountedRef.current = true;
    setSettings(loadLiveTranslationSettings());
    return () => {
      mountedRef.current = false;
      clearPendingWork();
    };
  }, [clearPendingWork]);

  useEffect(() => {
    clearPendingWork();
    setTranslations({});
    setLastError(null);
    if (settings.enabled) {
      void invoke('api_prepare_live_translation', {
        translationEngine: settings.engine,
        speedMode: settings.speed,
        modelOverride: settings.modelOverride || null,
      }).catch(() => undefined);
    }
  }, [
    settings.enabled,
    settings.sourceLanguage,
    settings.targetLanguage,
    settings.engine,
    settings.speed,
    settings.modelOverride,
    settings.contextTurns,
    settings.glossary,
    settings.contextHint,
    clearPendingWork,
  ]);

  useEffect(() => {
    if (!settings.enabled || transcripts.length === 0) return;
    const start = Math.max(0, transcripts.length - BACKFILL_SEGMENT_LIMIT);
    const candidates = transcripts.slice(start);
    candidates.forEach((transcript, offset) => {
      const text = transcript.text.trim();
      if (!text) return;
      const index = start + offset;
      const segmentKey = liveTranslationSegmentKey(transcript);
      const contextText = contextForTurn(transcripts, index, settings.contextTurns);
      const revision = [
        generationRef.current,
        settings.targetLanguage,
        settings.engine,
        settings.speed,
        settings.modelOverride,
        settings.contextTurns,
        settings.glossary,
        settings.contextHint,
        contextText,
        text,
      ].join('\u0001');
      if (latestRevisionRef.current.get(segmentKey) === revision) return;
      latestRevisionRef.current.set(segmentKey, revision);
      const activeRequestId = activeRequestIdsRef.current.get(segmentKey);
      if (activeRequestId) cancelNativeRequest(activeRequestId);
      enqueueJob({
        segmentKey,
        text,
        revision,
        requestId: `live-v2-${Date.now()}-${requestCounterRef.current++}`,
        sourceLanguage: 'auto',
        targetLanguage: settings.targetLanguage,
        generation: generationRef.current,
        translationEngine: settings.engine,
        speedMode: settings.speed,
        modelOverride: settings.modelOverride,
        contextText,
        glossary: settings.glossary,
        contextHint: settings.contextHint,
      });
    });
  }, [transcripts, settings, cancelNativeRequest, enqueueJob]);

  const translatedCount = useMemo(
    () => Object.values(translations).filter((entry) => entry.status === 'translated').length,
    [translations]
  );

  return {
    settings,
    translations,
    updateSettings,
    clearTranslations,
    queuedCount,
    activeCount,
    translatedCount,
    lastError,
    lastProvider,
    lastModel,
    lastLatencyMs,
    lastFirstWordLatencyMs,
    lastFallbackReason,
  };
}
'''))


# ---------------------------------------------------------------------------
# Controls + view wiring
# ---------------------------------------------------------------------------
Path("frontend/src/components/LiveTranslationControl.tsx").write_text(dedent(r'''\
'use client';

import { Languages, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  getLiveTranslationLanguage,
  LIVE_TRANSLATION_LANGUAGES,
  LiveTranslationSettings,
} from '@/lib/live-translation';

interface LiveTranslationControlProps {
  settings: LiveTranslationSettings;
  updateSettings: (update: Partial<LiveTranslationSettings>) => void;
  clearTranslations: () => void;
  queuedCount: number;
  activeCount: number;
  translatedCount: number;
  lastError: string | null;
  lastProvider: string | null;
  lastModel: string | null;
  lastLatencyMs: number | null;
  lastFirstWordLatencyMs: number | null;
  lastFallbackReason: string | null;
}

export function LiveTranslationControl({
  settings,
  updateSettings,
  clearTranslations,
  queuedCount,
  activeCount,
  translatedCount,
  lastError,
  lastProvider,
  lastModel,
  lastLatencyMs,
  lastFirstWordLatencyMs,
  lastFallbackReason,
}: LiveTranslationControlProps) {
  const target = getLiveTranslationLanguage(settings.targetLanguage);
  const isWorking = activeCount > 0 || queuedCount > 0;
  const slowerCompatibilityPath = ['openai-codex', 'ollama', 'builtin-ai'].includes(lastProvider ?? '');

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={settings.enabled ? 'secondary' : 'outline'}
          size="sm"
          title="Live translation"
          aria-label={`Live translation${settings.enabled && target ? ` to ${target.name}` : ''}`}
        >
          {isWorking ? <Loader2 className="animate-spin" /> : <Languages />}
          <span className="hidden md:inline">{settings.enabled && target ? target.name : 'Translate'}</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-96" align="center">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h4 className="font-semibold">Live translation · V2</h4>
              <p className="mt-1 text-xs text-muted-foreground">
                Streams translated words immediately and fails over when a provider misses its first-word latency budget.
              </p>
            </div>
            <Switch checked={settings.enabled} onCheckedChange={(enabled) => updateSettings({ enabled })} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Speed</Label>
              <Select value={settings.speed} onValueChange={(speed: 'instant' | 'balanced' | 'accurate') => updateSettings({ speed })} disabled={!settings.enabled}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="instant">Instant</SelectItem>
                  <SelectItem value="balanced">Balanced</SelectItem>
                  <SelectItem value="accurate">Accurate</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Translation engine</Label>
              <Select value={settings.engine} onValueChange={(engine: 'auto' | 'summary' | 'groq' | 'openai' | 'claude') => updateSettings({ engine })} disabled={!settings.enabled}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto · fastest configured</SelectItem>
                  <SelectItem value="groq">Groq · instant</SelectItem>
                  <SelectItem value="openai">OpenAI · fast</SelectItem>
                  <SelectItem value="claude">Claude · Haiku</SelectItem>
                  <SelectItem value="summary">Current summary provider</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Translate to</Label>
            <Select value={settings.targetLanguage} onValueChange={(targetLanguage) => updateSettings({ targetLanguage })} disabled={!settings.enabled}>
              <SelectTrigger><SelectValue placeholder="Choose a language" /></SelectTrigger>
              <SelectContent className="max-h-72">
                {LIVE_TRANSLATION_LANGUAGES.map((language) => (
                  <SelectItem key={language.code} value={language.code}>
                    {language.name} · {language.nativeName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Context</Label>
              <Select value={String(settings.contextTurns)} onValueChange={(value) => updateSettings({ contextTurns: Number(value) as 0 | 2 | 4 })} disabled={!settings.enabled}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Current turn only</SelectItem>
                  <SelectItem value="2">2 prior turns</SelectItem>
                  <SelectItem value="4">4 prior turns</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Display</Label>
              <Select value={settings.displayMode} onValueChange={(displayMode: 'bilingual' | 'translated') => updateSettings({ displayMode })} disabled={!settings.enabled}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bilingual">Original + translation</SelectItem>
                  <SelectItem value="translated">Translation only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <details className="rounded-md border p-3 text-xs">
            <summary className="cursor-pointer font-medium">Accuracy hints & advanced model</summary>
            <div className="mt-3 space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Keywords / names</Label>
                <Input value={settings.glossary} onChange={(event) => updateSettings({ glossary: event.target.value })} placeholder="N26, MeetOdds, EBITDA, Mayur" disabled={!settings.enabled} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Meeting context</Label>
                <Input value={settings.contextHint} onChange={(event) => updateSettings({ contextHint: event.target.value })} placeholder="Product review for a fintech team" disabled={!settings.enabled} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Model override</Label>
                <Input value={settings.modelOverride} onChange={(event) => updateSettings({ modelOverride: event.target.value })} placeholder="Leave blank for translation-optimized default" disabled={!settings.enabled || settings.engine === 'auto'} />
              </div>
            </div>
          </details>

          {settings.enabled && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">
                  {isWorking ? `${activeCount} translating · ${queuedCount} queued` : translatedCount > 0 ? `${translatedCount} turns translated` : 'Ready for the next speech turn'}
                </span>
                <div className="text-right text-muted-foreground">
                  {lastFirstWordLatencyMs !== null && <div>first word {(lastFirstWordLatencyMs / 1000).toFixed(1)}s</div>}
                  {lastLatencyMs !== null && <div>{lastLatencyMs === 0 ? 'cached' : `complete ${(lastLatencyMs / 1000).toFixed(1)}s`}</div>}
                </div>
              </div>
              {lastProvider && <p className="mt-1 truncate text-muted-foreground">{lastProvider}{lastModel ? ` / ${lastModel}` : ''}</p>}
              {lastFallbackReason && <p className="mt-2 line-clamp-2 text-amber-700">Fallback: {lastFallbackReason}</p>}
              {slowerCompatibilityPath && <p className="mt-2 text-amber-700">This is a compatibility path. Auto with Groq/OpenAI/Claude is usually faster for live captions.</p>}
              {lastError && <p className="mt-2 line-clamp-3 text-destructive">{lastError}</p>}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Auto uses a dedicated fast translation model instead of the larger meeting-summary model. Cloud providers receive only transcript text and the small context window above.
            </p>
            <Button type="button" variant="ghost" size="icon" onClick={clearTranslations} disabled={translatedCount === 0 && !isWorking} title="Clear live translations">
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
'''))

panel_path = Path("frontend/src/app/_components/TranscriptPanel.tsx")
panel = panel_path.read_text()
panel = replace_once(
    panel,
    "                  lastModel={liveTranslation.lastModel}\n                  lastLatencyMs={liveTranslation.lastLatencyMs}\n                />",
    "                  lastModel={liveTranslation.lastModel}\n                  lastLatencyMs={liveTranslation.lastLatencyMs}\n                  lastFirstWordLatencyMs={liveTranslation.lastFirstWordLatencyMs}\n                  lastFallbackReason={liveTranslation.lastFallbackReason}\n                />",
    "translation control diagnostics props",
)
panel_path.write_text(panel)

view_path = Path("frontend/src/components/VirtualizedTranscriptView.tsx")
view = view_path.read_text()
view = replace_once(
    view,
    "                                {translatedText}\n                            </p>",
    "                                {translatedText}\n                                {translationStatus === 'translating' && (\n                                    <span className=\"ml-0.5 animate-pulse text-gray-400\">▍</span>\n                                )}\n                            </p>",
    "translation streaming caret",
)
view_path.write_text(view)


# ---------------------------------------------------------------------------
# Architecture notes
# ---------------------------------------------------------------------------
Path("docs/LIVE_TRANSLATION_V2.md").write_text(dedent('''\
# MeetOdds Live Translation V2

## Why V1 felt slow

V1 fixed full-response blocking by streaming tokens, but it still inherited the meeting-summary provider and model. A large reasoning/coding model can have a slow time-to-first-token even when its eventual translation is good. Live interpretation cares more about **time to first translated words** than total completion time.

Transync AI's public materials describe a different product shape: dedicated real-time translation models, continuously updating captions, an average claimed delay below 0.5 seconds, and optional keywords/context for terminology. Its proprietary implementation is not public, so MeetOdds V2 adopts those observable design principles rather than claiming to reproduce private internals.

## V2 architecture

```text
local/system audio
      |
      v
MeetOdds ASR (canonical transcript)
      | immediately
      +--------------> original caption
      |
      v
newest-turn scheduler (3-turn live window)
      |
      +-- small conversational context (0/2/4 prior turns)
      +-- user glossary + meeting hint
      v
adaptive translation router
      |
      +-- Groq / llama-3.1-8b-instant
      +-- OpenAI / gpt-4o-mini
      +-- Claude / claude-haiku-4-5-20251001
      +-- configured summary provider as compatibility fallback
      |
      v
streamed SSE deltas ----------> translated caption
```

## Latency modes

| Mode | First-word budget | Provider attempt | Total fallback chain |
| --- | ---: | ---: | ---: |
| Instant | 1.8 s | 8 s | 12 s |
| Balanced | 3.2 s | 15 s | 22 s |
| Accurate | 10 s | 30 s | 32 s |

A provider that repeatedly misses the first-word budget is temporarily cooled down. The next configured fast provider is attempted automatically.

## Translation-specific routing

Summary quality and live-caption latency are different optimization problems. Auto mode therefore does **not** blindly use the summary model:

- Groq: `llama-3.1-8b-instant`
- OpenAI API: `gpt-4o-mini`
- Anthropic: `claude-haiku-4-5-20251001`
- Current summary provider: final fallback for compatibility, including ChatGPT/Codex, Ollama, Built-in AI, OpenRouter, and custom OpenAI endpoints.

Users can explicitly select Groq/OpenAI/Claude/current-summary-provider and optionally override the model.

## Context and terminology

The translator can receive up to four prior finalized turns as **reference only**. It is explicitly instructed to output only the current utterance. Speaker labels are included in the reference window. Users may also provide keywords/product names and a short meeting-context hint.

## Important remaining latency boundary

MeetOdds' canonical ASR still emits text after its speech segmentation/VAD boundary. Translation V2 can make the **text-to-translation** step much faster and can fail over quickly, but it cannot translate words that ASR has not emitted yet. Products that sustain sub-500ms translation during long uninterrupted speech typically use a streaming ASR or direct streaming audio-translation lane.

OpenAI now exposes `gpt-realtime-translate`, a dedicated streaming speech-to-speech model that returns translation transcript deltas while source audio is still arriving. A future optional cloud-realtime lane can bypass the VAD-finalization wait when an OpenAI API key is configured, while keeping the current local transcript as the canonical meeting record.

## Recommended setup

- Speed: **Instant**
- Engine: **Auto - fastest configured**
- Configure Groq or OpenAI API for the best caption latency
- Context: **2 prior turns**
- Add domain names/terms to Keywords when needed
- Display: Original + translation while evaluating quality

The ChatGPT subscription/Codex provider remains a useful no-extra-key compatibility fallback, but it is not treated as the preferred sub-second caption engine.
'''))

print("Recovered Live Translation V2 source files.")
