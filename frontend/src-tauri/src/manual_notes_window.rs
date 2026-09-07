use std::sync::{atomic::{AtomicU64, Ordering}, Mutex};
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Runtime, Size,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const MANUAL_NOTES_WINDOW: &str = "manual-notes";
static TARGET: Mutex<Option<NotesWindowTarget>> = Mutex::new(None);
static TARGET_VERSION: AtomicU64 = AtomicU64::new(0);
static OPEN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesWindowTarget { meeting_id: String, note_id: Option<String>, version: u64 }

fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn dock_notes_window_to_main<R: Runtime>(app: &AppHandle<R>, notes_window: &WebviewWindow<R>) {
    let _ = notes_window.unmaximize();
    let _ = notes_window.set_fullscreen(false);

    if let Some(main_win) = app.get_webview_window("main") {
        if let (Ok(main_pos), Ok(main_size)) = (main_win.outer_position(), main_win.outer_size()) {
            let scale = main_win.scale_factor().unwrap_or(1.0);
            let notes_width_logical = 440.0_f64;
            let notes_width_physical = (notes_width_logical * scale).round() as u32;
            let notes_height_physical = main_size.height.max((480.0 * scale).round() as u32);

            let mut target_x = main_pos.x + main_size.width as i32;
            let target_y = main_pos.y;

            if let Ok(Some(monitor)) = main_win.current_monitor() {
                let mon_pos = monitor.position();
                let mon_size = monitor.size();
                let max_x = mon_pos.x + mon_size.width as i32;
                if target_x + notes_width_physical as i32 > max_x {
                    // Dock flush to the right edge of the current display
                    target_x = max_x - notes_width_physical as i32;
                }
            }

            let _ = notes_window.set_size(Size::Physical(PhysicalSize {
                width: notes_width_physical,
                height: notes_height_physical,
            }));
            let _ = notes_window.set_position(Position::Physical(PhysicalPosition {
                x: target_x,
                y: target_y,
            }));
        }
    }
}

#[tauri::command]
pub async fn open_manual_notes_window<R: Runtime>(app: AppHandle<R>, meeting_id: String, note_id: Option<String>) -> Result<(), String> {
    if !is_safe_id(&meeting_id) || note_id.as_deref().is_some_and(|id| !is_safe_id(id)) {
        return Err("Invalid meeting or note ID".into());
    }
    let _opening = OPEN_LOCK.lock().await;
    let target = NotesWindowTarget { meeting_id: meeting_id.clone(), note_id: note_id.clone(), version: TARGET_VERSION.fetch_add(1, Ordering::SeqCst) + 1 };
    *TARGET.lock().map_err(|_| "Notes window state is unavailable")? = Some(target);
    if let Some(window) = app.get_webview_window(MANUAL_NOTES_WINDOW) {
        dock_notes_window_to_main(&app, &window);
        // The page reads the latest target after subscribing, so a cold window
        // cannot lose an event and display the wrong note. It saves before switching.
        let _ = window.emit("manual-notes:target-changed", ());
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = format!("manual-notes?meetingId={meeting_id}{}", note_id.map(|id| format!("&noteId={id}")).unwrap_or_default());
    let builder = WebviewWindowBuilder::new(&app, MANUAL_NOTES_WINDOW, WebviewUrl::App(url.into()))
        .title("MeetOdds — Notes")
        .inner_size(440.0, 780.0)
        .min_inner_size(340.0, 480.0)
        .maximized(false)
        .always_on_top(false)
        .visible_on_all_workspaces(false)
        .resizable(true);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    let window = builder.build().map_err(|e| e.to_string())?;
    dock_notes_window_to_main(&app, &window);
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            // Do not hide before SQLite acknowledges the current draft.
            if let Some(w) = handle.get_webview_window(MANUAL_NOTES_WINDOW) {
                let _ = w.emit("manual-notes:request-close", ());
            }
        }
    });
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_manual_notes_window_target<R: Runtime>(app: AppHandle<R>) -> Result<Option<NotesWindowTarget>, String> {
    if app.get_webview_window(MANUAL_NOTES_WINDOW).is_none() { return Ok(None); }
    Ok(TARGET.lock().map_err(|_| "Notes window state is unavailable")?.clone())
}

#[tauri::command]
pub async fn toggle_manual_notes_fullscreen<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let window = app.get_webview_window(MANUAL_NOTES_WINDOW).ok_or("The notes window is not open")?;
    let fullscreen = !window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(fullscreen).map_err(|e| e.to_string())?;
    Ok(fullscreen)
}

#[tauri::command]
pub async fn close_manual_notes_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MANUAL_NOTES_WINDOW) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
