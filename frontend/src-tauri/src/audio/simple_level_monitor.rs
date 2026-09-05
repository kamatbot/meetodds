//! Compatibility meter backed by bounded real-source probes; never synthesizes activity.
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use tauri::{AppHandle, Runtime};
use tokio_util::sync::CancellationToken;

static IS_MONITORING: AtomicBool = AtomicBool::new(false);
static SESSION: Lazy<Mutex<Option<CancellationToken>>> = Lazy::new(|| Mutex::new(None));

pub async fn start_monitoring<R: Runtime>(app: AppHandle<R>, device_names: Vec<String>) -> Result<()> {
    if IS_MONITORING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err(anyhow!("An audio test is already running. Stop it before testing again."));
    }
    let token = CancellationToken::new();
    if let Ok(mut session) = SESSION.lock() { *session = Some(token.clone()); }
    else { IS_MONITORING.store(false, Ordering::SeqCst); return Err(anyhow!("Audio test state unavailable")); }
    // A bounded test is not a continuing recording. Every stream is dropped when the probe ends.
    let result = super::capture_preflight::probe_named_sources(&app, device_names, token).await;
    if let Ok(mut session) = SESSION.lock() { session.take(); }
    IS_MONITORING.store(false, Ordering::SeqCst);
    result
}
pub async fn stop_monitoring() -> Result<()> {
    if let Ok(session) = SESSION.lock() { if let Some(token) = session.as_ref() { token.cancel(); } }
    // The in-flight probe owns cleanup and changes the flag after releasing its streams.
    Ok(())
}
pub fn is_monitoring() -> bool { IS_MONITORING.load(Ordering::SeqCst) }
