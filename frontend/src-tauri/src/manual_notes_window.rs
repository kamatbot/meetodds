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

struct SavedMainState {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    was_maximized: bool,
}

static PREV_MAIN_STATE: Mutex<Option<SavedMainState>> = Mutex::new(None);

pub fn restore_main_window_if_needed<R: Runtime>(app: &AppHandle<R>) {
    let state = {
        let mut lock = PREV_MAIN_STATE.lock().unwrap();
        lock.take()
    };
    if let Some(state) = state {
        if let Some(main_win) = app.get_webview_window("main") {
            if state.was_maximized {
                let _ = main_win.maximize();
            } else {
                let _ = main_win.set_position(Position::Physical(state.position));
                let _ = main_win.set_size(Size::Physical(state.size));
            }
        }
    }
}

pub fn on_main_window_moved<R: Runtime>(app: &AppHandle<R>, new_main_pos: PhysicalPosition<i32>) {
    if let Some(notes_win) = app.get_webview_window(MANUAL_NOTES_WINDOW) {
        if notes_win.is_visible().unwrap_or(false) {
            if let Some(main_win) = app.get_webview_window("main") {
                if let Ok(main_size) = main_win.outer_size() {
                    let notes_x = new_main_pos.x + main_size.width as i32;
                    let notes_y = new_main_pos.y;
                    let _ = notes_win.set_position(Position::Physical(PhysicalPosition {
                        x: notes_x,
                        y: notes_y,
                    }));
                }
            }
        }
    }
}

pub fn on_main_window_resized<R: Runtime>(app: &AppHandle<R>, new_main_size: PhysicalSize<u32>) {
    if let Some(notes_win) = app.get_webview_window(MANUAL_NOTES_WINDOW) {
        if notes_win.is_visible().unwrap_or(false) {
            if let Some(main_win) = app.get_webview_window("main") {
                if let Ok(main_pos) = main_win.outer_position() {
                    let notes_x = main_pos.x + new_main_size.width as i32;
                    let _ = notes_win.set_position(Position::Physical(PhysicalPosition {
                        x: notes_x,
                        y: main_pos.y,
                    }));
                    if let Ok(notes_size) = notes_win.outer_size() {
                        let _ = notes_win.set_size(Size::Physical(PhysicalSize {
                            width: notes_size.width,
                            height: new_main_size.height,
                        }));
                    }
                }
            }
        }
    }
}

pub fn dock_notes_window_to_main<R: Runtime>(app: &AppHandle<R>, notes_window: &WebviewWindow<R>) {
    let _ = notes_window.unmaximize();
    let _ = notes_window.set_fullscreen(false);

    if let Some(main_win) = app.get_webview_window("main") {
        if main_win.is_fullscreen().unwrap_or(false) {
            let _ = main_win.set_fullscreen(false);
        }

        if let (Ok(main_pos), Ok(main_size)) = (main_win.outer_position(), main_win.outer_size()) {
            let was_maximized = main_win.is_maximized().unwrap_or(false);
            if was_maximized {
                let _ = main_win.unmaximize();
            }

            // Save previous un-docked state if not already saved
            {
                let mut lock = PREV_MAIN_STATE.lock().unwrap();
                if lock.is_none() {
                    *lock = Some(SavedMainState {
                        position: main_pos,
                        size: main_size,
                        was_maximized,
                    });
                }
            }

            let scale = main_win.scale_factor().unwrap_or(1.0);
            let notes_width_logical = 400.0_f64;
            let notes_width_physical = (notes_width_logical * scale).round() as u32;

            if let Ok(Some(monitor)) = main_win.current_monitor() {
                let mon_pos = monitor.position();
                let mon_size = monitor.size();
                let mon_min_x = mon_pos.x;
                let mon_max_x = mon_pos.x + mon_size.width as i32;

                let min_main_width = (640.0 * scale).round() as u32;
                let min_notes_width = (320.0 * scale).round() as u32;

                let desired_notes_x = main_pos.x + main_size.width as i32;
                let desired_notes_end_x = desired_notes_x + notes_width_physical as i32;

                let (final_main_x, final_main_w, final_notes_x, final_notes_w) = if desired_notes_end_x <= mon_max_x {
                    // Plenty of room on the right: dock side-by-side with no resize
                    (main_pos.x, main_size.width, desired_notes_x, notes_width_physical)
                } else {
                    let total_width = main_size.width + notes_width_physical;
                    if total_width <= mon_size.width {
                        // Monitor fits both: shift main_win left so both fit without overlap
                        let shifted_main_x = mon_max_x - total_width as i32;
                        let clamped_main_x = shifted_main_x.max(mon_min_x);
                        let notes_x = clamped_main_x + main_size.width as i32;
                        (clamped_main_x, main_size.width, notes_x, notes_width_physical)
                    } else {
                        // Monitor cannot fit both unresized: resize main_win so both fit flush
                        let new_main_x = mon_min_x;
                        let available_w = mon_size.width;
                        let actual_notes_w = if available_w.saturating_sub(notes_width_physical) < min_main_width {
                            available_w.saturating_sub(min_main_width).max(min_notes_width)
                        } else {
                            notes_width_physical
                        };
                        let actual_main_w = available_w.saturating_sub(actual_notes_w);
                        let notes_x = new_main_x + actual_main_w as i32;
                        (new_main_x, actual_main_w, notes_x, actual_notes_w)
                    }
                };

                let target_y = main_pos.y;
                let target_h = main_size.height;

                // Apply geometry to main_win if position or width changed
                if final_main_x != main_pos.x || final_main_w != main_size.width {
                    let _ = main_win.set_position(Position::Physical(PhysicalPosition {
                        x: final_main_x,
                        y: target_y,
                    }));
                    let _ = main_win.set_size(Size::Physical(PhysicalSize {
                        width: final_main_w,
                        height: target_h,
                    }));
                }

                // Apply geometry to notes_window
                let _ = notes_window.set_size(Size::Physical(PhysicalSize {
                    width: final_notes_w,
                    height: target_h,
                }));
                let _ = notes_window.set_position(Position::Physical(PhysicalPosition {
                    x: final_notes_x,
                    y: target_y,
                }));
            }
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
        .inner_size(400.0, 780.0)
        .min_inner_size(320.0, 480.0)
        .visible(false)
        .maximized(false)
        .always_on_top(false)
        .visible_on_all_workspaces(false)
        .resizable(true);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    let window = builder.build().map_err(|e| e.to_string())?;
    dock_notes_window_to_main(&app, &window);
    window.show().map_err(|e| e.to_string())?;
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
        restore_main_window_if_needed(&app);
    }
    Ok(())
}
