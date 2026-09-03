use chrono::{Duration as ChronoDuration, Utc};
use serde::Serialize;
use std::time::Duration;
use tauri::State;

use crate::{
    database::{
        models::{MeetingListPage, MeetingListRequest},
        repositories::meeting::MeetingsRepository,
    },
    state::AppState,
};

const DELETE_UNDO_SECONDS: u64 = 8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeferredDeleteResponse {
    pub meeting_id: String,
    pub undo_until: String,
}

#[tauri::command]
pub async fn api_list_meetings(
    state: State<'_, AppState>,
    request: MeetingListRequest,
) -> Result<MeetingListPage, String> {
    MeetingsRepository::list_meetings(state.db_manager.pool(), &request)
        .await
        .map_err(|error| {
            log::error!("Failed to list meetings: {}", error);
            format!("Failed to list meetings: {error}")
        })
}

#[tauri::command]
pub async fn api_rename_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
    title: String,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Meeting title cannot be empty".to_string());
    }

    match MeetingsRepository::update_meeting_title(state.db_manager.pool(), &meeting_id, title).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!("Meeting not found: {meeting_id}")),
        Err(error) => Err(format!("Failed to rename meeting: {error}")),
    }
}

#[tauri::command]
pub async fn api_set_meeting_starred(
    state: State<'_, AppState>,
    meeting_id: String,
    starred: bool,
) -> Result<(), String> {
    match MeetingsRepository::set_starred(state.db_manager.pool(), &meeting_id, starred).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!("Meeting not found: {meeting_id}")),
        Err(error) => Err(format!("Failed to update starred state: {error}")),
    }
}

#[tauri::command]
pub async fn api_defer_delete_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<DeferredDeleteResponse, String> {
    let marker = MeetingsRepository::defer_delete_meeting(state.db_manager.pool(), &meeting_id)
        .await
        .map_err(|error| format!("Failed to schedule meeting deletion: {error}"))?
        .ok_or_else(|| format!("Meeting not found or already pending deletion: {meeting_id}"))?;

    let undo_until = (Utc::now() + ChronoDuration::seconds(DELETE_UNDO_SECONDS as i64)).to_rfc3339();
    let db_manager = state.db_manager.clone();
    let meeting_id_for_task = meeting_id.clone();
    let marker_for_task = marker.clone();

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(DELETE_UNDO_SECONDS)).await;
        match MeetingsRepository::finalize_deferred_delete(
            db_manager.pool(),
            &meeting_id_for_task,
            &marker_for_task,
        )
        .await
        {
            Ok(true) => log::info!(
                "Finalized deferred deletion for meeting {}",
                meeting_id_for_task
            ),
            Ok(false) => log::info!(
                "Deferred deletion for meeting {} was restored or superseded",
                meeting_id_for_task
            ),
            Err(error) => log::error!(
                "Failed to finalize deferred deletion for meeting {}: {}",
                meeting_id_for_task,
                error
            ),
        }
    });

    Ok(DeferredDeleteResponse {
        meeting_id,
        undo_until,
    })
}

#[tauri::command]
pub async fn api_restore_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<(), String> {
    match MeetingsRepository::restore_deferred_delete(state.db_manager.pool(), &meeting_id).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!("Meeting is not pending deletion: {meeting_id}")),
        Err(error) => Err(format!("Failed to restore meeting: {error}")),
    }
}
