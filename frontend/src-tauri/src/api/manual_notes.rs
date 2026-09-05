use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use crate::state::AppState;

const MAX_CONTENT_LEN: usize = 100_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualNotesResponse {
    pub content: String,
}

pub async fn load_manual_notes(pool: &SqlitePool, meeting_id: &str) -> Result<String, sqlx::Error> {
    let content = sqlx::query_scalar::<_, String>(
        "SELECT content FROM meeting_manual_notes WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await?;

    Ok(content.unwrap_or_default())
}

pub async fn save_manual_notes(
    pool: &SqlitePool,
    meeting_id: &str,
    content: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO meeting_manual_notes (meeting_id, content, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) \
         ON CONFLICT(meeting_id) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP",
    )
    .bind(meeting_id)
    .bind(content)
    .execute(pool)
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn api_get_manual_notes(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<ManualNotesResponse, String> {
    let meeting_id = meeting_id.trim();
    if meeting_id.is_empty() {
        return Err("meeting_id cannot be empty".to_string());
    }

    let content = load_manual_notes(state.db_manager.pool(), meeting_id)
        .await
        .map_err(|error| {
            log::error!("Failed to load manual notes for meeting {}: {}", meeting_id, error);
            format!("Failed to load manual notes: {error}")
        })?;

    Ok(ManualNotesResponse { content })
}

#[tauri::command]
pub async fn api_save_manual_notes(
    state: State<'_, AppState>,
    meeting_id: String,
    content: String,
) -> Result<(), String> {
    let meeting_id = meeting_id.trim();
    if meeting_id.is_empty() {
        return Err("meeting_id cannot be empty".to_string());
    }
    if content.len() > MAX_CONTENT_LEN {
        return Err(format!(
            "Manual notes are limited to {MAX_CONTENT_LEN} characters"
        ));
    }

    save_manual_notes(state.db_manager.pool(), meeting_id, &content)
        .await
        .map_err(|error| {
            log::error!("Failed to save manual notes for meeting {}: {}", meeting_id, error);
            format!("Failed to save manual notes: {error}")
        })
}

#[cfg(test)]
mod tests {
    use super::{load_manual_notes, save_manual_notes};
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create in-memory database");

        sqlx::query(
            r#"
            CREATE TABLE meeting_manual_notes (
                meeting_id TEXT PRIMARY KEY,
                content TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            "#,
        )
        .execute(&pool)
        .await
        .expect("create meeting_manual_notes table");

        pool
    }

    #[tokio::test]
    async fn save_load_and_overwrite_round_trip() {
        let pool = test_pool().await;

        assert!(save_manual_notes(&pool, "meeting-1", "first draft").await.is_ok());
        assert_eq!(load_manual_notes(&pool, "meeting-1").await.unwrap(), "first draft");

        assert!(save_manual_notes(&pool, "meeting-1", "revised draft").await.is_ok());
        assert_eq!(load_manual_notes(&pool, "meeting-1").await.unwrap(), "revised draft");
    }

    #[tokio::test]
    async fn load_missing_meeting_returns_empty_string() {
        let pool = test_pool().await;
        assert_eq!(load_manual_notes(&pool, "unknown-meeting").await.unwrap(), "");
    }
}
