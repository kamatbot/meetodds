use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;
use crate::summary::llm_client::{generate_summary, LLMProvider};
use once_cell::sync::Lazy;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::{hash_map::DefaultHasher, HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::{Mutex, Semaphore};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

const MAX_LIVE_TEXT_CHARS: usize = 6_000;
const LIVE_TRANSLATION_TIMEOUT: Duration = Duration::from_secs(30);
// A translation is roughly the input length; this only bounds runaway output.
const LIVE_TRANSLATION_MAX_TOKENS: u32 = 512;
const TRANSLATION_CACHE_CAPACITY: usize = 256;

static CLOUD_TRANSLATION_SEMAPHORE: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(2));
static LOCAL_TRANSLATION_SEMAPHORE: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(1));
static TRANSLATION_HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(reqwest::Client::new);
static ACTIVE_TRANSLATIONS: Lazy<Mutex<HashMap<String, ActiveTranslation>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_TRANSLATION_GENERATION: AtomicU64 = AtomicU64::new(1);
static TRANSLATION_CACHE: Lazy<Mutex<TranslationCache>> =
    Lazy::new(|| Mutex::new(TranslationCache::default()));

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
    pub cached: bool,
}

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

fn build_translation_prompts(
    text: &str,
    source_language: Option<LanguageSpec>,
    target_language: LanguageSpec,
) -> (String, String) {
    let source = source_language
        .map(|language| language.name.to_string())
        .unwrap_or_else(|| "the automatically detected source language".to_string());

    let system_prompt = format!(
        "You are a low-latency simultaneous interpreter. Translate from {source} to {}. \
Return only the translated text: no labels, markdown, quotes, explanations, or commentary. \
Preserve names, product terms, numbers, dates, URLs, and the speaker's intent. \
Translate incomplete live-speech fragments naturally without inventing missing context. \
If the input is already in {}, return it unchanged.",
        target_language.name, target_language.name
    );

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

    for prefix in ["Translation:", "Translated text:", "Translated Text:"] {
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

fn uses_local_translation_worker(provider: &LLMProvider) -> bool {
    matches!(provider, LLMProvider::Ollama | LLMProvider::BuiltInAI)
}

fn cache_key(
    provider: &str,
    model: &str,
    source_language: Option<LanguageSpec>,
    target_language: LanguageSpec,
    text: &str,
) -> String {
    let mut hasher = DefaultHasher::new();
    provider.hash(&mut hasher);
    model.hash(&mut hasher);
    source_language
        .map(|language| language.code)
        .hash(&mut hasher);
    target_language.code.hash(&mut hasher);
    text.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
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
#[tauri::command]
pub async fn api_warm_live_translation(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let config = resolve_provider_config(state.db_manager.pool()).await?;
    if config.provider != LLMProvider::Ollama {
        return Ok(false);
    }
    let host = config
        .ollama_endpoint
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    let response = TRANSLATION_HTTP_CLIENT
        .post(format!("{}/api/generate", host.trim_end_matches('/')))
        .json(&serde_json::json!({
            "model": config.model_name,
            "keep_alive": "10m",
            "stream": false
        }))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|error| format!("Failed to warm Ollama model: {error}"))?;
    response
        .error_for_status()
        .map_err(|error| format!("Failed to warm Ollama model: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("Failed to finish warming Ollama model: {error}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn api_translate_live_text<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    request_id: String,
    text: String,
    source_language: Option<String>,
    target_language: String,
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
            cached: true,
        });
    }

    let config = resolve_provider_config(state.db_manager.pool()).await?;
    let key = cache_key(
        &config.provider_name,
        &config.model_name,
        source,
        target,
        text,
    );

    if let Some(translated_text) = TRANSLATION_CACHE.lock().await.get(&key) {
        return Ok(LiveTranslationResponse {
            request_id,
            translated_text,
            source_language: source.map(|language| language.code.to_string()),
            target_language: target.code.to_string(),
            provider: config.provider_name,
            model: config.model_name,
            latency_ms: 0,
            cached: true,
        });
    }

    let (generation, cancellation_token) = register_translation(&request_id).await;
    let started = Instant::now();

    // Cloud requests get limited parallelism and reuse pooled HTTP connections.
    // Local generation stays single-flight so it cannot steal the CPU/GPU budget
    // reserved for live Whisper/Parakeet transcription on Apple Silicon.
    let worker_pool = if uses_local_translation_worker(&config.provider) {
        &*LOCAL_TRANSLATION_SEMAPHORE
    } else {
        &*CLOUD_TRANSLATION_SEMAPHORE
    };

    let permit = tokio::select! {
        permit = worker_pool.acquire() => {
            permit.map_err(|_| "Live translation worker pool is unavailable.".to_string())?
        }
        _ = cancellation_token.cancelled() => {
            cleanup_translation(&request_id, generation).await;
            return Err("Live translation was cancelled.".to_string());
        }
    };

    let (system_prompt, user_prompt) = build_translation_prompts(text, source, target);
    let app_data_dir = app.path().app_data_dir().ok();
    let max_tokens = Some(
        config
            .max_tokens
            .map_or(LIVE_TRANSLATION_MAX_TOKENS, |value| {
                value.min(LIVE_TRANSLATION_MAX_TOKENS)
            }),
    );
    let translation_future = generate_summary(
        &TRANSLATION_HTTP_CLIENT,
        &config.provider,
        &config.model_name,
        &config.api_key,
        &system_prompt,
        &user_prompt,
        config.ollama_endpoint.as_deref(),
        config.custom_openai_endpoint.as_deref(),
        max_tokens,
        config.temperature,
        config.top_p,
        app_data_dir.as_ref(),
        Some(&cancellation_token),
    );

    let result = tokio::select! {
        _ = cancellation_token.cancelled() => Err("Live translation was cancelled.".to_string()),
        timed = timeout(LIVE_TRANSLATION_TIMEOUT, translation_future) => {
            match timed {
                Ok(result) => result,
                Err(_) => {
                    cancellation_token.cancel();
                    Err("Live translation timed out after 30 seconds.".to_string())
                }
            }
        }
    };

    drop(permit);
    cleanup_translation(&request_id, generation).await;

    let translated_text = clean_translation_output(&result?);
    if translated_text.is_empty() {
        return Err("The translation model returned an empty result.".to_string());
    }

    TRANSLATION_CACHE
        .lock()
        .await
        .insert(key, translated_text.clone());

    Ok(LiveTranslationResponse {
        request_id,
        translated_text,
        source_language: source.map(|language| language.code.to_string()),
        target_language: target.code.to_string(),
        provider: config.provider_name,
        model: config.model_name,
        latency_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        cached: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        );
        assert!(system.contains("English"));
        assert!(system.contains("Thai"));
        assert!(system.contains("Return only the translated text"));
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
    fn cleans_common_wrappers() {
        assert_eq!(clean_translation_output("Translation: Bonjour"), "Bonjour");
        assert_eq!(clean_translation_output("\"Hola\""), "Hola");
        assert_eq!(clean_translation_output("```text\nCiao\n```"), "Ciao");
    }
}
