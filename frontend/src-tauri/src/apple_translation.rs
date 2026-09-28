//! On-device Apple Translation bridge. Same numeric-id callback contract as `apple_speech`:
//! Swift never holds Rust pointers, and each JSON payload is copied before the callback returns.
//! Language assets are never downloaded from here; missing pairs point to System Settings.
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

pub const PROVIDER: &str = "apple-translation";
pub const MODEL: &str = "on-device";
const INSTALL_PATH: &str =
    "System Settings › General › Language & Region › Translation Languages…";
#[cfg(target_os = "macos")]
const SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.Localization-Settings.extension";
#[cfg(not(target_os = "macos"))]
const UNAVAILABLE: &str = "Apple Translation requires macOS 26 or later. Choose ChatGPT or a cloud engine.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Availability {
    Installed,
    Supported,
    Unsupported,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Event {
    Status { status: Availability, warmed: bool },
    Translated { text: String },
    Error { code: String, message: String },
}

// One answer per request id, so each registration is a oneshot and cannot back up.
static CALLBACKS: Lazy<Mutex<HashMap<u64, oneshot::Sender<Event>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[cfg(target_os = "macos")]
mod ffi {
    use std::ffi::c_char;
    pub type Callback = extern "C" fn(u64, *const c_char);
    extern "C" {
        pub fn md_translation_prepare(
            id: u64,
            source: *const c_char,
            target: *const c_char,
            warm: bool,
            callback: Callback,
        );
        pub fn md_translation_translate(
            id: u64,
            source: *const c_char,
            target: *const c_char,
            text: *const c_char,
            callback: Callback,
        );
        pub fn md_translation_cancel(id: u64);
        pub fn md_translation_reset();
    }
}

#[cfg(target_os = "macos")]
extern "C" fn receive(id: u64, json: *const std::ffi::c_char) {
    if json.is_null() {
        return;
    }
    // Swift owns the string only for this call. Deserialize/copy before returning.
    let bytes = unsafe { std::ffi::CStr::from_ptr(json) }.to_bytes();
    let event = serde_json::from_slice(bytes).unwrap_or_else(|_| Event::Error {
        code: "failed".into(),
        message: "Apple Translation returned an invalid response.".into(),
    });
    let sender = CALLBACKS.lock().ok().and_then(|mut map| map.remove(&id));
    if let Some(sender) = sender {
        let _ = sender.send(event);
    }
}

/// A registered native request. Dropping it (finished, timed out or superseded)
/// forgets the callback and cancels the Swift task.
struct Request {
    id: u64,
    answer: Option<oneshot::Receiver<Event>>,
}

impl Drop for Request {
    fn drop(&mut self) {
        if let Ok(mut map) = CALLBACKS.lock() {
            map.remove(&self.id);
        }
        #[cfg(target_os = "macos")]
        unsafe {
            ffi::md_translation_cancel(self.id);
        }
    }
}

impl Request {
    fn register() -> Self {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (sender, answer) = oneshot::channel();
        CALLBACKS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, sender);
        Self {
            id,
            answer: Some(answer),
        }
    }

    async fn wait(&mut self, limit: Duration, cancel: &CancellationToken) -> Result<Event, String> {
        let answer = self.answer.take().ok_or("Apple Translation request was already used.")?;
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("Live translation was cancelled.".into()),
            answer = tokio::time::timeout(limit, answer) => match answer {
                Ok(Ok(event)) => Ok(event),
                Ok(Err(_)) => Err("Apple Translation stopped responding.".into()),
                Err(_) => Err("Apple Translation did not respond in time.".into()),
            },
        }
    }
}

#[cfg(target_os = "macos")]
fn language_arg(value: &str) -> Result<std::ffi::CString, String> {
    let valid = !value.is_empty()
        && value.len() <= 35
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err("Invalid language for Apple Translation.".into());
    }
    std::ffi::CString::new(value).map_err(|_| "Invalid language for Apple Translation.".into())
}

pub fn not_ready_message(availability: Availability, source: &str, target: &str) -> String {
    match availability {
        Availability::Installed => String::new(),
        Availability::Supported => format!(
            "Apple Translation language not installed ({source} → {target}). Install it in {INSTALL_PATH}"
        ),
        Availability::Unsupported => format!(
            "Apple Translation does not support {source} → {target}. Choose ChatGPT or a cloud engine."
        ),
    }
}

fn error_message(code: &str, message: String, source: &str, target: &str) -> String {
    match code {
        "notInstalled" => not_ready_message(Availability::Supported, source, target),
        "unsupported" => not_ready_message(Availability::Unsupported, source, target),
        "cancelled" => "Live translation was cancelled.".into(),
        _ => format!("Apple Translation failed: {message}"),
    }
}

/// Pair availability; with `warm`, an installed pair's reusable session is created and loaded.
/// Returns the availability and whether the session was warmed.
pub async fn prepare(source: &str, target: &str, warm: bool) -> Result<(Availability, bool), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source, target, warm);
        return Err(UNAVAILABLE.into());
    }
    #[cfg(target_os = "macos")]
    {
        let (source_arg, target_arg) = (language_arg(source)?, language_arg(target)?);
        let mut request = Request::register();
        unsafe {
            ffi::md_translation_prepare(request.id, source_arg.as_ptr(), target_arg.as_ptr(), warm, receive);
        }
        match request.wait(Duration::from_secs(30), &CancellationToken::new()).await? {
            Event::Status { status, warmed } => Ok((status, warmed)),
            Event::Error { code, message } => Err(error_message(&code, message, source, target)),
            Event::Translated { .. } => Err("Apple Translation returned an unexpected response.".into()),
        }
    }
}

/// Translate one caption with the pair's reusable session. Cancelling returns at once and
/// cancels the native task; a late native answer is dropped.
pub async fn translate(
    source: &str,
    target: &str,
    text: &str,
    cancel: &CancellationToken,
) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source, target, text, cancel);
        return Err(UNAVAILABLE.into());
    }
    #[cfg(target_os = "macos")]
    {
        let (source_arg, target_arg) = (language_arg(source)?, language_arg(target)?);
        let text_arg = std::ffi::CString::new(text.replace('\0', ""))
            .map_err(|_| "Invalid text for Apple Translation.".to_string())?;
        let mut request = Request::register();
        unsafe {
            ffi::md_translation_translate(
                request.id,
                source_arg.as_ptr(),
                target_arg.as_ptr(),
                text_arg.as_ptr(),
                receive,
            );
        }
        match request.wait(Duration::from_secs(10), cancel).await? {
            Event::Translated { text } => Ok(text),
            Event::Error { code, message } => Err(error_message(&code, message, source, target)),
            Event::Status { .. } => Err("Apple Translation returned an unexpected response.".into()),
        }
    }
}

/// Drops the cached per-pair sessions. Only the on-device measurement uses it
/// (`tools/apple_translation_check.rs`) to compare a new session with a reused one.
#[doc(hidden)]
pub fn reset_sessions() {
    #[cfg(target_os = "macos")]
    unsafe {
        ffi::md_translation_reset();
    }
}

/// Opens the Language & Region pane that holds "Translation Languages…". Never downloads.
#[tauri::command]
pub async fn apple_translation_open_settings() -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Err(UNAVAILABLE.into());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(SETTINGS_URL)
            .spawn()
            .map_err(|e| format!("Failed to open System Settings: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bridge_events() {
        let status: Event =
            serde_json::from_str(r#"{"kind":"status","status":"supported","warmed":false}"#).unwrap();
        assert!(matches!(
            status,
            Event::Status {
                status: Availability::Supported,
                warmed: false
            }
        ));
        let error: Event =
            serde_json::from_str(r#"{"kind":"error","code":"notInstalled","message":"x"}"#).unwrap();
        assert!(matches!(error, Event::Error { .. }));
    }

    #[test]
    fn not_installed_points_to_system_settings() {
        let message = error_message("notInstalled", String::new(), "es", "en");
        assert!(message.contains("not installed"), "{message}");
        assert!(message.contains("Language & Region › Translation Languages"), "{message}");
        assert!(error_message("unsupported", String::new(), "bn", "en").contains("does not support"));
    }

    #[test]
    fn registration_is_removed_on_drop() {
        let request = Request::register();
        let id = request.id;
        assert!(CALLBACKS.lock().unwrap().contains_key(&id));
        drop(request);
        assert!(!CALLBACKS.lock().unwrap().contains_key(&id));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn cancellation_returns_immediately_and_forgets_the_request() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let before = NEXT_ID.load(Ordering::Relaxed);
        let error = translate("es", "en", "Hola", &cancel).await.unwrap_err();
        assert!(error.contains("cancelled"), "{error}");
        let map = CALLBACKS.lock().unwrap();
        assert!((before..NEXT_ID.load(Ordering::Relaxed)).all(|id| !map.contains_key(&id)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn language_arguments_are_bounded() {
        for bad in ["", "en us", "en\0", &"x".repeat(40)] {
            assert!(language_arg(bad).is_err(), "{bad:?}");
        }
        assert!(language_arg("zh-Hant_TW").is_ok());
    }
}
