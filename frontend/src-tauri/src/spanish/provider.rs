//! Native host adapter. Registered as crate::spanish_provider, separate from the
//! model-free core so its tests never link Tauri/audio/GPU dependencies.
use crate::spanish::tutor::{
    CallKind, Diagnostic, EventSink, Model, ModelFuture, Prompt, TutorReplyEvent, REPLY_EVENT,
};
use crate::summary::llm_client::{self, LLMProvider};
use crate::summary::summary_engine::client::{
    generate_with_builtin_with_sampling, BuiltinSamplingOverride,
};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::{Emitter, Runtime, WebviewWindow};
use tokio_util::sync::CancellationToken;

/// Construct only from the existing native provider settings/key store. This
/// type is intentionally not Serialize/Deserialize/Debug and never crosses IPC.
pub struct ProviderConfig {
    pub provider: LLMProvider,
    pub model: String,
    pub api_key: String,
    pub app_data_dir: PathBuf,
    pub ollama_endpoint: Option<String>,
    pub custom_endpoint: Option<String>,
    pub allow_external_text: bool,
    /// Cloud capabilities come from the host's selected-model configuration.
    /// Do not send unsupported sampling fields to reasoning-only endpoints.
    pub cloud_sampling_supported: bool,
}
pub struct MeetOddsModel {
    client: reqwest::Client,
    config: ProviderConfig,
    token_counter: Option<Arc<dyn Fn(&str) -> usize + Send + Sync>>,
}
fn loopback(endpoint: &str) -> bool {
    reqwest::Url::parse(endpoint).ok().is_some_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && matches!(
                url.host_str(),
                Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
            )
    })
}
impl MeetOddsModel {
    pub fn new(client: reqwest::Client, config: ProviderConfig) -> Result<Self, String> {
        let local = match config.provider {
            LLMProvider::BuiltInAI => true,
            LLMProvider::Ollama => loopback(
                config
                    .ollama_endpoint
                    .as_deref()
                    .unwrap_or("http://localhost:11434"),
            ),
            LLMProvider::CustomOpenAI => config.custom_endpoint.as_deref().is_some_and(loopback),
            _ => false,
        };
        if !local && !config.allow_external_text {
            return Err("Enable external AI for this practice profile before sending text to the selected provider.".into());
        }
        if config.model.trim().is_empty() {
            return Err("Choose a tutoring model first.".into());
        }
        Ok(Self {
            client,
            config,
            token_counter: None,
        })
    }
    /// The counter must be the SELECTED model's actual tokenizer. Without it,
    /// the conservative byte bound still enforces the brief's prompt limits.
    pub fn with_token_counter(mut self, counter: Arc<dyn Fn(&str) -> usize + Send + Sync>) -> Self {
        self.token_counter = Some(counter);
        self
    }
}
impl Model for MeetOddsModel {
    fn token_count(&self, text: &str) -> usize {
        self.token_counter
            .as_ref()
            .map(|count| count(text))
            .unwrap_or(text.len())
    }
    // Keep one native tutoring request in flight. The core emits the reply
    // before making a judge request; no competing analytic slot on llama-helper.
    fn generate<'a>(&'a self, prompt: Prompt, cancel: CancellationToken) -> ModelFuture<'a> {
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Err("cancelled".into());
            }
            let config = &self.config;
            if config.provider == LLMProvider::BuiltInAI {
                static LOCAL: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
                let lock = LOCAL.get_or_init(|| tokio::sync::Mutex::new(()));
                let _slot = tokio::select! { biased;
                    _ = cancel.cancelled() => return Err("cancelled".into()),
                    slot = lock.lock() => slot,
                };
                return generate_with_builtin_with_sampling(
                    &config.app_data_dir,
                    &config.model,
                    &prompt.system,
                    &prompt.user,
                    Some(prompt.max_tokens),
                    Some(&cancel),
                    Some(BuiltinSamplingOverride {
                        temperature: prompt.temperature,
                        top_p: prompt.top_p,
                        top_k: if prompt.kind == CallKind::Judge {
                            1
                        } else {
                            40
                        },
                    }),
                )
                .await
                .map_err(|_| "The local tutoring model could not complete this request.".into());
            }
            if config.provider == LLMProvider::OpenAICodex {
                // Reuse the existing account provider, do not invent API access
                // or sampling guarantees for subscription-backed inference.
                return llm_client::generate_summary(
                    &self.client,
                    &config.provider,
                    &config.model,
                    &config.api_key,
                    &prompt.system,
                    &prompt.user,
                    config.ollama_endpoint.as_deref(),
                    config.custom_endpoint.as_deref(),
                    Some(prompt.max_tokens),
                    None,
                    None,
                    Some(&config.app_data_dir),
                    Some(&cancel),
                )
                .await
                .map_err(|_| {
                    "The selected account provider could not complete this request.".into()
                });
            }
            let builder = llm_client::build_chat_request(
                &self.client,
                &config.provider,
                &config.model,
                &config.api_key,
                &prompt.system,
                &prompt.user,
                config.ollama_endpoint.as_deref(),
                config.custom_endpoint.as_deref(),
                Some(prompt.max_tokens),
                None,
                None,
                false,
            )?;
            let mut request = builder
                .build()
                .map_err(|_| "Cannot build the tutoring request.")?;
            // The current shared builder drops sampling except for CustomOpenAI.
            // Patch THIS tutoring request body, leaving all meeting calls alone.
            if matches!(
                config.provider,
                LLMProvider::Ollama | LLMProvider::CustomOpenAI
            ) || config.cloud_sampling_supported
            {
                let bytes = request
                    .body()
                    .and_then(|body| body.as_bytes())
                    .ok_or("Missing request body.")?;
                let mut body: serde_json::Value =
                    serde_json::from_slice(bytes).map_err(|_| "Invalid request body.")?;
                body["temperature"] = serde_json::json!(prompt.temperature);
                if config.provider != LLMProvider::Claude {
                    body["top_p"] = serde_json::json!(prompt.top_p);
                }
                *request.body_mut() = Some(
                    serde_json::to_vec(&body)
                        .map_err(|_| "Cannot encode request.")?
                        .into(),
                );
            }
            let operation = async {
                let mut response = self
                    .client
                    .execute(request)
                    .await
                    .map_err(|_| "Tutoring connection failed.")?;
                if !response.status().is_success() {
                    return Err(format!(
                        "Tutoring provider returned HTTP {}.",
                        response.status()
                    ));
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| "Tutoring response interrupted.")?
                {
                    if bytes.len() + chunk.len() > 128_000 {
                        return Err("Tutoring response exceeds the size limit.".into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                if config.provider == LLMProvider::Claude {
                    let parsed: llm_client::ClaudeChatResponse =
                        serde_json::from_slice(&bytes).map_err(|_| "Invalid provider response.")?;
                    parsed
                        .content
                        .into_iter()
                        .next()
                        .map(|item| item.text)
                        .ok_or_else(|| "Empty provider response.".into())
                } else {
                    let parsed: llm_client::ChatResponse =
                        serde_json::from_slice(&bytes).map_err(|_| "Invalid provider response.")?;
                    parsed
                        .choices
                        .into_iter()
                        .next()
                        .map(|item| item.message.content)
                        .ok_or_else(|| "Empty provider response.".into())
                }
            };
            tokio::select! { biased; _ = cancel.cancelled() => Err("cancelled".into()), result = operation => result }
        })
    }
}

/// Events are scoped to the originating window. The frontend must ALSO check
/// sessionId/requestId after navigation or a spoken interruption.
pub struct WindowSink<R: Runtime> {
    pub window: WebviewWindow<R>,
    pub sensitive_diagnostics: Option<Arc<dyn Fn(Diagnostic) + Send + Sync>>,
}
impl<R: Runtime> EventSink for WindowSink<R> {
    fn reply(&self, event: TutorReplyEvent) -> Result<(), String> {
        self.window
            .emit_to(self.window.label(), REPLY_EVENT, event)
            .map_err(|_| "Practice view unavailable.".into())
    }
    fn diagnostic(&self, diagnostic: Diagnostic) {
        log::debug!("Spanish tutor: {}", diagnostic.reason);
        if let Some(sink) = &self.sensitive_diagnostics {
            sink(diagnostic);
        }
    }
}

/// Call inside the companion branch's migration transaction AFTER its existing
/// spanish_profiles table is present. Do not add this to global startup before
/// that branch lands; no replacement profile/session tables are created here.
pub async fn migrate_practicing(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<(), String> {
    use sqlx::Row;
    let columns = sqlx::query("PRAGMA table_info(spanish_profiles)")
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    if columns.is_empty() {
        return Err("Spanish profile foundation has not been installed.".into());
    }
    let present = columns
        .iter()
        .any(|row| row.try_get::<String, _>("name").ok().as_deref() == Some("practicing"));
    if !present {
        sqlx::query(include_str!("migrations/001_practicing.sql"))
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
