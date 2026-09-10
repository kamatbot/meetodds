use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;
use crate::summary::llm_client::{build_chat_request, generate_summary, LLMProvider};
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::{hash_map::DefaultHasher, HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{Mutex, Semaphore};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

const MAX_LIVE_TEXT_CHARS: usize = 6_000;
// A translation is roughly the input length; this only bounds runaway output.
const LIVE_TRANSLATION_MAX_TOKENS: u32 = 512;
const TRANSLATION_CACHE_CAPACITY: usize = 256;
// Coalesce streamed tokens so the UI re-renders at most ~25x/s per request.
const DELTA_EMIT_INTERVAL: Duration = Duration::from_millis(40);
const FAST_GROQ_MODEL: &str = "llama-3.1-8b-instant";
const FAST_OPENAI_MODEL: &str = "gpt-4o-mini";
const FAST_CLAUDE_MODEL: &str = "claude-haiku-4-5-20251001";
const PROVIDER_COOLDOWN: Duration = Duration::from_secs(20);

static CLOUD_TRANSLATION_SEMAPHORE: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(2));
static LOCAL_TRANSLATION_SEMAPHORE: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(1));
static TRANSLATION_HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_nodelay(true)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});
static ACTIVE_TRANSLATIONS: Lazy<Mutex<HashMap<String, ActiveTranslation>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_TRANSLATION_GENERATION: AtomicU64 = AtomicU64::new(1);
static TRANSLATION_CACHE: Lazy<Mutex<TranslationCache>> =
    Lazy::new(|| Mutex::new(TranslationCache::default()));
static PROVIDER_HEALTH: Lazy<Mutex<HashMap<String, ProviderHealth>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Copy)]
struct LanguageSpec {
    code: &'static str,
    name: &'static str,
}

const SUPPORTED_LANGUAGES: &[LanguageSpec] = &[
    LanguageSpec {
        code: "en",
        name: "English",
    },
    LanguageSpec {
        code: "es",
        name: "Spanish",
    },
    LanguageSpec {
        code: "fr",
        name: "French",
    },
    LanguageSpec {
        code: "de",
        name: "German",
    },
    LanguageSpec {
        code: "it",
        name: "Italian",
    },
    LanguageSpec {
        code: "pt",
        name: "Portuguese",
    },
    LanguageSpec {
        code: "nl",
        name: "Dutch",
    },
    LanguageSpec {
        code: "sv",
        name: "Swedish",
    },
    LanguageSpec {
        code: "no",
        name: "Norwegian",
    },
    LanguageSpec {
        code: "da",
        name: "Danish",
    },
    LanguageSpec {
        code: "fi",
        name: "Finnish",
    },
    LanguageSpec {
        code: "pl",
        name: "Polish",
    },
    LanguageSpec {
        code: "cs",
        name: "Czech",
    },
    LanguageSpec {
        code: "ro",
        name: "Romanian",
    },
    LanguageSpec {
        code: "hu",
        name: "Hungarian",
    },
    LanguageSpec {
        code: "tr",
        name: "Turkish",
    },
    LanguageSpec {
        code: "ru",
        name: "Russian",
    },
    LanguageSpec {
        code: "uk",
        name: "Ukrainian",
    },
    LanguageSpec {
        code: "ar",
        name: "Arabic",
    },
    LanguageSpec {
        code: "he",
        name: "Hebrew",
    },
    LanguageSpec {
        code: "hi",
        name: "Hindi",
    },
    LanguageSpec {
        code: "bn",
        name: "Bengali",
    },
    LanguageSpec {
        code: "ur",
        name: "Urdu",
    },
    LanguageSpec {
        code: "th",
        name: "Thai",
    },
    LanguageSpec {
        code: "vi",
        name: "Vietnamese",
    },
    LanguageSpec {
        code: "id",
        name: "Indonesian",
    },
    LanguageSpec {
        code: "ms",
        name: "Malay",
    },
    LanguageSpec {
        code: "zh-CN",
        name: "Chinese (Simplified)",
    },
    LanguageSpec {
        code: "zh-TW",
        name: "Chinese (Traditional)",
    },
    LanguageSpec {
        code: "ja",
        name: "Japanese",
    },
    LanguageSpec {
        code: "ko",
        name: "Korean",
    },
];

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
struct ActiveTranslation {
    generation: u64,
    token: CancellationToken,
}

#[derive(Debug, Default)]
struct TranslationCache {
    entries: HashMap<String, String>,
    order: VecDeque<String>,
}

impl TranslationCache {
    fn get(&self, key: &str) -> Option<String> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: String, value: String) {
        if self.entries.contains_key(&key) {
            self.entries.insert(key, value);
            return;
        }

        while self.entries.len() >= TRANSLATION_CACHE_CAPACITY {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.entries.remove(&oldest);
        }

        self.order.push_back(key.clone());
        self.entries.insert(key, value);
    }
}

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
}

#[derive(Clone)]
struct TranslationProviderConfig {
    provider: LLMProvider,
    provider_name: String,
    model_name: String,
    api_key: String,
    ollama_endpoint: Option<String>,
    custom_openai_endpoint: Option<String>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    top_p: Option<f32>,
}

fn normalize_language_key(value: &str) -> String {
    value.trim().replace('_', "-").to_lowercase()
}

fn resolve_language(value: &str) -> Result<LanguageSpec, String> {
    let key = normalize_language_key(value);
    SUPPORTED_LANGUAGES
        .iter()
        .copied()
        .find(|language| {
            normalize_language_key(language.code) == key
                || normalize_language_key(language.name) == key
        })
        .ok_or_else(|| format!("Unsupported live translation language: {value}"))
}

fn resolve_source_language(value: Option<&str>) -> Result<Option<LanguageSpec>, String> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some(value) if value.eq_ignore_ascii_case("auto") => Ok(None),
        Some(value) => resolve_language(value).map(Some),
    }
}

fn whatlang_to_app_language_code(lang: whatlang::Lang) -> Option<&'static str> {
    match lang {
        whatlang::Lang::Eng => Some("en"),
        whatlang::Lang::Spa => Some("es"),
        whatlang::Lang::Fra => Some("fr"),
        whatlang::Lang::Deu => Some("de"),
        whatlang::Lang::Ita => Some("it"),
        whatlang::Lang::Por => Some("pt"),
        whatlang::Lang::Nld => Some("nl"),
        whatlang::Lang::Swe => Some("sv"),
        whatlang::Lang::Nob => Some("no"),
        whatlang::Lang::Dan => Some("da"),
        whatlang::Lang::Fin => Some("fi"),
        whatlang::Lang::Pol => Some("pl"),
        whatlang::Lang::Ces => Some("cs"),
        whatlang::Lang::Ron => Some("ro"),
        whatlang::Lang::Hun => Some("hu"),
        whatlang::Lang::Tur => Some("tr"),
        whatlang::Lang::Rus => Some("ru"),
        whatlang::Lang::Ukr => Some("uk"),
        whatlang::Lang::Ara => Some("ar"),
        whatlang::Lang::Heb => Some("he"),
        whatlang::Lang::Hin => Some("hi"),
        whatlang::Lang::Ben => Some("bn"),
        whatlang::Lang::Urd => Some("ur"),
        whatlang::Lang::Tha => Some("th"),
        whatlang::Lang::Vie => Some("vi"),
        whatlang::Lang::Ind => Some("id"),
        whatlang::Lang::Cmn => Some("zh"),
        whatlang::Lang::Jpn => Some("ja"),
        whatlang::Lang::Kor => Some("ko"),
        _ => None,
    }
}

fn is_detected_language_matching_target(detected_code: &str, target_code: &str) -> bool {
    let norm_target = target_code.trim().to_ascii_lowercase();
    let norm_detected = detected_code.trim().to_ascii_lowercase();
    if norm_target == norm_detected {
        return true;
    }
    if norm_detected == "zh" && (norm_target == "zh-cn" || norm_target == "zh-tw") {
        return true;
    }
    if norm_target.starts_with(&norm_detected)
        && norm_target.as_bytes().get(norm_detected.len()) == Some(&b'-')
    {
        return true;
    }
    false
}

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
            "You are a simultaneous interpreter for a live business meeting. Translate from {source} to {}. \
Return ONLY the translation of the CURRENT UTTERANCE. Never repeat the reference context. \
Prefer natural spoken language over literal word-for-word phrasing. Preserve names, product terms, numbers, dates, URLs, and intent. \
Translate short turns such as Yes, No, Agreed, and interruptions; do not invent missing speech. \
If the current utterance is already in {}, return it unchanged.",
            target_language.name, target_language.name
    );

    if let Some(hint) = context_hint
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        system_prompt.push_str(
            "
Meeting context: ",
        );
        system_prompt.push_str(hint);
    }
    if let Some(terms) = glossary.map(str::trim).filter(|value| !value.is_empty()) {
        system_prompt.push_str(
            "
Terminology / names to preserve consistently: ",
        );
        system_prompt.push_str(terms);
    }
    if let Some(context) = context_text
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        system_prompt.push_str(
            "
Reference-only previous turns (DO NOT translate or output these):
",
        );
        system_prompt.push_str(context);
    }

    (system_prompt, text.to_string())
}

fn clean_translation_output(raw: &str) -> String {
    let mut output = raw.trim().to_string();

    if output.starts_with("```") {
        output = output.lines().skip(1).collect::<Vec<_>>().join("\n");
        if output.trim_end().ends_with("```") {
            let trimmed = output.trim_end();
            output = trimmed[..trimmed.len().saturating_sub(3)].to_string();
        }
    }

    for prefix in [
        "Translation:",
        "Translated text:",
        "Translated Text:",
        "Translated:",
        "Here is the translation:",
        "Here's the translation:",
    ] {
        if output.starts_with(prefix) {
            output = output[prefix.len()..].trim_start().to_string();
            break;
        }
    }

    let trimmed = output.trim();
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        let matching_quotes = (bytes[0] == b'\"' && bytes[bytes.len() - 1] == b'\"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'');
        if matching_quotes {
            return trimmed[1..trimmed.len() - 1].trim().to_string();
        }
    }

    trimmed.to_string()
}

/// Read a server-sent-event body while enforcing a time-to-first-text budget.
async fn stream_sse(
    response: reqwest::Response,
    mut extract: impl FnMut(&Value) -> Result<Option<String>, String>,
    mut on_text: impl FnMut(&str, u64),
    stream_started: Instant,
    first_word_budget: Duration,
    cancellation_token: &CancellationToken,
) -> Result<(String, u64), String> {
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut text = String::new();
    let mut first_word_ms: Option<u64> = None;
    let mut stream_connected = false;

    loop {
        let next_chunk = if first_word_ms.is_none() {
            let effective_budget = if stream_connected {
                first_word_budget + Duration::from_millis(1500)
            } else {
                first_word_budget
            };
            let Some(remaining) = effective_budget.checked_sub(stream_started.elapsed()) else {
                return Err(format!(
                    "first translated word exceeded {}ms after response headers",
                    effective_budget.as_millis()
                ));
            };
            tokio::select! {
                _ = cancellation_token.cancelled() => return Err("Live translation was cancelled.".to_string()),
                next = timeout(remaining, stream.next()) => next
                    .map_err(|_| format!("first translated word exceeded {}ms after response headers", effective_budget.as_millis()))?,
            }
        } else {
            tokio::select! {
                _ = cancellation_token.cancelled() => return Err("Live translation was cancelled.".to_string()),
                next = stream.next() => next,
            }
        };

        let Some(chunk) = next_chunk else { break };
        let chunk = chunk.map_err(|error| format!("Translation stream failed: {error}"))?;
        stream_connected = true;
        buffer.extend_from_slice(&chunk);
        while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=newline).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(delta) = extract(&event)? {
                if !delta.is_empty() {
                    text.push_str(&delta);
                    let first = *first_word_ms.get_or_insert_with(|| {
                        stream_started.elapsed().as_millis().min(u64::MAX as u128) as u64
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
        first_word_ms.unwrap_or_else(|| stream_started.elapsed().as_millis() as u64),
    ))
}

fn chat_delta(event: &Value) -> Result<Option<String>, String> {
    if let Some(message) = event.pointer("/error/message").and_then(Value::as_str) {
        return Err(message.to_string());
    }
    Ok(event
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
        .map(str::to_string))
}

fn claude_delta(event: &Value) -> Result<Option<String>, String> {
    match event.get("type").and_then(Value::as_str) {
        Some("error") => Err(event
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Claude stream error")
            .to_string()),
        Some("content_block_delta") => Ok(event
            .pointer("/delta/text")
            .and_then(Value::as_str)
            .map(str::to_string)),
        _ => Ok(None),
    }
}

fn codex_delta(event: &Value) -> Result<Option<String>, String> {
    match event.get("type").and_then(Value::as_str) {
        Some("error") | Some("response.failed") => Err(event
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| event.get("message").and_then(Value::as_str))
            .unwrap_or("ChatGPT/Codex returned an unknown error")
            .to_string()),
        Some("response.output_text.delta") => Ok(event
            .get("delta")
            .and_then(Value::as_str)
            .map(str::to_string)),
        _ => Ok(None),
    }
}

fn is_conversational_english(text: &str) -> bool {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() || words.len() > 14 {
        return false;
    }
    const COMMON_WORDS: &[&str] = &[
        "the", "be", "to", "of", "and", "a", "in", "that", "have", "i",
        "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
        "this", "but", "his", "by", "from", "they", "we", "say", "her", "she",
        "or", "an", "will", "my", "one", "all", "would", "there", "their", "what",
        "so", "up", "out", "if", "about", "who", "get", "which", "go", "me",
        "when", "make", "can", "like", "time", "no", "just", "him", "know", "take",
        "people", "into", "year", "your", "good", "some", "could", "them", "see", "other",
        "than", "then", "now", "look", "only", "come", "its", "over", "think", "also",
        "back", "after", "use", "two", "how", "our", "work", "first", "well", "way",
        "even", "new", "want", "because", "any", "these", "give", "day", "most", "us",
        "hello", "hi", "hey", "yes", "yeah", "ok", "okay", "sure", "thanks", "thank",
        "morning", "afternoon", "evening", "meeting", "call", "test", "testing", "hear",
        "right", "cool", "great", "nice", "fine", "sounds", "agenda", "update", "start",
        "project", "team", "notes", "screen", "share", "today", "tomorrow", "yesterday",
        "let's", "lets", "is", "are", "was", "were", "am", "been", "being",
    ];
    let matches = words.iter().filter(|w| COMMON_WORDS.contains(w)).count();
    matches * 2 >= words.len()
}

fn uses_local_translation_worker(provider: &LLMProvider) -> bool {
    matches!(provider, LLMProvider::Ollama | LLMProvider::BuiltInAI)
}

fn uses_extended_translation_budget(provider: &LLMProvider) -> bool {
    matches!(
        provider,
        LLMProvider::Ollama | LLMProvider::BuiltInAI | LLMProvider::OpenAICodex
    )
}

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
    source_language
        .map(|language| language.code)
        .hash(&mut hasher);
    target_language.code.hash(&mut hasher);
    text.hash(&mut hasher);
    context_text.unwrap_or_default().hash(&mut hasher);
    glossary.unwrap_or_default().hash(&mut hasher);
    context_hint.unwrap_or_default().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn translation_budgets(speed: Option<&str>) -> TranslationBudgets {
    match speed
        .unwrap_or("instant")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "accurate" => TranslationBudgets {
            first_word: Duration::from_secs(10),
            attempt: Duration::from_secs(30),
            total: Duration::from_secs(35),
        },
        "balanced" => TranslationBudgets {
            first_word: Duration::from_millis(4500),
            attempt: Duration::from_secs(16),
            total: Duration::from_secs(24),
        },
        _ => TranslationBudgets {
            first_word: Duration::from_millis(2800),
            attempt: Duration::from_secs(10),
            total: Duration::from_secs(15),
        },
    }
}

fn effective_budgets(base: TranslationBudgets, is_local: bool) -> TranslationBudgets {
    if is_local {
        TranslationBudgets {
            first_word: base.first_word.max(Duration::from_secs(12)),
            attempt: base.attempt.max(Duration::from_secs(25)),
            total: base.total.max(Duration::from_secs(30)),
        }
    } else {
        base
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

async fn clear_provider_health() {
    let mut health = PROVIDER_HEALTH.lock().await;
    health.clear();
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
    if entry.consecutive_failures >= 3 {
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

async fn resolve_openai_subscription_candidate(
    pool: &SqlitePool,
    model_override: Option<&str>,
) -> Result<TranslationProviderConfig, String> {
    let summary_setting = SettingsRepository::get_model_config(pool).await.ok().flatten();
    let model = model_override
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .or_else(|| {
            summary_setting
                .as_ref()
                .filter(|s| {
                    let p = s.provider.to_ascii_lowercase();
                    p == "openai-codex" || p == "chatgpt" || p == "codex" || p == "openai"
                })
                .map(|s| s.model.trim().to_string())
                .filter(|m| !m.is_empty())
        })
        .unwrap_or_else(|| "gpt-5.6-sol".to_string());

    Ok(TranslationProviderConfig {
        provider: LLMProvider::OpenAICodex,
        provider_name: "openai-codex".to_string(),
        model_name: model,
        api_key: String::new(),
        ollama_endpoint: None,
        custom_openai_endpoint: None,
        max_tokens: None,
        temperature: None,
        top_p: None,
    })
}

fn push_unique_candidate(
    candidates: &mut Vec<TranslationProviderConfig>,
    candidate: TranslationProviderConfig,
) {
    if candidates.iter().any(|existing| {
        existing.provider_name == candidate.provider_name
            && existing.model_name == candidate.model_name
    }) {
        return;
    }
    candidates.push(candidate);
}

fn validate_candidate_readiness(
    config: &TranslationProviderConfig,
    app_data_dir: Option<&Path>,
) -> Result<(), String> {
    match &config.provider {
        LLMProvider::BuiltInAI => {
            if let Some(dir) = app_data_dir {
                let dir_buf = dir.to_path_buf();
                let path_result =
                    crate::summary::summary_engine::models::get_model_path(&dir_buf, &config.model_name);
                let exists = match path_result {
                    Ok(ref p) => {
                        p.exists()
                            || dir.parent().map_or(false, |parent| {
                                parent
                                    .join("com.meetily.ai")
                                    .join("models")
                                    .join("summary")
                                    .join(p.file_name().unwrap_or_default())
                                    .exists()
                            })
                    }
                    Err(_) => false,
                };
                if !exists {
                    return Err(format!(
                        "Built-in AI model '{}' is not downloaded. Download it in Settings → AI Models.",
                        config.model_name
                    ));
                }
            }
            Ok(())
        }
        LLMProvider::OpenAICodex => {
            if let Some(dir) = app_data_dir {
                let auth_file = dir.join("openai-codex-auth.json");
                let legacy_auth = dir.parent().map_or(false, |parent| {
                    parent.join("com.meetily.ai").join("openai-codex-auth.json").exists()
                });
                if !auth_file.exists() && !legacy_auth {
                    return Err(
                        "ChatGPT / OpenAI Codex is not signed in. Sign in under Settings → Summary."
                            .to_string(),
                    );
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

async fn resolve_provider_candidates(
    pool: &SqlitePool,
    app_data_dir: Option<&Path>,
    translation_engine: Option<&str>,
    model_override: Option<&str>,
) -> Result<Vec<TranslationProviderConfig>, String> {
    let engine = translation_engine
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto")
        .to_ascii_lowercase();
    let mut candidates = Vec::new();
    let mut last_summary_err = None;

    if engine == "auto" {
        for provider in ["groq", "claude"] {
            if let Some(candidate) = resolve_fast_cloud_candidate(pool, provider, None).await? {
                push_unique_candidate(&mut candidates, candidate);
            }
        }
        if let Ok(codex_candidate) = resolve_openai_subscription_candidate(pool, None).await {
            if validate_candidate_readiness(&codex_candidate, app_data_dir).is_ok() {
                push_unique_candidate(&mut candidates, codex_candidate);
            } else if let Ok(Some(cloud_candidate)) = resolve_fast_cloud_candidate(pool, "openai", None).await {
                push_unique_candidate(&mut candidates, cloud_candidate);
            }
        }
        match resolve_provider_config(pool).await {
            Ok(current) => {
                if let Err(e) = validate_candidate_readiness(&current, app_data_dir) {
                    last_summary_err = Some(e);
                } else {
                    push_unique_candidate(&mut candidates, current);
                }
            }
            Err(e) => {
                last_summary_err = Some(e);
            }
        }
    } else if engine == "summary" {
        let mut current = resolve_provider_config(pool).await?;
        if let Some(model) = model_override
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            current.model_name = model.to_string();
        }
        validate_candidate_readiness(&current, app_data_dir)?;
        push_unique_candidate(&mut candidates, current);
    } else if engine == "builtin-ai" || engine == "local" {
        let model = model_override
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                crate::summary::summary_engine::commands::recommend_summary_model(
                    cfg!(target_os = "macos"),
                    16,
                )
                .to_string()
            });
        let candidate = TranslationProviderConfig {
            provider: LLMProvider::BuiltInAI,
            provider_name: "builtin-ai".to_string(),
            model_name: model,
            api_key: String::new(),
            ollama_endpoint: None,
            custom_openai_endpoint: None,
            max_tokens: None,
            temperature: None,
            top_p: None,
        };
        validate_candidate_readiness(&candidate, app_data_dir)?;
        push_unique_candidate(&mut candidates, candidate);
    } else if engine == "ollama" {
        let setting = SettingsRepository::get_model_config(pool).await.ok().flatten();
        let model = model_override
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                setting
                    .as_ref()
                    .map(|s| s.model.trim().to_string())
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| "llama3.2".to_string());
        let candidate = TranslationProviderConfig {
            provider: LLMProvider::Ollama,
            provider_name: "ollama".to_string(),
            model_name: model,
            api_key: String::new(),
            ollama_endpoint: setting.and_then(|s| s.ollama_endpoint),
            custom_openai_endpoint: None,
            max_tokens: None,
            temperature: None,
            top_p: None,
        };
        push_unique_candidate(&mut candidates, candidate);
    } else if ["openai", "openai-codex", "chatgpt"].contains(&engine.as_str()) {
        let codex_candidate = resolve_openai_subscription_candidate(pool, model_override).await?;
        if validate_candidate_readiness(&codex_candidate, app_data_dir).is_ok() {
            push_unique_candidate(&mut candidates, codex_candidate);
        } else if let Ok(Some(cloud_candidate)) =
            resolve_fast_cloud_candidate(pool, "openai", model_override).await
        {
            push_unique_candidate(&mut candidates, cloud_candidate);
        } else {
            // Neither OAuth subscription nor API key is available; validate readiness to return clear prompt to sign in
            validate_candidate_readiness(&codex_candidate, app_data_dir)?;
        }
        if let Ok(current) = resolve_provider_config(pool).await {
            if validate_candidate_readiness(&current, app_data_dir).is_ok() {
                push_unique_candidate(&mut candidates, current);
            }
        }
    } else if ["groq", "claude"].contains(&engine.as_str()) {
        let requested = resolve_fast_cloud_candidate(pool, &engine, model_override)
            .await?
            .ok_or_else(|| {
                format!("{engine} is selected for live translation but no API key is configured")
            })?;
        push_unique_candidate(&mut candidates, requested);
        if let Ok(current) = resolve_provider_config(pool).await {
            if validate_candidate_readiness(&current, app_data_dir).is_ok() {
                push_unique_candidate(&mut candidates, current);
            }
        }
    } else {
        return Err(format!("Unsupported live translation engine: {engine}"));
    }

    if candidates.is_empty() {
        if let Some(err) = last_summary_err {
            return Err(format!("No live translation provider is ready: {err}"));
        }
        return Err("No live translation provider is configured. Add Groq/OpenAI/Claude credentials, sign in with ChatGPT, or download a local model in Settings.".to_string());
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
    let (system_prompt, user_prompt) =
        build_translation_prompts(text, source, target, context_text, glossary, context_hint);
    let app_data_dir = app.path().app_data_dir().ok();
    let max_tokens = Some(
        config
            .max_tokens
            .map_or(LIVE_TRANSLATION_MAX_TOKENS, |value| {
                value.min(LIVE_TRANSLATION_MAX_TOKENS)
            }),
    );
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

    let connect_timeout = budgets.first_word.max(Duration::from_millis(3500));

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
        let result = timeout(budgets.attempt, future).await.map_err(|_| {
            format!(
                "translation exceeded {}ms attempt limit",
                budgets.attempt.as_millis()
            )
        })??;
        let first = attempt_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        emit_text(&result, first);
        return Ok((result, first));
    }

    if config.provider == LLMProvider::OpenAICodex {
        let dir = app_data_dir
            .as_deref()
            .ok_or_else(|| "app_data_dir is required for OpenAI Codex provider".to_string())?;
        let response = timeout(
            connect_timeout,
            crate::openai_codex::open_codex_stream(
                &TRANSLATION_HTTP_CLIENT,
                dir,
                &config.model_name,
                &system_prompt,
                &user_prompt,
                None,
            ),
        )
        .await
        .map_err(|_| {
            format!(
                "translation request connection timed out after {}ms",
                connect_timeout.as_millis()
            )
        })??;
        let stream_started = Instant::now();
        return stream_sse(
            response,
            codex_delta,
            &mut emit_text,
            stream_started,
            budgets.first_word,
            cancellation_token,
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
    let response = timeout(connect_timeout, request.send())
        .await
        .map_err(|_| {
            format!(
                "translation request connection timed out after {}ms",
                connect_timeout.as_millis()
            )
        })?
        .map_err(|error| format!("Failed to send translation request: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("translation provider returned {status}: {body}"));
    }
    let stream_started = Instant::now();
    let extract: fn(&Value) -> Result<Option<String>, String> =
        if config.provider == LLMProvider::Claude {
            claude_delta
        } else {
            chat_delta
        };
    stream_sse(
        response,
        extract,
        &mut emit_text,
        stream_started,
        budgets.first_word,
        cancellation_token,
    )
    .await
}

async fn register_translation(request_id: &str) -> (u64, CancellationToken) {
    let generation = NEXT_TRANSLATION_GENERATION.fetch_add(1, Ordering::Relaxed);
    let token = CancellationToken::new();
    let mut active = ACTIVE_TRANSLATIONS.lock().await;
    if let Some(previous) = active.insert(
        request_id.to_string(),
        ActiveTranslation {
            generation,
            token: token.clone(),
        },
    ) {
        previous.token.cancel();
    }
    (generation, token)
}

async fn cleanup_translation(request_id: &str, generation: u64) {
    let mut active = ACTIVE_TRANSLATIONS.lock().await;
    if active
        .get(request_id)
        .is_some_and(|entry| entry.generation == generation)
    {
        active.remove(request_id);
    }
}

async fn resolve_provider_config(pool: &SqlitePool) -> Result<TranslationProviderConfig, String> {
    let setting = SettingsRepository::get_model_config(pool)
        .await
        .map_err(|error| format!("Failed to load translation model settings: {error}"))?
        .ok_or_else(|| "No summary model is configured for live translation.".to_string())?;

    let provider = LLMProvider::from_str(&setting.provider)?;
    let mut model_name = setting.model.trim().to_string();
    let mut api_key = String::new();
    let mut custom_openai_endpoint = None;
    let mut max_tokens = None;
    let mut temperature = None;
    let mut top_p = None;

    match &provider {
        LLMProvider::Ollama | LLMProvider::BuiltInAI | LLMProvider::OpenAICodex => {}
        LLMProvider::CustomOpenAI => {
            let config = SettingsRepository::get_custom_openai_config(pool)
                .await
                .map_err(|error| format!("Failed to load custom translation model: {error}"))?
                .ok_or_else(|| "Custom OpenAI is selected but has no configuration.".to_string())?;
            model_name = config.model.trim().to_string();
            api_key = config.api_key.unwrap_or_default();
            custom_openai_endpoint = Some(config.endpoint);
            max_tokens = config
                .max_tokens
                .and_then(|value| u32::try_from(value).ok());
            temperature = config.temperature;
            top_p = config.top_p;
        }
        _ => {
            api_key = SettingsRepository::get_api_key(pool, &setting.provider)
                .await
                .map_err(|error| format!("Failed to load {} API key: {error}", setting.provider))?
                .filter(|key| !key.trim().is_empty())
                .ok_or_else(|| format!("API key not found for {}", setting.provider))?;
        }
    }

    if model_name.is_empty() {
        return Err("No model is selected for live translation.".to_string());
    }

    Ok(TranslationProviderConfig {
        provider,
        provider_name: setting.provider,
        model_name,
        api_key,
        ollama_endpoint: setting.ollama_endpoint,
        custom_openai_endpoint,
        max_tokens,
        temperature,
        top_p,
    })
}

#[tauri::command]
pub async fn api_cancel_live_translation(request_id: String) -> Result<bool, String> {
    let mut active = ACTIVE_TRANSLATIONS.lock().await;
    if let Some(entry) = active.remove(request_id.trim()) {
        entry.token.cancel();
        return Ok(true);
    }
    Ok(false)
}

/// Pre-load the local model so the first live segment is not served cold.
/// Ollama unloads idle models after ~5 minutes; a request with an empty prompt
/// loads it and returns immediately. Cloud providers need nothing.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranslationPreparation {
    pub provider: String,
    pub model: String,
    pub warmed: bool,
}

#[tauri::command]
pub async fn api_prepare_live_translation<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    translation_engine: Option<String>,
    speed_mode: Option<String>,
    model_override: Option<String>,
) -> Result<LiveTranslationPreparation, String> {
    clear_provider_health().await;
    let _ = translation_budgets(speed_mode.as_deref());
    let app_data_dir = app.path().app_data_dir().ok();
    let candidates = resolve_provider_candidates(
        state.db_manager.pool(),
        app_data_dir.as_deref(),
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
pub async fn api_warm_live_translation<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let prepared =
        api_prepare_live_translation(app, state, Some("summary".to_string()), None, None).await?;
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
        return Err(format!(
            "Live translation segments are limited to {MAX_LIVE_TEXT_CHARS} characters."
        ));
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

    if source.is_none() {
        // If target is English and active STT engine is producing English:
        if target.code == "en" {
            let mut is_english_stt = false;
            let mut stt_model_name = "parakeet-english".to_string();

            if let Ok(Some(transcript_setting)) =
                SettingsRepository::get_transcript_config(state.db_manager.pool()).await
            {
                if transcript_setting.provider.eq_ignore_ascii_case("parakeet") {
                    is_english_stt = true;
                    stt_model_name = "parakeet-english".to_string();
                } else if transcript_setting.model.to_lowercase().ends_with(".en") {
                    is_english_stt = true;
                    stt_model_name = format!("{}-english", transcript_setting.provider);
                }
            }

            if !is_english_stt {
                if let Some(pref) = crate::get_language_preference_internal() {
                    if pref.eq_ignore_ascii_case("en") || pref.to_lowercase().starts_with("en-") {
                        is_english_stt = true;
                        stt_model_name = "whisper-english".to_string();
                    }
                }
            }

            if is_english_stt {
                return Ok(LiveTranslationResponse {
                    request_id,
                    translated_text: text.to_string(),
                    source_language: Some("en".to_string()),
                    target_language: target.code.to_string(),
                    provider: "passthrough".to_string(),
                    model: stt_model_name,
                    latency_ms: 0,
                    first_word_latency_ms: 0,
                    fallback_reason: None,
                    cached: true,
                });
            }
        }

        // Language detection check
        if let Some(info) = whatlang::detect(text) {
            if let Some(detected_app_code) = whatlang_to_app_language_code(info.lang()) {
                let matches_target =
                    is_detected_language_matching_target(detected_app_code, &target.code);
                let high_confidence = info.is_reliable() && info.confidence() >= 0.70;
                let english_match =
                    target.code == "en" && detected_app_code == "en" && info.confidence() >= 0.40;

                if matches_target && (high_confidence || english_match) {
                    return Ok(LiveTranslationResponse {
                        request_id,
                        translated_text: text.to_string(),
                        source_language: Some(detected_app_code.to_string()),
                        target_language: target.code.to_string(),
                        provider: "passthrough".to_string(),
                        model: "detected-language".to_string(),
                        latency_ms: 0,
                        first_word_latency_ms: 0,
                        fallback_reason: None,
                        cached: true,
                    });
                }
            }
        }

        // Conversational English check for short preview turns where statistical detection lacks sample length
        if target.code == "en" && is_conversational_english(text) {
            return Ok(LiveTranslationResponse {
                request_id,
                translated_text: text.to_string(),
                source_language: Some("en".to_string()),
                target_language: target.code.to_string(),
                provider: "passthrough".to_string(),
                model: "conversational-english".to_string(),
                latency_ms: 0,
                first_word_latency_ms: 0,
                fallback_reason: None,
                cached: true,
            });
        }
    }

    let app_data_dir = app.path().app_data_dir().ok();
    let budgets = translation_budgets(speed_mode.as_deref());
    let mut candidates = resolve_provider_candidates(
        state.db_manager.pool(),
        app_data_dir.as_deref(),
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
        if ready.is_empty() {
            ready = cooling;
        } else {
            ready.extend(cooling);
        }
        candidates = ready;
    }

    let (generation, cancellation_token) = register_translation(&request_id).await;
    let total_started = Instant::now();
    let mut last_error = None;
    let mut fallback_reason = None;

    for (index, config) in candidates.iter().enumerate() {
        let effective_config_budgets =
            effective_budgets(budgets, uses_extended_translation_budget(&config.provider));
        if total_started.elapsed() >= effective_config_budgets.total {
            last_error = Some(format!(
                "live translation exceeded total {}ms latency budget",
                effective_config_budgets.total.as_millis()
            ));
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

        let remaining_total = effective_config_budgets
            .total
            .saturating_sub(total_started.elapsed());
        let attempt_limit = effective_config_budgets.attempt.min(remaining_total);
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
                effective_config_budgets,
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
                TRANSLATION_CACHE
                    .lock()
                    .await
                    .insert(key, translated_text.clone());
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
    Err(last_error
        .unwrap_or_else(|| "All configured live translation providers failed.".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instant_mode_has_tight_first_word_budget() {
        let budget = translation_budgets(Some("instant"));
        assert_eq!(budget.first_word, Duration::from_millis(2800));
        assert_eq!(budget.total, Duration::from_secs(15));
    }

    #[test]
    fn fast_translation_models_are_not_summary_models() {
        assert_eq!(fast_default_model("groq"), Some(FAST_GROQ_MODEL));
        assert_eq!(fast_default_model("openai"), Some(FAST_OPENAI_MODEL));
        assert_eq!(fast_default_model("claude"), Some(FAST_CLAUDE_MODEL));
    }

    #[test]
    fn resolves_codes_and_names() {
        assert_eq!(resolve_language("TH").unwrap().name, "Thai");
        assert_eq!(
            resolve_language("Chinese (Simplified)").unwrap().code,
            "zh-CN"
        );
        assert!(resolve_language("Klingon").is_err());
    }

    #[test]
    fn auto_source_is_none() {
        assert!(resolve_source_language(Some("auto")).unwrap().is_none());
        assert_eq!(
            resolve_source_language(Some("Spanish"))
                .unwrap()
                .unwrap()
                .code,
            "es"
        );
    }

    #[test]
    fn prompt_demands_translation_only() {
        let (system, user) = build_translation_prompts(
            "Hello Mayur",
            Some(resolve_language("en").unwrap()),
            resolve_language("th").unwrap(),
            None,
            None,
            None,
        );
        assert!(system.contains("English"));
        assert!(system.contains("Thai"));
        assert!(system.contains("Return ONLY the translation"));
        assert_eq!(user, "Hello Mayur");
    }

    #[test]
    fn local_providers_are_single_flight() {
        assert!(uses_local_translation_worker(&LLMProvider::Ollama));
        assert!(uses_local_translation_worker(&LLMProvider::BuiltInAI));
        assert!(!uses_local_translation_worker(&LLMProvider::OpenAICodex));
        assert!(!uses_local_translation_worker(&LLMProvider::OpenAI));
    }

    #[test]
    fn local_and_codex_providers_receive_extended_budget() {
        assert!(uses_extended_translation_budget(&LLMProvider::OpenAICodex));
        assert!(uses_extended_translation_budget(&LLMProvider::BuiltInAI));
        assert!(uses_extended_translation_budget(&LLMProvider::Ollama));
        assert!(!uses_extended_translation_budget(&LLMProvider::Groq));
        assert!(!uses_extended_translation_budget(&LLMProvider::Claude));
    }

    #[test]
    fn extracts_stream_deltas_per_provider() {
        let chat = serde_json::json!({"choices":[{"delta":{"content":"Hola"}}]});
        assert_eq!(chat_delta(&chat).unwrap().as_deref(), Some("Hola"));
        assert!(chat_delta(&serde_json::json!({"error":{"message":"quota"}})).is_err());

        let claude = serde_json::json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"Bon"}});
        assert_eq!(claude_delta(&claude).unwrap().as_deref(), Some("Bon"));
        assert_eq!(
            claude_delta(&serde_json::json!({"type":"message_start"})).unwrap(),
            None
        );

        let codex = serde_json::json!({"type":"response.output_text.delta","delta":"Ciao"});
        assert_eq!(codex_delta(&codex).unwrap().as_deref(), Some("Ciao"));
        assert!(codex_delta(
            &serde_json::json!({"type":"response.failed","error":{"message":"x"}})
        )
        .is_err());
    }

    #[test]
    fn cleans_common_wrappers() {
        assert_eq!(clean_translation_output("Translation: Bonjour"), "Bonjour");
        assert_eq!(clean_translation_output("\"Hola\""), "Hola");
        assert_eq!(clean_translation_output("```text\nCiao\n```"), "Ciao");
    }

    #[test]
    fn fast_claude_model_is_haiku_4_5() {
        assert_eq!(FAST_CLAUDE_MODEL, "claude-haiku-4-5-20251001");
        assert_eq!(fast_default_model("claude"), Some("claude-haiku-4-5-20251001"));
    }

    #[test]
    fn maps_whatlang_languages_to_supported_app_codes() {
        assert_eq!(whatlang_to_app_language_code(whatlang::Lang::Jpn), Some("ja"));
        assert_eq!(whatlang_to_app_language_code(whatlang::Lang::Spa), Some("es"));
        assert_eq!(whatlang_to_app_language_code(whatlang::Lang::Cmn), Some("zh"));
        assert_eq!(whatlang_to_app_language_code(whatlang::Lang::Deu), Some("de"));
        assert_eq!(whatlang_to_app_language_code(whatlang::Lang::Fra), Some("fr"));
        assert_eq!(whatlang_to_app_language_code(whatlang::Lang::Eng), Some("en"));
        assert_eq!(whatlang_to_app_language_code(whatlang::Lang::Rus), Some("ru"));
        assert_eq!(whatlang_to_app_language_code(whatlang::Lang::Kor), Some("ko"));
    }

    #[test]
    fn detected_language_matches_target() {
        assert!(is_detected_language_matching_target("ja", "ja"));
        assert!(is_detected_language_matching_target("es", "es"));
        assert!(is_detected_language_matching_target("zh", "zh-CN"));
        assert!(is_detected_language_matching_target("zh", "zh-TW"));
        assert!(is_detected_language_matching_target("en", "en"));
        assert!(!is_detected_language_matching_target("ja", "en"));
        assert!(!is_detected_language_matching_target("es", "fr"));
    }

    #[test]
    fn local_providers_receive_extended_budgets() {
        let instant_cloud = effective_budgets(translation_budgets(Some("instant")), false);
        assert_eq!(instant_cloud.first_word, Duration::from_millis(2800));
        assert_eq!(instant_cloud.total, Duration::from_secs(15));

        let instant_local = effective_budgets(translation_budgets(Some("instant")), true);
        assert_eq!(instant_local.first_word, Duration::from_secs(12));
        assert_eq!(instant_local.attempt, Duration::from_secs(25));
        assert_eq!(instant_local.total, Duration::from_secs(30));
    }

    #[tokio::test]
    async fn provider_cooldown_resets() {
        let config = TranslationProviderConfig {
            provider: LLMProvider::Groq,
            provider_name: "groq".to_string(),
            model_name: FAST_GROQ_MODEL.to_string(),
            api_key: "dummy".to_string(),
            ollama_endpoint: None,
            custom_openai_endpoint: None,
            max_tokens: None,
            temperature: None,
            top_p: None,
        };
        record_provider_failure(&config).await;
        record_provider_failure(&config).await;
        record_provider_failure(&config).await;
        assert!(provider_is_cooling_down(&config).await);

        clear_provider_health().await;
        assert!(!provider_is_cooling_down(&config).await);
    }

    #[test]
    fn conversational_english_detection() {
        assert!(is_conversational_english("Good morning everyone"));
        assert!(is_conversational_english("Yes, I agree with that"));
        assert!(is_conversational_english("Can you hear me?"));
        assert!(is_conversational_english("Sounds good, let's start"));
        assert!(!is_conversational_english("Buenos días a todos"));
        assert!(!is_conversational_english("Bonjour tout le monde"));
        assert!(!is_conversational_english(""));
    }
}

