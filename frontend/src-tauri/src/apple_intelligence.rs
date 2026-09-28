//! On-device Apple Intelligence (Foundation Models) bridge. Same rules as
//! apple_speech: numeric request IDs, Rust copies each JSON reply immediately,
//! bounded waits, and dropping a request cancels it in Swift.
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub const PROVIDER_ID: &str = "apple-intelligence";
pub const MODEL_ID: &str = "system";
#[cfg(not(target_os = "macos"))]
const UNAVAILABLE: &str = "Apple Intelligence requires macOS 26 or later on a supported Mac.";

/// Returned to the frontend (settings + onboarding).
#[derive(Debug, Clone, Serialize)]
pub struct AppleIntelligenceStatus {
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub available: bool,
    pub reason: Option<String>,
    pub context_size: usize,
    /// Base language codes, e.g. "en", "zh".
    pub languages: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Reply {
    Status {
        available: bool,
        reason: Option<String>,
        #[serde(rename = "contextSize")]
        context_size: usize,
        languages: Vec<String>,
    },
    Tokens {
        counts: Vec<usize>,
    },
    Text {
        text: String,
    },
    Error {
        message: String,
    },
}

static CALLBACKS: Lazy<Mutex<HashMap<u64, oneshot::Sender<Reply>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[cfg(target_os = "macos")]
mod ffi {
    use std::ffi::c_char;
    pub type Callback = extern "C" fn(u64, *const c_char);
    extern "C" {
        pub fn md_ai_status(id: u64, callback: Callback);
        pub fn md_ai_token_counts(id: u64, json: *const c_char, callback: Callback);
        pub fn md_ai_generate(id: u64, json: *const c_char, callback: Callback);
        pub fn md_ai_cancel(id: u64);
    }
}

#[cfg(target_os = "macos")]
extern "C" fn receive(id: u64, json: *const std::ffi::c_char) {
    if json.is_null() {
        return;
    }
    // Swift owns the string only for this call. Deserialize/copy before returning.
    let bytes = unsafe { std::ffi::CStr::from_ptr(json) }.to_bytes();
    let reply = serde_json::from_slice(bytes).unwrap_or_else(|_| Reply::Error {
        message: "Apple Intelligence returned an invalid response.".into(),
    });
    let sender = CALLBACKS.lock().ok().and_then(|mut c| c.remove(&id));
    if let Some(sender) = sender {
        let _ = sender.send(reply);
    }
}

/// One in-flight request. Dropping it (timeout, cancellation, completion) removes
/// the callback and cancels any Swift work still running for this ID.
struct Request {
    id: u64,
    reply: oneshot::Receiver<Reply>,
}

impl Request {
    fn register() -> Self {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (sender, reply) = oneshot::channel();
        CALLBACKS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, sender);
        Self { id, reply }
    }

    async fn wait(
        &mut self,
        timeout: Duration,
        cancel: Option<&CancellationToken>,
    ) -> Result<Reply, String> {
        let never = CancellationToken::new();
        let cancel = cancel.unwrap_or(&never);
        tokio::select! {
            _ = cancel.cancelled() => Err("Summary generation was cancelled".into()),
            reply = tokio::time::timeout(timeout, &mut self.reply) => match reply {
                Ok(Ok(Reply::Error { message })) => Err(message),
                Ok(Ok(reply)) => Ok(reply),
                Ok(Err(_)) => Err("Apple Intelligence stopped responding.".into()),
                Err(_) => Err("Apple Intelligence did not respond in time.".into()),
            },
        }
    }
}

impl Drop for Request {
    fn drop(&mut self) {
        if let Ok(mut callbacks) = CALLBACKS.lock() {
            callbacks.remove(&self.id);
        }
        #[cfg(target_os = "macos")]
        unsafe {
            ffi::md_ai_cancel(self.id);
        }
    }
}

#[cfg(target_os = "macos")]
fn json_cstring(value: &serde_json::Value) -> Result<std::ffi::CString, String> {
    // serde_json escapes NUL, so this cannot fail for serialized JSON.
    std::ffi::CString::new(value.to_string())
        .map_err(|_| "Invalid Apple Intelligence request.".into())
}

pub async fn model_info() -> Result<ModelInfo, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Ok(ModelInfo {
            available: false,
            reason: Some(UNAVAILABLE.into()),
            context_size: 0,
            languages: vec![],
        });
    }
    #[cfg(target_os = "macos")]
    {
        let mut request = Request::register();
        unsafe { ffi::md_ai_status(request.id, receive) };
        match request.wait(Duration::from_secs(15), None).await? {
            Reply::Status {
                available,
                reason,
                context_size,
                languages,
            } => Ok(ModelInfo {
                available,
                reason,
                context_size,
                languages,
            }),
            _ => Err("Could not read Apple Intelligence availability.".into()),
        }
    }
}

#[tauri::command]
pub async fn api_apple_intelligence_status() -> Result<AppleIntelligenceStatus, String> {
    let info = model_info().await?;
    Ok(AppleIntelligenceStatus {
        available: info.available,
        reason: info.reason,
    })
}

/// Exact model token counts, in input order, in one bridge round trip.
pub async fn token_counts(
    texts: &[String],
    cancel: Option<&CancellationToken>,
) -> Result<Vec<usize>, String> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cancel;
        return Err(UNAVAILABLE.into());
    }
    #[cfg(target_os = "macos")]
    {
        let payload = json_cstring(&serde_json::json!(texts))?;
        let mut request = Request::register();
        unsafe { ffi::md_ai_token_counts(request.id, payload.as_ptr(), receive) };
        match request.wait(Duration::from_secs(120), cancel).await? {
            Reply::Tokens { counts } if counts.len() == texts.len() => Ok(counts),
            _ => Err("Apple Intelligence returned an invalid token count.".into()),
        }
    }
}

/// One stateless generation. `max_tokens`/`temperature` of None use Apple's defaults.
pub async fn generate(
    instructions: &str,
    prompt: &str,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    cancel: Option<&CancellationToken>,
) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (instructions, prompt, max_tokens, temperature, cancel);
        return Err(UNAVAILABLE.into());
    }
    #[cfg(target_os = "macos")]
    {
        let payload = json_cstring(&serde_json::json!({
            "instructions": instructions,
            "prompt": prompt,
            "maxTokens": max_tokens,
            "temperature": temperature,
        }))?;
        let mut request = Request::register();
        unsafe { ffi::md_ai_generate(request.id, payload.as_ptr(), receive) };
        match request.wait(Duration::from_secs(300), cancel).await? {
            Reply::Text { text } => Ok(text.trim().to_string()),
            _ => Err("Apple Intelligence returned an invalid response.".into()),
        }
    }
}

fn base_language(code: &str) -> String {
    let base = code.trim().to_ascii_lowercase().replace('_', "-");
    let base = base.split('-').next().unwrap_or_default();
    // whatlang/ISO 639-1 "no" is Norwegian Bokmål in Apple's list.
    if base == "no" {
        "nb".into()
    } else {
        base.into()
    }
}

/// Explicit failure for a meeting language the on-device model can't handle.
/// Unknown/undetected languages pass; Apple still reports a language error itself.
pub fn ensure_language_supported(languages: &[String], code: Option<&str>) -> Result<(), String> {
    let Some(code) = code.map(str::trim).filter(|c| !c.is_empty()) else {
        return Ok(());
    };
    let base = base_language(code);
    if languages.iter().any(|l| base_language(l) == base) {
        return Ok(());
    }
    let name = crate::summary::processor::language_name_from_code(code).unwrap_or(code);
    Err(format!(
        "Apple Intelligence doesn't support {name} yet. Choose ChatGPT in Settings → Summary to summarize this meeting."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn langs() -> Vec<String> {
        ["en", "es", "nb", "zh"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn apple_intelligence_language_gate_is_explicit() {
        assert!(ensure_language_supported(&langs(), None).is_ok());
        assert!(ensure_language_supported(&langs(), Some("en-GB")).is_ok());
        assert!(ensure_language_supported(&langs(), Some("zh_TW")).is_ok());
        assert!(ensure_language_supported(&langs(), Some("no")).is_ok());
        let err = ensure_language_supported(&langs(), Some("hi")).unwrap_err();
        assert!(err.contains("Hindi") && err.contains("ChatGPT"), "{err}");
    }

    #[test]
    fn apple_intelligence_reply_contract() {
        let reply: Reply = serde_json::from_str(
            r#"{"kind":"status","available":false,"reason":"off","contextSize":4096,"languages":["en"]}"#,
        )
        .unwrap();
        assert!(matches!(
            reply,
            Reply::Status {
                context_size: 4096,
                ..
            }
        ));
        let reply: Reply =
            serde_json::from_str(r#"{"kind":"error","code":"language","message":"x"}"#).unwrap();
        assert!(matches!(reply, Reply::Error { .. }));
    }

    #[test]
    fn apple_intelligence_request_is_removed_on_drop() {
        let request = Request::register();
        let id = request.id;
        assert!(CALLBACKS.lock().unwrap().contains_key(&id));
        drop(request);
        assert!(!CALLBACKS.lock().unwrap().contains_key(&id));
    }

    /// Explicit on-device smoke check; needs Apple Intelligence enabled on this Mac.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires macOS 26+ with Apple Intelligence enabled"]
    async fn apple_intelligence_native_round_trip() {
        let info = model_info().await.unwrap();
        println!(
            "available={} context={} languages={:?}",
            info.available, info.context_size, info.languages
        );
        assert!(info.available, "{:?}", info.reason);
        let counts = token_counts(&["Hello there.".into(), "".into()], None)
            .await
            .unwrap();
        assert!(counts[0] > 0 && counts.len() == 2, "{counts:?}");
        let text = generate(
            "Answer with one word.",
            "Say hello.",
            Some(8),
            Some(0.0),
            None,
        )
        .await
        .unwrap();
        assert!(!text.is_empty());
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(generate("", "Say hello.", None, None, Some(&cancel))
            .await
            .unwrap_err()
            .contains("cancelled"));
    }
}
