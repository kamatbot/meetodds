//! Local-only Apple Speech bridge. Numeric callback IDs avoid foreign ownership of Rust pointers.
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
use tokio::sync::mpsc;

pub const PROVIDER: &str = "appleSpeech";
#[cfg(not(target_os = "macos"))]
const UNAVAILABLE: &str = "Apple Speech requires macOS 26 or later and supported hardware. Choose Whisper or Parakeet on this Mac.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeechLocale {
    pub id: String,
    pub name: String,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capabilities {
    pub available: bool,
    pub reason: Option<String>,
    pub locales: Vec<SpeechLocale>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpeechEvent {
    Capabilities {
        available: bool,
        reason: Option<String>,
        locales: Vec<SpeechLocale>,
    },
    Ready {
        locale: String,
    },
    Result {
        text: String,
        start: f64,
        end: f64,
        #[serde(rename = "isFinal")]
        is_final: bool,
    },
    Error {
        message: String,
    },
    Finished,
}

// Bounded callbacks: overload closes the stream and is reported, never silently loses final text.
static CALLBACKS: Lazy<Mutex<HashMap<u64, mpsc::Sender<SpeechEvent>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[cfg(target_os = "macos")]
mod ffi {
    use std::ffi::c_char;
    pub type Callback = extern "C" fn(u64, *const c_char);
    extern "C" {
        pub fn md_speech_capabilities(id: u64, callback: Callback);
        pub fn md_speech_prepare(
            id: u64,
            locale: *const c_char,
            download: bool,
            callback: Callback,
        );
        pub fn md_speech_start(id: u64, locale: *const c_char, partials: bool, callback: Callback);
        /// 0 = accepted, 1 = queue full (session keeps running), 2 = closed/invalid.
        pub fn md_speech_push(
            id: u64,
            samples: *const f32,
            count: u32,
            sample_rate: u32,
            timestamp: f64,
        ) -> i32;
        pub fn md_speech_finish(id: u64);
        pub fn md_speech_cancel(id: u64);
    }
}

#[cfg(target_os = "macos")]
extern "C" fn receive(id: u64, json: *const std::ffi::c_char) {
    if json.is_null() {
        return;
    }
    // Swift owns the string only for this call. Deserialize/copy before returning.
    let event = unsafe { std::ffi::CStr::from_ptr(json) }.to_bytes();
    let event = serde_json::from_slice(event).unwrap_or_else(|_| SpeechEvent::Error {
        message:
            "Apple Speech returned an invalid response. Audio remains in the recording folder."
                .into(),
    });
    if let Ok(mut callbacks) = CALLBACKS.lock() {
        if let Some(sender) = callbacks.get(&id) {
            if sender.try_send(event).is_err() {
                callbacks.remove(&id);
            }
        }
    }
}

pub struct SpeechSession {
    id: u64,
    pub events: mpsc::Receiver<SpeechEvent>,
}

impl Drop for SpeechSession {
    fn drop(&mut self) {
        if let Ok(mut callbacks) = CALLBACKS.lock() {
            callbacks.remove(&self.id);
        }
        #[cfg(target_os = "macos")]
        unsafe {
            ffi::md_speech_cancel(self.id);
        }
    }
}

impl SpeechSession {
    fn register() -> Self {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (sender, events) = mpsc::channel(256);
        CALLBACKS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, sender);
        Self { id, events }
    }

    async fn next(&mut self, timeout: Duration) -> Result<SpeechEvent, String> {
        match tokio::time::timeout(timeout, self.events.recv()).await {
            Ok(Some(SpeechEvent::Error { message })) => Err(message),
            Ok(Some(event)) => Ok(event),
            Ok(None) => Err(
                "Apple Speech stopped responding or fell behind. The saved audio is retained."
                    .into(),
            ),
            Err(_) => Err(
                "Apple Speech did not respond in time. Try again or choose Whisper or Parakeet."
                    .into(),
            ),
        }
    }

    /// `partials: false` requests finals only (no volatile results).
    pub async fn start(locale: &str, partials: bool) -> Result<Self, String> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (locale, partials);
            return Err(UNAVAILABLE.into());
        }
        #[cfg(target_os = "macos")]
        {
            let locale = locale_string(locale)?;
            let mut session = Self::register();
            unsafe {
                ffi::md_speech_start(session.id, locale.as_ptr(), partials, receive);
            }
            match session.next(Duration::from_secs(30)).await? {
                SpeechEvent::Ready { .. } => Ok(session),
                _ => Err("Apple Speech did not initialize a recognition session.".into()),
            }
        }
    }

    /// `Ok(false)`: the session's input queue (~10 s of audio) is full and this audio was
    /// not accepted; the session itself keeps running.
    pub fn push(&self, samples: &[f32], rate: u32, timestamp: f64) -> Result<bool, String> {
        if samples.is_empty() {
            return Ok(true);
        }
        if rate == 0
            || !timestamp.is_finite()
            || timestamp < 0.0
            || samples.len() > u32::MAX as usize
        {
            return Err("Invalid audio format or timestamp for Apple Speech.".into());
        }
        #[cfg(target_os = "macos")]
        match unsafe {
            ffi::md_speech_push(
                self.id,
                samples.as_ptr(),
                samples.len() as u32,
                rate,
                timestamp,
            )
        } {
            0 => return Ok(true),
            1 => return Ok(false),
            _ => {}
        }
        Err("Apple Speech could not accept audio. Stop and retry transcription from the saved recording.".into())
    }

    pub fn finish(&self) {
        #[cfg(target_os = "macos")]
        unsafe {
            ffi::md_speech_finish(self.id);
        }
    }
}

#[cfg(target_os = "macos")]
fn locale_string(locale: &str) -> Result<std::ffi::CString, String> {
    if locale.trim().is_empty() || locale == "auto" || locale.len() > 80 {
        return Err("Choose a spoken language for Apple Speech in Transcription settings.".into());
    }
    std::ffi::CString::new(locale).map_err(|_| "Invalid Apple Speech language.".into())
}

#[tauri::command]
pub async fn apple_speech_capabilities() -> Result<Capabilities, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Ok(Capabilities {
            available: false,
            reason: Some(UNAVAILABLE.into()),
            locales: vec![],
        });
    }
    #[cfg(target_os = "macos")]
    {
        let mut request = SpeechSession::register();
        unsafe {
            ffi::md_speech_capabilities(request.id, receive);
        }
        match request.next(Duration::from_secs(15)).await? {
            SpeechEvent::Capabilities {
                available,
                reason,
                locales,
            } => Ok(Capabilities {
                available,
                reason,
                locales,
            }),
            _ => Err("Could not read Apple Speech availability.".into()),
        }
    }
}

pub async fn prepare(locale: &str, download: bool) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (locale, download);
        return Err(UNAVAILABLE.into());
    }
    #[cfg(target_os = "macos")]
    {
        let locale = locale_string(locale)?;
        let mut request = SpeechSession::register();
        unsafe {
            ffi::md_speech_prepare(request.id, locale.as_ptr(), download, receive);
        }
        let timeout = if download {
            Duration::from_secs(900)
        } else {
            Duration::from_secs(30)
        };
        match request.next(timeout).await? {
            SpeechEvent::Ready { locale } => Ok(locale),
            _ => Err("Apple Speech language is not ready.".into()),
        }
    }
}

#[tauri::command]
pub async fn apple_speech_prepare(locale: String) -> Result<String, String> {
    let _guard = crate::audio::common::acquire_engine_lifecycle_lock().await;
    if crate::audio::recording_commands::is_recording().await {
        return Err("Stop recording before preparing another speech language.".into());
    }
    prepare(&locale, true).await
}

/// Short utterances used by language practice share the existing provider trait.
/// Meeting capture never uses this batch adapter: it keeps continuous sessions open.
pub(crate) struct AppleSpeechProvider {
    pub locale: String,
}

#[async_trait::async_trait]
impl crate::audio::transcription::provider::TranscriptionProvider for AppleSpeechProvider {
    async fn transcribe(
        &self,
        audio: Vec<f32>,
        language: Option<String>,
    ) -> Result<
        crate::audio::transcription::provider::TranscriptResult,
        crate::audio::transcription::provider::TranscriptionError,
    > {
        use crate::audio::transcription::provider::{TranscriptResult, TranscriptionError};
        let locale = language
            .as_deref()
            .filter(|l| !l.is_empty() && *l != "auto")
            .unwrap_or(&self.locale);
        let result = async {
            let mut session = SpeechSession::start(locale, false).await?;
            if !session.push(&audio, 16_000, 0.0)? {
                return Err("Apple Speech could not accept this audio.".into());
            }
            session.finish();
            let mut text = Vec::new();
            loop {
                match session.next(Duration::from_secs(30)).await? {
                    SpeechEvent::Result {
                        text: part,
                        is_final: true,
                        ..
                    } => text.push(part),
                    SpeechEvent::Finished => return Ok::<_, String>(text.join(" ")),
                    _ => {}
                }
            }
        }
        .await
        .map_err(TranscriptionError::EngineFailed)?;
        Ok(TranscriptResult {
            text: result,
            confidence: None,
            is_partial: false,
        })
    }
    async fn is_model_loaded(&self) -> bool {
        true
    }
    async fn get_current_model(&self) -> Option<String> {
        Some(self.locale.clone())
    }
    fn provider_name(&self) -> &'static str {
        "Apple Speech"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parse_progressive_result_contract() {
        let event: SpeechEvent = serde_json::from_str(
            r#"{"kind":"result","text":"Hello","start":0.2,"end":0.9,"isFinal":false}"#,
        )
        .unwrap();
        assert!(matches!(
            event,
            SpeechEvent::Result {
                is_final: false,
                ..
            }
        ));
    }
    #[test]
    fn registration_is_removed_on_drop() {
        let request = SpeechSession::register();
        let id = request.id;
        assert!(CALLBACKS.lock().unwrap().contains_key(&id));
        drop(request);
        assert!(!CALLBACKS.lock().unwrap().contains_key(&id));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn language_must_be_explicit_and_safe() {
        for bad in ["", "auto", "en\0US"] {
            assert!(locale_string(bad).is_err());
        }
        assert!(locale_string("en-US").is_ok());
    }

    /// Explicit hardware smoke check: no microphone, fixture audio, or downloads.
    /// Kept out of routine test runs because it needs an installed English asset.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires macOS 26+, supported hardware, and installed English speech assets"]
    async fn apple_native_empty_session_uses_rust_callback_route() {
        let capabilities = apple_speech_capabilities().await.unwrap();
        assert!(capabilities.available);
        let locale = capabilities
            .locales
            .iter()
            .find(|locale| locale.installed && locale.id.replace('_', "-") == "en-US")
            .expect("Install English (US) through Settings before this explicit smoke check");
        assert!(!prepare(&locale.id, false).await.unwrap().is_empty());
        let mut session = SpeechSession::start(&locale.id, false).await.unwrap();
        session.finish();
        assert!(matches!(
            session.next(Duration::from_secs(10)).await.unwrap(),
            SpeechEvent::Finished
        ));
        let id = session.id;
        drop(session);
        assert!(!CALLBACKS.lock().unwrap().contains_key(&id));
    }
}
