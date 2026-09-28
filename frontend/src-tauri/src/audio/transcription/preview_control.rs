//! Preference + generation gate shared by snapshot production and preview inference.
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_store::StoreExt;

const ENABLED: u64 = 1;
const ACTIVE: u64 = 2;

pub(crate) struct PreviewGate(AtomicU64);
impl PreviewGate {
    pub const fn new() -> Self {
        Self(AtomicU64::new(0))
    }
    fn update(&self, bit: u64, enabled: bool) {
        let _ = self
            .0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |old| {
                if (old & bit != 0) == enabled {
                    return None;
                }
                let flags = if enabled { old | bit } else { old & !bit };
                Some(((old & !3).wrapping_add(4)) | (flags & 3))
            });
    }
    pub fn set_enabled(&self, enabled: bool) {
        self.update(ENABLED, enabled);
    }
    pub fn set_active(&self, active: bool) {
        self.update(ACTIVE, active);
    }
    /// The captions preference alone (Apple chooses partials vs finals-only from it).
    pub fn enabled(&self) -> bool {
        self.0.load(Ordering::Acquire) & ENABLED != 0
    }
    pub fn epoch(&self) -> Option<u64> {
        let state = self.0.load(Ordering::Acquire);
        (state & 3 == 3).then_some(state)
    }
    pub fn accepts(&self, epoch: u64) -> bool {
        self.epoch() == Some(epoch)
    }
}

pub(crate) static PREVIEW_GATE: PreviewGate = PreviewGate::new();
static STORE_LOCK: Mutex<()> = Mutex::new(());
const STORE: &str = "recording_preferences.json";
const KEY: &str = "live_preview_enabled";

#[tauri::command]
pub async fn get_live_preview_enabled<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| "Caption preference lock unavailable")?;
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    let enabled = store
        .get(KEY)
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    PREVIEW_GATE.set_enabled(enabled);
    Ok(enabled)
}

#[tauri::command]
pub async fn set_live_preview_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| "Caption preference lock unavailable")?;
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    let previous = store.get(KEY);
    store.set(KEY, serde_json::json!(enabled));
    if let Err(error) = store.save() {
        match previous {
            Some(value) => store.set(KEY, value),
            None => {
                store.delete(KEY);
            }
        }
        return Err(format!("Could not save live caption preference: {error}"));
    }
    PREVIEW_GATE.set_enabled(enabled);
    if !enabled {
        let _ = app.emit(
            "live-transcript-preview-clear",
            serde_json::json!({"source": null}),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_off_at_start_never_admits_snapshots_or_decodes() {
        let gate = PreviewGate::new();
        gate.set_active(true);
        assert!(gate.epoch().is_none());
        gate.set_enabled(false);
        for _ in 0..10_000 {
            assert!(gate.epoch().is_none());
        }
    }
    #[test]
    fn preview_toggle_and_pause_invalidate_in_flight_work() {
        let gate = PreviewGate::new();
        gate.set_enabled(true);
        gate.set_active(true);
        let first = gate.epoch().unwrap();
        gate.set_enabled(true);
        assert!(gate.accepts(first));
        gate.set_enabled(false);
        assert!(!gate.accepts(first));
        gate.set_enabled(true);
        assert!(!gate.accepts(first));
        let second = gate.epoch().unwrap();
        gate.set_active(false);
        assert!(!gate.accepts(second));
        gate.set_active(true);
        assert!(!gate.accepts(second));
        assert!(gate.epoch().is_some());
    }
}
