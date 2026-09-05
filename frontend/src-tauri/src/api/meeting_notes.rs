use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingNotesResponse {
    pub meeting_id: String,
    pub notes_markdown: String,
}

async fn load_notes(pool: &SqlitePool, meeting_id: &str) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query_scalar::<_, Option<String>>(
        "SELECT notes_markdown FROM meetings WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|notes| notes.unwrap_or_default()))
}

async fn save_notes(
    pool: &SqlitePool,
    meeting_id: &str,
    notes_markdown: &str,
    expected: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE meetings SET notes_markdown = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL AND (? IS NULL OR COALESCE(notes_markdown, '') = ?)",
    )
    .bind(notes_markdown)
    .bind(meeting_id)
    .bind(expected)
    .bind(expected)
    .execute(pool)
    .await?;

    Ok(result.rows_affected() > 0)
}

#[tauri::command]
pub async fn api_get_meeting_notes(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<MeetingNotesResponse, String> {
    let meeting_id = meeting_id.trim();
    if meeting_id.is_empty() {
        return Err("meeting_id cannot be empty".to_string());
    }

    let notes = load_notes(state.db_manager.pool(), meeting_id)
        .await
        .map_err(|error| {
            log::error!("Failed to load notes for meeting {}: {}", meeting_id, error);
            format!("Failed to load meeting notes: {error}")
        })?
        .ok_or_else(|| format!("Meeting not found: {meeting_id}"))?;

    Ok(MeetingNotesResponse {
        meeting_id: meeting_id.to_string(),
        notes_markdown: notes,
    })
}

#[tauri::command]
pub async fn api_save_meeting_notes(
    state: State<'_, AppState>,
    meeting_id: String,
    notes_markdown: String,
    expected_notes_markdown: Option<String>,
) -> Result<(), String> {
    let meeting_id = meeting_id.trim();
    if meeting_id.is_empty() {
        return Err("meeting_id cannot be empty".to_string());
    }

    let updated = save_notes(state.db_manager.pool(), meeting_id, &notes_markdown, expected_notes_markdown.as_deref())
        .await
        .map_err(|error| {
            log::error!("Failed to save notes for meeting {}: {}", meeting_id, error);
            format!("Failed to save meeting notes: {error}")
        })?;

    if !updated {
        return match load_notes(state.db_manager.pool(), meeting_id).await {
            Ok(Some(_)) => Err("NOTES_CONFLICT: Saved notes changed in another view. Review both versions before replacing them.".to_string()),
            _ => Err("Meeting is unavailable; its notes were not overwritten".to_string()),
        };
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{load_notes, save_notes};
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create in-memory database");

        sqlx::query(
            r#"
            CREATE TABLE meetings (
                id TEXT PRIMARY KEY NOT NULL,
                notes_markdown TEXT NULL,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                deleted_at DATETIME NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .expect("create meetings table");

        pool
    }

    #[tokio::test]
    async fn notes_round_trip_and_deleted_meetings_are_hidden() {
        let pool = test_pool().await;
        sqlx::query("INSERT INTO meetings (id) VALUES (?)")
            .bind("meeting-1")
            .execute(&pool)
            .await
            .expect("insert meeting");

        assert_eq!(load_notes(&pool, "meeting-1").await.unwrap(), Some(String::new()));
        assert!(save_notes(&pool, "meeting-1", "# Decisions\n- Ship it", None)
            .await
            .unwrap());
        assert_eq!(
            load_notes(&pool, "meeting-1").await.unwrap(),
            Some("# Decisions\n- Ship it".to_string())
        );

        sqlx::query("UPDATE meetings SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind("meeting-1")
            .execute(&pool)
            .await
            .expect("soft delete meeting");

        assert_eq!(load_notes(&pool, "meeting-1").await.unwrap(), None);
        assert!(!save_notes(&pool, "meeting-1", "should not write", None)
            .await
            .unwrap());
    }
    #[tokio::test]
    async fn stale_writer_cannot_overwrite_a_newer_saved_note() {
        let pool = test_pool().await;
        sqlx::query("INSERT INTO meetings (id) VALUES ('race')").execute(&pool).await.unwrap();
        assert!(save_notes(&pool, "race", "first", Some("")).await.unwrap());
        assert!(!save_notes(&pool, "race", "stale", Some("")).await.unwrap());
        assert_eq!(load_notes(&pool, "race").await.unwrap(), Some("first".to_string()));
        assert!(save_notes(&pool, "race", "reviewed replacement", Some("first")).await.unwrap());
    }

}
