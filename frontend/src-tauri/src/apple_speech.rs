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
/// Spoken language used when neither a saved choice nor a supported system language exists.
pub const DEFAULT_LOCALE: &str = "en_US";
#[cfg(not(target_os = "macos"))]
const UNAVAILABLE: &str = "Apple Speech requires macOS 26 or later and supported hardware.";

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
    /// Supported locale closest to the macOS system language, if any.
    #[serde(default)]
    pub system_locale: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpeechEvent {
    Capabilities {
        available: bool,
        reason: Option<String>,
        locales: Vec<SpeechLocale>,
        #[serde(rename = "systemLocale", default)]
        system_locale: Option<String>,
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
        pub fn md_speech_start(id: u64, locale: *const c_char, callback: Callback);
        pub fn md_speech_push(
            id: u64,
            samples: *const f32,
            count: u32,
            sample_rate: u32,
            timestamp: f64,
        ) -> bool;
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
                "Apple Speech did not respond in time. Try again."
                    .into(),
            ),
        }
    }

    pub async fn start(locale: &str) -> Result<Self, String> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = locale;
            return Err(UNAVAILABLE.into());
        }
        #[cfg(target_os = "macos")]
        {
            let locale = locale_string(locale)?;
            let mut session = Self::register();
            unsafe {
                ffi::md_speech_start(session.id, locale.as_ptr(), receive);
            }
            match session.next(Duration::from_secs(30)).await? {
                SpeechEvent::Ready { .. } => Ok(session),
                _ => Err("Apple Speech did not initialize a recognition session.".into()),
            }
        }
    }

    pub fn push(&self, samples: &[f32], rate: u32, timestamp: f64) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }
        if rate == 0
            || !timestamp.is_finite()
            || timestamp < 0.0
            || samples.len() > u32::MAX as usize
        {
            return Err("Invalid audio format or timestamp for Apple Speech.".into());
        }
        #[cfg(target_os = "macos")]
        if unsafe {
            ffi::md_speech_push(
                self.id,
                samples.as_ptr(),
                samples.len() as u32,
                rate,
                timestamp,
            )
        } {
            return Ok(());
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
            system_locale: None,
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
                system_locale,
            } => Ok(Capabilities {
                available,
                reason,
                locales,
                system_locale,
            }),
            _ => Err("Could not read Apple Speech availability.".into()),
        }
    }
}

/// Default spoken language: the closest supported system language, else en_US.
/// Used for fresh installs and for configs saved by older engines.
pub async fn default_locale() -> String {
    pick_default_locale(apple_speech_capabilities().await.ok().and_then(|c| c.system_locale))
}

/// Locale saved for Apple Speech, if any. Configs from older engines (localWhisper,
/// parakeet, cloud providers) carry no Apple locale and use `default_locale()`.
pub fn saved_locale(provider: &str, model: &str) -> Option<String> {
    (provider == PROVIDER && !model.trim().is_empty()).then(|| model.to_string())
}

fn pick_default_locale(system_locale: Option<String>) -> String {
    system_locale
        .filter(|locale| !locale.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_LOCALE.to_string())
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

// ---------------------------------------------------------------------------
// File transcription (imports and meeting re-transcription)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
extern "C" {
    fn md_speech_transcribe_file(
        id: u64,
        path: *const std::ffi::c_char,
        locale: *const std::ffi::c_char,
        callback: ffi::Callback,
    );
    fn md_speech_file_cancel(id: u64);
}

/// One offline file job. Dropping it cancels recognition and unregisters the callback.
struct FileJob {
    id: u64,
    events: mpsc::Receiver<SpeechEvent>,
}

impl Drop for FileJob {
    fn drop(&mut self) {
        if let Ok(mut callbacks) = CALLBACKS.lock() {
            callbacks.remove(&self.id);
        }
        #[cfg(target_os = "macos")]
        unsafe {
            md_speech_file_cancel(self.id);
        }
    }
}

/// Transcribes a local audio file on-device with the offline preset.
/// Returns final segments as (text, start_ms, end_ms). `progress` receives the audio
/// time (seconds) reached so far; `cancelled` is polled while waiting.
pub async fn transcribe_file(
    path: &std::path::Path,
    locale: &str,
    mut progress: impl FnMut(f64),
    cancelled: impl Fn() -> bool,
) -> Result<Vec<(String, f64, f64)>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, locale, &mut progress, &cancelled);
        return Err(UNAVAILABLE.into());
    }
    #[cfg(target_os = "macos")]
    {
        let locale = locale_string(locale)?;
        let path = std::ffi::CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| "Invalid audio file path.".to_string())?;
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        // Offline results arrive faster than real time; give them a deeper queue.
        let (sender, events) = mpsc::channel(4096);
        CALLBACKS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, sender);
        let mut job = FileJob { id, events };
        unsafe {
            md_speech_transcribe_file(id, path.as_ptr(), locale.as_ptr(), receive);
        }
        let mut segments = Vec::new();
        let mut idle = Duration::ZERO;
        let tick = Duration::from_millis(250);
        loop {
            if cancelled() {
                return Err("Transcription cancelled".into());
            }
            match tokio::time::timeout(tick, job.events.recv()).await {
                Err(_) => {
                    idle += tick;
                    // ponytail: fixed inactivity limit; long silent stretches still emit no results.
                    if idle > Duration::from_secs(600) {
                        return Err("Apple Speech stopped responding while transcribing this audio.".into());
                    }
                }
                Ok(None) => {
                    return Err("Apple Speech stopped responding or fell behind.".into());
                }
                Ok(Some(event)) => {
                    idle = Duration::ZERO;
                    match event {
                        SpeechEvent::Result { text, start, end, .. } => {
                            progress(end);
                            let text = text.trim();
                            if !text.is_empty() {
                                segments.push((text.to_string(), start * 1000.0, end * 1000.0));
                            }
                        }
                        SpeechEvent::Error { message } => return Err(message),
                        SpeechEvent::Finished => return Ok(segments),
                        _ => {}
                    }
                }
            }
        }
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
    fn default_locale_prefers_supported_system_language() {
        assert_eq!(pick_default_locale(Some("fr_FR".into())), "fr_FR");
        assert_eq!(pick_default_locale(Some(" ".into())), DEFAULT_LOCALE);
        assert_eq!(pick_default_locale(None), DEFAULT_LOCALE);
    }
    #[test]
    fn legacy_transcript_configs_map_to_apple_default() {
        assert_eq!(saved_locale(PROVIDER, "de_DE").as_deref(), Some("de_DE"));
        for (provider, model) in [("localWhisper", "small-q5_1"), ("parakeet", "parakeet-tdt-0.6b-v3-int8"), ("deepgram", "nova"), (PROVIDER, "")] {
            assert_eq!(saved_locale(provider, model), None, "{provider}");
        }
    }
    #[test]
    fn capabilities_without_system_locale_still_parse() {
        let event: SpeechEvent = serde_json::from_str(
            r#"{"kind":"capabilities","available":false,"reason":"x","locales":[]}"#,
        )
        .unwrap();
        assert!(matches!(event, SpeechEvent::Capabilities { system_locale: None, .. }));
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
        let mut session = SpeechSession::start(&locale.id).await.unwrap();
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
