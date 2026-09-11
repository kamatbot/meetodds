use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarPermissionStatus {
    pub supported: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start_at_ms: f64,
    pub end_at_ms: f64,
    pub all_day: bool,
    pub location: Option<String>,
    pub calendar_name: Option<String>,
    pub conference_url: Option<String>,
    pub attendee_count: usize,
}

fn status_name(raw: i32) -> &'static str {
    match raw {
        0 => "notDetermined",
        1 => "restricted",
        2 => "denied",
        3 => "authorized",
        4 => "writeOnly",
        _ => "unknown",
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{status_name, CalendarEvent, CalendarPermissionStatus};
    use std::ffi::{c_char, c_double, c_int, c_void, CStr};
    use std::time::Duration;
    use tokio::sync::oneshot;

    type PermissionCallback = extern "C" fn(c_int, *const c_char, *mut c_void);

    extern "C" {
        fn meetodds_calendar_authorization_status() -> c_int;
        fn meetodds_calendar_request_access(callback: PermissionCallback, context: *mut c_void);
        fn meetodds_calendar_events_json(
            start_epoch: c_double,
            end_epoch: c_double,
            error_out: *mut *mut c_char,
        ) -> *mut c_char;
        fn meetodds_calendar_free_string(value: *mut c_char);
    }

    fn current_status() -> CalendarPermissionStatus {
        let raw = unsafe { meetodds_calendar_authorization_status() };
        CalendarPermissionStatus { supported: true, status: status_name(raw).to_string() }
    }

    fn access_error_for_status(status: &CalendarPermissionStatus, fallback: String) -> String {
        match status.status.as_str() {
            "denied" | "restricted" => "Calendar access is off. Enable MeetOdds in System Settings → Privacy & Security → Calendars.".to_string(),
            "writeOnly" => "MeetOdds has write-only calendar access, but upcoming-meeting detection needs Full Access. Change MeetOdds to Full Access in System Settings → Privacy & Security → Calendars.".to_string(),
            "notDetermined" => "macOS did not present the Calendar permission sheet. Quit and reopen this updated MeetOdds build, then press Connect again. If Calendar already appears in System Settings → Privacy & Security → Calendars, enable MeetOdds there.".to_string(),
            _ => fallback,
        }
    }

    extern "C" fn permission_callback(granted: c_int, error: *const c_char, context: *mut c_void) {
        if context.is_null() {
            return;
        }
        let sender = unsafe {
            Box::from_raw(context as *mut oneshot::Sender<Result<(), String>>)
        };
        let result = if granted != 0 {
            Ok(())
        } else if !error.is_null() {
            let message = unsafe { CStr::from_ptr(error) }.to_string_lossy().into_owned();
            Err(if message.trim().is_empty() { "Calendar access was not granted.".to_string() } else { message })
        } else {
            Err("Calendar access was not granted.".to_string())
        };
        let _ = sender.send(result);
    }

    pub fn permission_status() -> CalendarPermissionStatus {
        current_status()
    }

    pub async fn request_access() -> Result<CalendarPermissionStatus, String> {
        let status = current_status();
        if status.status == "authorized" {
            return Ok(status);
        }
        if status.status == "denied" || status.status == "restricted" {
            return Err(access_error_for_status(&status, "Calendar access is unavailable.".to_string()));
        }

        let (tx, rx) = oneshot::channel::<Result<(), String>>();
        let context = Box::into_raw(Box::new(tx)) as *mut c_void;
        unsafe { meetodds_calendar_request_access(permission_callback, context) };
        match tokio::time::timeout(Duration::from_secs(120), rx).await {
            Ok(Ok(Ok(()))) => {
                let updated = current_status();
                if updated.status == "authorized" {
                    Ok(updated)
                } else {
                    Err(access_error_for_status(
                        &updated,
                        "Calendar permission was requested, but full event access is still unavailable.".to_string(),
                    ))
                }
            }
            Ok(Ok(Err(message))) => {
                let updated = current_status();
                Err(access_error_for_status(&updated, message))
            }
            Ok(Err(_)) => Err("Calendar permission request was interrupted.".to_string()),
            Err(_) => Err("Calendar permission request timed out. Try again from MeetOdds settings.".to_string()),
        }
    }

    pub fn list_events(start_ms: f64, end_ms: f64) -> Result<Vec<CalendarEvent>, String> {
        if !start_ms.is_finite() || !end_ms.is_finite() || end_ms <= start_ms {
            return Err("Invalid calendar time range.".to_string());
        }
        // Protect EventKit from accidental giant scans. UI only needs nearby meetings.
        if end_ms - start_ms > 7.0 * 24.0 * 60.0 * 60.0 * 1000.0 {
            return Err("Calendar range is limited to seven days.".to_string());
        }

        let mut error_ptr: *mut c_char = std::ptr::null_mut();
        let json_ptr = unsafe {
            meetodds_calendar_events_json(start_ms / 1000.0, end_ms / 1000.0, &mut error_ptr)
        };
        if json_ptr.is_null() {
            let message = if error_ptr.is_null() {
                "Calendar events could not be read.".to_string()
            } else {
                let text = unsafe { CStr::from_ptr(error_ptr) }.to_string_lossy().into_owned();
                unsafe { meetodds_calendar_free_string(error_ptr) };
                text
            };
            return Err(message);
        }

        let json = unsafe { CStr::from_ptr(json_ptr) }.to_string_lossy().into_owned();
        unsafe { meetodds_calendar_free_string(json_ptr) };
        let mut events: Vec<CalendarEvent> = serde_json::from_str(&json)
            .map_err(|error| format!("Calendar events could not be decoded: {error}"))?;
        events.retain(|event| !event.all_day && event.end_at_ms > event.start_at_ms);
        events.sort_by(|left, right| left.start_at_ms.total_cmp(&right.start_at_ms));
        Ok(events)
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{CalendarEvent, CalendarPermissionStatus};

    pub fn permission_status() -> CalendarPermissionStatus {
        CalendarPermissionStatus { supported: false, status: "unsupported".to_string() }
    }

    pub async fn request_access() -> Result<CalendarPermissionStatus, String> {
        Err("Native calendar awareness is currently available on macOS.".to_string())
    }

    pub fn list_events(_start_ms: f64, _end_ms: f64) -> Result<Vec<CalendarEvent>, String> {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn calendar_get_permission_status() -> CalendarPermissionStatus {
    platform::permission_status()
}

#[tauri::command]
pub async fn calendar_request_access() -> Result<CalendarPermissionStatus, String> {
    platform::request_access().await
}

#[tauri::command]
pub async fn calendar_list_events(start_ms: f64, end_ms: f64) -> Result<Vec<CalendarEvent>, String> {
    tauri::async_runtime::spawn_blocking(move || platform::list_events(start_ms, end_ms))
        .await
        .map_err(|error| format!("Calendar query task failed: {error}"))?
}
