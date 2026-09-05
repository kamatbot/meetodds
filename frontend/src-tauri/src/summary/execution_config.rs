//! Resolve and freeze the destination before resetting a summary job or sending text.
//! Secrets are deliberately excluded from Debug/Serialize implementations.
use crate::database::repositories::setting::SettingsRepository;
use crate::summary::llm_client::LLMProvider;
use serde::Deserialize;
use sqlx::SqlitePool;
use url::{Host, Url};

#[derive(Clone, Deserialize)]
pub struct DestinationApproval { pub provider: String, pub model: String, pub destination: String }
pub struct ResolvedSummaryConfig {
    pub provider: LLMProvider, pub api_key: String, pub ollama_endpoint: Option<String>,
    pub custom_openai_endpoint: Option<String>, pub max_tokens: Option<u32>,
    pub temperature: Option<f32>, pub top_p: Option<f32>, pub local: bool,
}
pub fn canonical_endpoint(value: &str) -> Result<(String, bool), String> {
    let url = Url::parse(value).map_err(|_| "Invalid summary endpoint".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("Use an HTTP(S) endpoint without embedded credentials, query parameters or fragments".to_string());
    }
    let local = match url.host() {
        Some(Host::Domain("localhost")) => true,
        Some(Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
        _ => false,
    };
    if !local && url.scheme() != "https" { return Err("Remote summary endpoints require HTTPS".to_string()); }
    Ok((url.to_string().trim_end_matches('/').to_string(), local))
}
fn check_approval(approval: Option<&DestinationApproval>, provider: &str, model: &str, destination: &str, local: bool) -> Result<(), String> {
    let Some(approval) = approval else {
        if local { return Ok(()); }
        return Err("Review and approve the summary destination before sending meeting text".to_string());
    };
    if approval.provider != provider || approval.model != model || approval.destination != destination {
        return Err("Summary destination or model changed after review. Nothing was sent; review it again.".to_string());
    }
    Ok(())
}
pub async fn resolve(pool: &SqlitePool, provider_name: &str, model: &str, approval: Option<&DestinationApproval>) -> Result<ResolvedSummaryConfig, String> {
    let provider = LLMProvider::from_str(provider_name)?;
    if model.trim().is_empty() { return Err("Select a summary model".to_string()); }
    let mut resolved = ResolvedSummaryConfig { provider: provider.clone(), api_key: String::new(), ollama_endpoint: None,
        custom_openai_endpoint: None, max_tokens: None, temperature: None, top_p: None, local: false };
    let destination = match provider {
        LLMProvider::BuiltInAI => { resolved.local = true; "on-device".to_string() }
        LLMProvider::OpenAICodex => "https://chatgpt.com/backend-api/codex".to_string(),
        LLMProvider::OpenAI => "https://api.openai.com/v1".to_string(),
        LLMProvider::Claude => "https://api.anthropic.com/v1".to_string(),
        LLMProvider::Groq => "https://api.groq.com/openai/v1".to_string(),
        LLMProvider::OpenRouter => "https://openrouter.ai/api/v1".to_string(),
        LLMProvider::Ollama => {
            let config = SettingsRepository::get_model_config(pool).await.map_err(|_| "Summary settings could not be read".to_string())?;
            let endpoint = config.and_then(|c| c.ollama_endpoint).filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "http://localhost:11434".to_string());
            let (endpoint, local) = canonical_endpoint(&endpoint)?;
            resolved.local = local; resolved.ollama_endpoint = Some(endpoint.clone()); endpoint
        }
        LLMProvider::CustomOpenAI => {
            let config = SettingsRepository::get_custom_openai_config(pool).await.map_err(|_| "Custom provider settings could not be read".to_string())?
                .ok_or_else(|| "Custom provider is not configured".to_string())?;
            if config.model != model { return Err("Custom model changed after review. Review the current model before continuing.".to_string()); }
            let (endpoint, local) = canonical_endpoint(&config.endpoint)?;
            resolved.local = local; resolved.custom_openai_endpoint = Some(endpoint.clone());
            resolved.api_key = config.api_key.unwrap_or_default();
            resolved.max_tokens = config.max_tokens.filter(|n| *n > 0).map(|n| n as u32);
            resolved.temperature = config.temperature; resolved.top_p = config.top_p; endpoint
        }
    };
    check_approval(approval, provider_name, model, &destination, resolved.local)?;
    if matches!(provider, LLMProvider::OpenAI | LLMProvider::Claude | LLMProvider::Groq | LLMProvider::OpenRouter) {
        resolved.api_key = SettingsRepository::get_api_key(pool, provider_name).await.map_err(|_| "Provider credentials could not be read".to_string())?
            .filter(|key| !key.trim().is_empty()).ok_or_else(|| "Provider API key is not configured".to_string())?;
    }
    Ok(resolved)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn only_exact_loopback_is_local() {
        for url in ["http://localhost:11434", "http://127.0.0.1:8080", "http://[::1]:1234"] { assert!(canonical_endpoint(url).unwrap().1); }
        for url in ["https://localhost.example.com", "https://127.0.0.1.example.com", "https://192.168.1.2"] { assert!(!canonical_endpoint(url).unwrap().1); }
    }
    #[test] fn remote_http_and_embedded_credentials_fail_closed() {
        for url in ["http://example.com", "https://u:p@example.com", "https://example.com/?key=x", "https://example.com/#token", "file:///tmp"] { assert!(canonical_endpoint(url).is_err(), "{url}"); }
    }
    #[test] fn remote_text_requires_matching_destination_and_model() {
        assert!(check_approval(None, "openai", "model", "https://api.openai.com/v1", false).is_err());
        let approval = DestinationApproval { provider: "openai".to_string(), model: "model".to_string(), destination: "https://api.openai.com/v1".to_string() };
        assert!(check_approval(Some(&approval), "openai", "model", &approval.destination, false).is_ok());
        assert!(check_approval(Some(&approval), "openai", "different", &approval.destination, false).is_err());
        assert!(check_approval(Some(&approval), "openai", "model", "https://other.example", false).is_err());
    }
}
