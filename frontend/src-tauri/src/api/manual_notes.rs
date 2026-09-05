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
        "SELECT content FROM meeting_manual_notes WHERE meeting_id = ? \
         UNION ALL \
         SELECT notes.content FROM meeting_manual_note_links links \
         JOIN meeting_manual_notes notes ON notes.meeting_id = links.draft_meeting_id \
         WHERE links.meeting_id = ? \
         LIMIT 1",
    )
    .bind(meeting_id)
    .bind(meeting_id)
    .fetch_optional(pool)
    .await?;

    Ok(content.unwrap_or_default())
}

pub async fn link_manual_notes(
    pool: &SqlitePool,
    draft_meeting_id: &str,
    meeting_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO meeting_manual_note_links (meeting_id, draft_meeting_id, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) \
         ON CONFLICT(meeting_id) DO UPDATE SET draft_meeting_id = excluded.draft_meeting_id, updated_at = CURRENT_TIMESTAMP",
    )
    .bind(meeting_id)
    .bind(draft_meeting_id)
    .execute(pool)
    .await?;

    Ok(())
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

#[tauri::command]
pub async fn api_link_manual_notes(
    state: State<'_, AppState>,
    draft_meeting_id: String,
    meeting_id: String,
) -> Result<(), String> {
    let draft_meeting_id = draft_meeting_id.trim();
    let meeting_id = meeting_id.trim();
    if draft_meeting_id.is_empty() || meeting_id.is_empty() {
        return Err("meeting ids cannot be empty".to_string());
    }

    link_manual_notes(state.db_manager.pool(), draft_meeting_id, meeting_id)
        .await
        .map_err(|error| {
            log::error!("Failed to link manual notes for meeting {}: {}", meeting_id, error);
            format!("Failed to link manual notes: {error}")
        })
}

#[cfg(test)]
mod tests {
    use super::{link_manual_notes, load_manual_notes, save_manual_notes};
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

        sqlx::query(
            r#"
            CREATE TABLE meeting_manual_note_links (
                meeting_id TEXT PRIMARY KEY,
                draft_meeting_id TEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            "#,
        )
        .execute(&pool)
        .await
        .expect("create meeting_manual_note_links table");

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

    #[tokio::test]
    async fn saved_meeting_reads_notes_from_its_in_flight_draft_after_late_saves() {
        let pool = test_pool().await;
        save_manual_notes(&pool, "meeting-draft", "first draft").await.unwrap();
        link_manual_notes(&pool, "meeting-draft", "saved-meeting").await.unwrap();
        save_manual_notes(&pool, "meeting-draft", "final note after stop").await.unwrap();

        assert_eq!(load_manual_notes(&pool, "saved-meeting").await.unwrap(), "final note after stop");
    }
}
