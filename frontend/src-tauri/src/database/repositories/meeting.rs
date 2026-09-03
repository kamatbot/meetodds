use crate::api::{MeetingDetails, MeetingTranscript};
use crate::database::models::{
    MeetingListItem, MeetingListPage, MeetingListRequest, MeetingListSort, MeetingModel,
    MeetingSummaryStatus, Transcript,
};
use chrono::{Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{
    Connection, Error as SqlxError, FromRow, QueryBuilder, Sqlite, SqliteConnection, SqlitePool,
};
use tracing::{error, info};

const DELETE_GRACE_SECONDS: i64 = 8;
const DURATION_SQL: &str = "COALESCE(m.duration_ms, (SELECT CAST(ROUND(MAX(t_duration.audio_end_time) * 1000.0) AS INTEGER) FROM transcripts t_duration WHERE t_duration.meeting_id = m.id))";

#[derive(Debug, FromRow)]
struct MeetingListRow {
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    duration_ms: Option<i64>,
    starred: i64,
    summary_status: String,
    transcript_snippet: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct MeetingListCursor {
    sort: MeetingListSort,
    sort_value: String,
    id: String,
}

pub struct MeetingsRepository;

impl MeetingsRepository {
    pub async fn get_meetings(pool: &SqlitePool) -> Result<Vec<MeetingModel>, sqlx::Error> {
        Self::purge_expired_deletions(pool).await?;
        let meetings = sqlx::query_as::<_, MeetingModel>(
            "SELECT id, title, created_at, updated_at, folder_path, duration_ms, starred, title_source, notes_markdown, deleted_at
             FROM meetings
             WHERE deleted_at IS NULL
             ORDER BY created_at DESC, id ASC",
        )
        .fetch_all(pool)
        .await?;
        Ok(meetings)
    }

    pub async fn list_meetings(
        pool: &SqlitePool,
        request: &MeetingListRequest,
    ) -> Result<MeetingListPage, SqlxError> {
        Self::purge_expired_deletions(pool).await?;

        let limit = request.limit.clamp(1, 100);
        let query = request
            .query
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let query_pattern = query.map(|value| format!("%{}%", escape_like(value)));
        let cursor = match request.cursor.as_deref() {
            Some(raw) => {
                let parsed: MeetingListCursor = serde_json::from_str(raw).map_err(|error| {
                    SqlxError::Protocol(format!("Invalid meeting list cursor: {error}"))
                })?;
                if parsed.sort != request.sort {
                    return Err(SqlxError::Protocol(
                        "Meeting list cursor sort does not match request sort".to_string(),
                    ));
                }
                Some(parsed)
            }
            None => None,
        };

        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT m.id, m.title, m.created_at, m.updated_at, ",
        );
        builder.push(DURATION_SQL);
        builder.push(
            " AS duration_ms, m.starred,
             CASE
               WHEN sp.status IN ('completed', 'ready') THEN 'ready'
               WHEN sp.status IN ('processing', 'generating', 'pending', 'running') THEN 'generating'
               WHEN sp.status IN ('error', 'failed', 'cancelled') THEN 'failed'
               WHEN sp.result IS NOT NULL AND TRIM(sp.result) <> '' THEN 'ready'
               ELSE 'missing'
             END AS summary_status, ",
        );

        if let Some(pattern) = query_pattern.as_ref() {
            builder.push(
                "(SELECT substr(t_snippet.transcript, 1, 180)
                  FROM transcripts t_snippet
                  WHERE t_snippet.meeting_id = m.id
                    AND LOWER(t_snippet.transcript) LIKE LOWER(",
            );
            builder.push_bind(pattern.clone());
            builder.push(") ESCAPE '\\' ORDER BY t_snippet.timestamp ASC LIMIT 1) AS transcript_snippet ");
        } else {
            builder.push("NULL AS transcript_snippet ");
        }

        builder.push(
            "FROM meetings m
             LEFT JOIN summary_processes sp ON sp.meeting_id = m.id
             WHERE m.deleted_at IS NULL ",
        );

        if request.starred_only.unwrap_or(false) {
            builder.push("AND m.starred = 1 ");
        }

        if let Some(pattern) = query_pattern.as_ref() {
            builder.push("AND (LOWER(m.title) LIKE LOWER(");
            builder.push_bind(pattern.clone());
            builder.push(") ESCAPE '\\' OR EXISTS (
                SELECT 1 FROM transcripts t_search
                WHERE t_search.meeting_id = m.id
                  AND LOWER(t_search.transcript) LIKE LOWER(");
            builder.push_bind(pattern.clone());
            builder.push(") ESCAPE '\\')) ");
        }

        if let Some(cursor) = cursor.as_ref() {
            match request.sort {
                MeetingListSort::Newest => {
                    builder.push("AND (m.created_at < ");
                    builder.push_bind(cursor.sort_value.clone());
                    builder.push(" OR (m.created_at = ");
                    builder.push_bind(cursor.sort_value.clone());
                    builder.push(" AND m.id > ");
                    builder.push_bind(cursor.id.clone());
                    builder.push(")) ");
                }
                MeetingListSort::Oldest => {
                    builder.push("AND (m.created_at > ");
                    builder.push_bind(cursor.sort_value.clone());
                    builder.push(" OR (m.created_at = ");
                    builder.push_bind(cursor.sort_value.clone());
                    builder.push(" AND m.id > ");
                    builder.push_bind(cursor.id.clone());
                    builder.push(")) ");
                }
                MeetingListSort::Longest => {
                    let duration = cursor.sort_value.parse::<i64>().map_err(|error| {
                        SqlxError::Protocol(format!("Invalid duration cursor: {error}"))
                    })?;
                    builder.push("AND (COALESCE(");
                    builder.push(DURATION_SQL);
                    builder.push(", -1) < ");
                    builder.push_bind(duration);
                    builder.push(" OR (COALESCE(");
                    builder.push(DURATION_SQL);
                    builder.push(", -1) = ");
                    builder.push_bind(duration);
                    builder.push(" AND m.id > ");
                    builder.push_bind(cursor.id.clone());
                    builder.push(")) ");
                }
                MeetingListSort::Title => {
                    builder.push("AND (LOWER(m.title) > ");
                    builder.push_bind(cursor.sort_value.clone());
                    builder.push(" OR (LOWER(m.title) = ");
                    builder.push_bind(cursor.sort_value.clone());
                    builder.push(" AND m.id > ");
                    builder.push_bind(cursor.id.clone());
                    builder.push(")) ");
                }
            }
        }

        match request.sort {
            MeetingListSort::Newest => builder.push("ORDER BY m.created_at DESC, m.id ASC "),
            MeetingListSort::Oldest => builder.push("ORDER BY m.created_at ASC, m.id ASC "),
            MeetingListSort::Longest => {
                builder.push("ORDER BY COALESCE(");
                builder.push(DURATION_SQL);
                builder.push(", -1) DESC, m.id ASC ")
            }
            MeetingListSort::Title => builder.push("ORDER BY LOWER(m.title) ASC, m.id ASC "),
        };

        builder.push("LIMIT ");
        builder.push_bind(limit + 1);

        let mut rows = builder
            .build_query_as::<MeetingListRow>()
            .fetch_all(pool)
            .await?;
        let has_more = rows.len() > limit as usize;
        if has_more {
            rows.truncate(limit as usize);
        }

        let items: Vec<MeetingListItem> = rows
            .into_iter()
            .map(|row| MeetingListItem {
                id: row.id,
                title: row.title,
                created_at: row.created_at,
                updated_at: row.updated_at,
                duration_ms: row.duration_ms,
                starred: row.starred != 0,
                summary_status: match row.summary_status.as_str() {
                    "ready" => MeetingSummaryStatus::Ready,
                    "generating" => MeetingSummaryStatus::Generating,
                    "failed" => MeetingSummaryStatus::Failed,
                    _ => MeetingSummaryStatus::Missing,
                },
                transcript_snippet: row.transcript_snippet,
            })
            .collect();

        let next_cursor = if has_more {
            items
                .last()
                .map(|item| encode_cursor(item, request.sort))
                .transpose()?
        } else {
            None
        };

        Ok(MeetingListPage { items, next_cursor })
    }

    pub async fn set_starred(
        pool: &SqlitePool,
        meeting_id: &str,
        starred: bool,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let result = sqlx::query(
            "UPDATE meetings SET starred = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(starred)
        .bind(Utc::now().naive_utc())
        .bind(meeting_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn defer_delete_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<String>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let marker = Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true);
        let result = sqlx::query(
            "UPDATE meetings SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(&marker)
        .bind(Utc::now().naive_utc())
        .bind(meeting_id)
        .execute(pool)
        .await?;

        if result.rows_affected() > 0 {
            Ok(Some(marker))
        } else {
            Ok(None)
        }
    }

    pub async fn restore_deferred_delete(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let result = sqlx::query(
            "UPDATE meetings SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL",
        )
        .bind(Utc::now().naive_utc())
        .bind(meeting_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn finalize_deferred_delete(
        pool: &SqlitePool,
        meeting_id: &str,
        marker: &str,
    ) -> Result<bool, SqlxError> {
        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let still_pending: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM meetings WHERE id = ? AND deleted_at = ?",
        )
        .bind(meeting_id)
        .bind(marker)
        .fetch_optional(&mut *transaction)
        .await?;

        if still_pending.is_none() {
            transaction.rollback().await?;
            return Ok(false);
        }

        let deleted = delete_meeting_with_transaction(&mut transaction, meeting_id).await?;
        if deleted {
            transaction.commit().await?;
        } else {
            transaction.rollback().await?;
        }
        Ok(deleted)
    }

    async fn purge_expired_deletions(pool: &SqlitePool) -> Result<(), SqlxError> {
        let cutoff = (Utc::now() - Duration::seconds(DELETE_GRACE_SECONDS))
            .to_rfc3339_opts(SecondsFormat::Nanos, true);
        let expired_ids = sqlx::query_scalar::<_, String>(
            "SELECT id FROM meetings WHERE deleted_at IS NOT NULL AND deleted_at <= ?",
        )
        .bind(cutoff)
        .fetch_all(pool)
        .await?;

        for meeting_id in expired_ids {
            Self::delete_meeting(pool, &meeting_id).await?;
        }
        Ok(())
    }

    pub async fn delete_meeting(pool: &SqlitePool, meeting_id: &str) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        match delete_meeting_with_transaction(&mut transaction, meeting_id).await {
            Ok(success) => {
                if success {
                    transaction.commit().await?;
                    info!(
                        "Successfully deleted meeting {} and all associated data",
                        meeting_id
                    );
                    Ok(true)
                } else {
                    transaction.rollback().await?;
                    Ok(false)
                }
            }
            Err(e) => {
                let _ = transaction.rollback().await;
                error!("Failed to delete meeting {}: {}", meeting_id, e);
                Err(e)
            }
        }
    }

    pub async fn get_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<MeetingDetails>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        // Get meeting details
        let meeting: Option<MeetingModel> = sqlx::query_as(
            "SELECT id, title, created_at, updated_at, folder_path FROM meetings WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(meeting_id)
        .fetch_optional(&mut *transaction)
        .await?;

        if meeting.is_none() {
            transaction.rollback().await?;
            return Err(SqlxError::RowNotFound);
        }

        if let Some(meeting) = meeting {
            let transcripts =
                sqlx::query_as::<_, Transcript>("SELECT * FROM transcripts WHERE meeting_id = ?")
                    .bind(meeting_id)
                    .fetch_all(&mut *transaction)
                    .await?;

            transaction.commit().await?;

            let meeting_transcripts = transcripts
                .into_iter()
                .map(|t| MeetingTranscript {
                    id: t.id,
                    text: t.transcript,
                    timestamp: t.timestamp,
                    audio_start_time: t.audio_start_time,
                    audio_end_time: t.audio_end_time,
                    duration: t.duration,
                    speaker: t.speaker,
                    speaker_label: t.speaker_label,
                    speaker_source: t.speaker_source,
                    speaker_confidence: t.speaker_confidence,
                })
                .collect::<Vec<_>>();

            Ok(Some(MeetingDetails {
                id: meeting.id,
                title: meeting.title,
                created_at: meeting.created_at.0.to_rfc3339(),
                updated_at: meeting.updated_at.0.to_rfc3339(),
                transcripts: meeting_transcripts,
            }))
        } else {
            transaction.rollback().await?;
            Ok(None)
        }
    }

    pub async fn get_meeting_metadata(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<MeetingModel>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let meeting: Option<MeetingModel> = sqlx::query_as(
            "SELECT id, title, created_at, updated_at, folder_path FROM meetings WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await?;

        Ok(meeting)
    }

    pub async fn get_meeting_transcripts_paginated(
        pool: &SqlitePool,
        meeting_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<Transcript>, i64), SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let total: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM transcripts t
             JOIN meetings m ON m.id = t.meeting_id
             WHERE t.meeting_id = ? AND m.deleted_at IS NULL",
        )
        .bind(meeting_id)
        .fetch_one(pool)
        .await?;

        let transcripts = sqlx::query_as::<_, Transcript>(
            "SELECT t.* FROM transcripts t
             JOIN meetings m ON m.id = t.meeting_id
             WHERE t.meeting_id = ? AND m.deleted_at IS NULL
             ORDER BY t.audio_start_time ASC
             LIMIT ? OFFSET ?",
        )
        .bind(meeting_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?;

        Ok((transcripts, total.0))
    }

    pub async fn update_meeting_title(
        pool: &SqlitePool,
        meeting_id: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }
        if new_title.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting title cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;
        let now = Utc::now().naive_utc();

        let rows_affected = sqlx::query(
            "UPDATE meetings SET title = ?, title_source = 'manual', updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(new_title.trim())
        .bind(now)
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;
        if rows_affected.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false);
        }
        transaction.commit().await?;
        Ok(true)
    }

    pub async fn update_meeting_name(
        pool: &SqlitePool,
        meeting_id: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        let mut transaction = pool.begin().await?;
        let now = Utc::now();

        let meeting_update = sqlx::query(
            "UPDATE meetings SET title = ?, title_source = 'manual', updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(new_title.trim())
        .bind(now)
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

        if meeting_update.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false);
        }

        sqlx::query("UPDATE transcript_chunks SET meeting_name = ? WHERE meeting_id = ?")
            .bind(new_title.trim())
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;
        Ok(true)
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn encode_cursor(item: &MeetingListItem, sort: MeetingListSort) -> Result<String, SqlxError> {
    let sort_value = match sort {
        MeetingListSort::Newest | MeetingListSort::Oldest => item.created_at.clone(),
        MeetingListSort::Longest => item.duration_ms.unwrap_or(-1).to_string(),
        MeetingListSort::Title => item.title.to_lowercase(),
    };
    serde_json::to_string(&MeetingListCursor {
        sort,
        sort_value,
        id: item.id.clone(),
    })
    .map_err(|error| SqlxError::Protocol(format!("Failed to encode meeting cursor: {error}")))
}

async fn delete_meeting_with_transaction(
    transaction: &mut SqliteConnection,
    meeting_id: &str,
) -> Result<bool, SqlxError> {
    let meeting_exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(&mut *transaction)
        .await?;

    if meeting_exists.is_none() {
        error!("Meeting {} not found for deletion", meeting_id);
        return Ok(false);
    }

    sqlx::query("DELETE FROM transcript_chunks WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    sqlx::query("DELETE FROM summary_processes WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    sqlx::query("DELETE FROM transcripts WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    sqlx::query("DELETE FROM meeting_notes WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    let result = sqlx::query("DELETE FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("test database");

        sqlx::raw_sql(
            "CREATE TABLE meetings (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                folder_path TEXT,
                duration_ms INTEGER,
                starred INTEGER NOT NULL DEFAULT 0,
                title_source TEXT,
                notes_markdown TEXT,
                deleted_at TEXT
            );
            CREATE TABLE transcripts (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                transcript TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                summary TEXT,
                action_items TEXT,
                key_points TEXT,
                audio_start_time REAL,
                audio_end_time REAL,
                duration REAL,
                speaker TEXT,
                speaker_label TEXT,
                speaker_source TEXT,
                speaker_confidence REAL
            );
            CREATE TABLE summary_processes (
                meeting_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                result TEXT
            );
            CREATE TABLE transcript_chunks (
                meeting_id TEXT PRIMARY KEY,
                meeting_name TEXT
            );
            CREATE TABLE meeting_notes (
                meeting_id TEXT PRIMARY KEY,
                notes_markdown TEXT
            );",
        )
        .execute(&pool)
        .await
        .expect("create test schema");
        pool
    }

    async fn insert_meeting(
        pool: &SqlitePool,
        id: &str,
        title: &str,
        created_at: &str,
        duration_ms: Option<i64>,
        starred: bool,
    ) {
        sqlx::query(
            "INSERT INTO meetings (id, title, created_at, updated_at, duration_ms, starred)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(title)
        .bind(created_at)
        .bind(created_at)
        .bind(duration_ms)
        .bind(starred)
        .execute(pool)
        .await
        .expect("insert meeting");
    }

    fn request(sort: MeetingListSort, limit: i64) -> MeetingListRequest {
        MeetingListRequest {
            cursor: None,
            limit,
            query: None,
            sort,
            starred_only: None,
        }
    }

    #[tokio::test]
    async fn cursor_pages_without_duplicates() {
        let pool = test_pool().await;
        for (id, hour) in [("m1", 10), ("m2", 11), ("m3", 12), ("m4", 13)] {
            insert_meeting(
                &pool,
                id,
                id,
                &format!("2026-09-03T{hour:02}:00:00Z"),
                None,
                false,
            )
            .await;
        }

        let first = MeetingsRepository::list_meetings(
            &pool,
            &request(MeetingListSort::Newest, 2),
        )
        .await
        .unwrap();
        assert_eq!(
            first
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["m4", "m3"]
        );
        assert!(first.next_cursor.is_some());

        let mut second_request = request(MeetingListSort::Newest, 2);
        second_request.cursor = first.next_cursor;
        let second = MeetingsRepository::list_meetings(&pool, &second_request)
            .await
            .unwrap();
        assert_eq!(
            second
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["m2", "m1"]
        );
        assert!(second.next_cursor.is_none());
    }

    #[tokio::test]
    async fn longest_sort_uses_duration_then_id() {
        let pool = test_pool().await;
        insert_meeting(
            &pool,
            "short",
            "Short",
            "2026-09-03T10:00:00Z",
            Some(10_000),
            false,
        )
        .await;
        insert_meeting(
            &pool,
            "long",
            "Long",
            "2026-09-03T11:00:00Z",
            Some(90_000),
            false,
        )
        .await;
        insert_meeting(
            &pool,
            "medium",
            "Medium",
            "2026-09-03T12:00:00Z",
            Some(45_000),
            false,
        )
        .await;

        let page = MeetingsRepository::list_meetings(
            &pool,
            &request(MeetingListSort::Longest, 10),
        )
        .await
        .unwrap();
        assert_eq!(
            page.items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["long", "medium", "short"]
        );
    }

    #[tokio::test]
    async fn title_search_is_bounded_and_case_insensitive() {
        let pool = test_pool().await;
        insert_meeting(
            &pool,
            "a",
            "Alpha planning",
            "2026-09-03T10:00:00Z",
            None,
            false,
        )
        .await;
        insert_meeting(
            &pool,
            "b",
            "Beta review",
            "2026-09-03T11:00:00Z",
            None,
            false,
        )
        .await;

        let mut query = request(MeetingListSort::Newest, 1);
        query.query = Some("ALPHA".to_string());
        let page = MeetingsRepository::list_meetings(&pool, &query).await.unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "a");
    }

    #[tokio::test]
    async fn transcript_search_returns_snippet_not_body_payload() {
        let pool = test_pool().await;
        insert_meeting(
            &pool,
            "a",
            "General sync",
            "2026-09-03T10:00:00Z",
            None,
            false,
        )
        .await;
        sqlx::query(
            "INSERT INTO transcripts (id, meeting_id, transcript, timestamp)
             VALUES ('t1', 'a', 'The important needle appears in this transcript.', '00:00:01')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let mut query = request(MeetingListSort::Newest, 10);
        query.query = Some("needle".to_string());
        let page = MeetingsRepository::list_meetings(&pool, &query).await.unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.items[0]
            .transcript_snippet
            .as_deref()
            .unwrap_or_default()
            .contains("needle"));
    }

    #[tokio::test]
    async fn starred_only_filters_unstarred_rows() {
        let pool = test_pool().await;
        insert_meeting(
            &pool,
            "star",
            "Starred",
            "2026-09-03T10:00:00Z",
            None,
            true,
        )
        .await;
        insert_meeting(
            &pool,
            "plain",
            "Plain",
            "2026-09-03T11:00:00Z",
            None,
            false,
        )
        .await;

        let mut query = request(MeetingListSort::Newest, 10);
        query.starred_only = Some(true);
        let page = MeetingsRepository::list_meetings(&pool, &query).await.unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "star");
    }
}
