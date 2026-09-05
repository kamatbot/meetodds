use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const MANUAL_NOTES_WINDOW: &str = "manual-notes";

/// Meeting ids are generated as `meeting-<digits>` (see TranscriptContext.tsx). Validate
/// rather than percent-encode so we don't need a new crate for the query string.
fn is_safe_meeting_id(meeting_id: &str) -> bool {
    !meeting_id.is_empty()
        && meeting_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
pub async fn open_manual_notes_window<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
) -> Result<(), String> {
    if !is_safe_meeting_id(&meeting_id) {
        return Err("Invalid meeting id".to_string());
    }

    if let Some(window) = app.get_webview_window(MANUAL_NOTES_WINDOW) {
        let _ = window.emit("manual-notes:set-meeting", &meeting_id);
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = format!("manual-notes?meetingId={}", meeting_id);
    let builder = WebviewWindowBuilder::new(&app, MANUAL_NOTES_WINDOW, WebviewUrl::App(url.into()))
        .title("Meeting notes")
        .inner_size(380.0, 320.0)
        .min_inner_size(280.0, 200.0)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .resizable(true);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // tauri 2.11 (resolved from the "2.6.2" Cargo.toml requirement) only exposes
    // `on_window_event` on the built `WebviewWindow`, not on the builder, so the
    // close-hides-instead-of-closes handler is registered after `build()`.
    let window = builder.build().map_err(|e| e.to_string())?;

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Closing hides; the window is reused for the rest of the app session.
            api.prevent_close();
            if let Some(w) = handle.get_webview_window(MANUAL_NOTES_WINDOW) {
                let _ = w.hide();
            }
        }
    });

    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
pub async fn close_manual_notes_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MANUAL_NOTES_WINDOW) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
