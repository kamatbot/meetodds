use sqlx::{migrate::MigrateDatabase, Result, Sqlite, SqlitePool, Transaction};
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use tauri::Manager;

const LEGACY_APP_IDENTIFIER: &str = "com.meetily.ai";
const IDENTITY_MIGRATION_MARKER: &str = ".meetodds-app-data-v1";
const DATABASE_FILES: &[&str] = &[
    "meeting_minutes.sqlite",
    "meeting_minutes.sqlite-wal",
    "meeting_minutes.sqlite-shm",
    "meeting_minutes.db",
];

/// Copy the old bundle-identifier app-data tree into the MeetOdds app-data tree.
///
/// This intentionally copies instead of moves. The old directory remains a rollback
/// copy and existing meeting `folder_path` values are not rewritten, so recordings
/// already stored elsewhere continue to resolve exactly as before.
pub fn migrate_legacy_identity_app_data<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
) -> std::result::Result<bool, String> {
    let target_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve MeetOdds app data directory: {error}"))?;
    let parent = target_dir.parent().ok_or_else(|| {
        format!(
            "MeetOdds app data directory has no parent: {}",
            target_dir.display()
        )
    })?;
    let legacy_dir = parent.join(LEGACY_APP_IDENTIFIER);

    migrate_legacy_data_dir(&legacy_dir, &target_dir)
}

fn migrate_legacy_data_dir(
    legacy_dir: &Path,
    target_dir: &Path,
) -> std::result::Result<bool, String> {
    if legacy_dir == target_dir || !legacy_dir.is_dir() {
        return Ok(false);
    }

    fs::create_dir_all(target_dir).map_err(|error| {
        format!(
            "failed to create MeetOdds app data directory {}: {error}",
            target_dir.display()
        )
    })?;

    let marker_path = target_dir.join(IDENTITY_MIGRATION_MARKER);
    if marker_path.exists() {
        return Ok(false);
    }

    // The SQLite database is the canonical meeting history. Never silently choose
    // between two different databases. A partially completed migration is safe to
    // resume because identical files are accepted.
    for file_name in DATABASE_FILES {
        let source = legacy_dir.join(file_name);
        if !source.is_file() {
            continue;
        }

        let destination = target_dir.join(file_name);
        if destination.exists() {
            if !files_equal(&source, &destination).map_err(|error| {
                format!(
                    "failed to compare {} with {}: {error}",
                    source.display(),
                    destination.display()
                )
            })? {
                return Err(format!(
                    "refusing to overwrite a different MeetOdds database file at {}. Legacy data remains untouched at {}",
                    destination.display(),
                    legacy_dir.display()
                ));
            }
            continue;
        }

        fs::copy(&source, &destination).map_err(|error| {
            format!(
                "failed to copy meeting database file {} to {}: {error}",
                source.display(),
                destination.display()
            )
        })?;
    }

    copy_directory_missing(legacy_dir, target_dir, true).map_err(|error| {
        format!(
            "failed to copy legacy MeetOdds app data from {} to {}: {error}",
            legacy_dir.display(),
            target_dir.display()
        )
    })?;

    let marker = format!(
        "MeetOdds identity migration v1\nlegacy_identifier={LEGACY_APP_IDENTIFIER}\nsource={}\ntarget={}\ncompleted_at={}\n",
        legacy_dir.display(),
        target_dir.display(),
        chrono::Utc::now().to_rfc3339()
    );
    fs::write(&marker_path, marker).map_err(|error| {
        format!(
            "failed to write migration marker {}: {error}",
            marker_path.display()
        )
    })?;

    log::info!(
        "Migrated legacy MeetOdds app data from {} to {}; legacy data was retained",
        legacy_dir.display(),
        target_dir.display()
    );
    Ok(true)
}

fn copy_directory_missing(source: &Path, destination: &Path, top_level: bool) -> io::Result<()> {
    fs::create_dir_all(destination)?;

    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let file_name_str = file_name.to_string_lossy();

        if top_level
            && (DATABASE_FILES.contains(&file_name_str.as_ref())
                || file_name_str == IDENTITY_MIGRATION_MARKER)
        {
            continue;
        }

        let source_path = entry.path();
        let destination_path = destination.join(&file_name);
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            copy_directory_missing(&source_path, &destination_path, false)?;
        } else if file_type.is_file() && !destination_path.exists() {
            fs::copy(&source_path, &destination_path)?;
        }
    }

    Ok(())
}

fn files_equal(left: &Path, right: &Path) -> io::Result<bool> {
    let left_meta = fs::metadata(left)?;
    let right_meta = fs::metadata(right)?;
    if left_meta.len() != right_meta.len() {
        return Ok(false);
    }

    let mut left_file = fs::File::open(left)?;
    let mut right_file = fs::File::open(right)?;
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];

    loop {
        let left_read = left_file.read(&mut left_buffer)?;
        let right_read = right_file.read(&mut right_buffer)?;
        if left_read != right_read {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
        if left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
    }
}

#[derive(Clone)]
pub struct DatabaseManager {
    pool: SqlitePool,
}

impl DatabaseManager {
    pub async fn new(tauri_db_path: &str, backend_db_path: &str) -> Result<Self> {
        if let Some(parent_dir) = Path::new(tauri_db_path).parent() {
            if !parent_dir.exists() {
                fs::create_dir_all(parent_dir).map_err(sqlx::Error::Io)?;
            }
        }

        if !Path::new(tauri_db_path).exists() {
            if Path::new(backend_db_path).exists() {
                log::info!(
                    "Copying database from {} to {}",
                    backend_db_path,
                    tauri_db_path
                );
                fs::copy(backend_db_path, tauri_db_path).map_err(sqlx::Error::Io)?;
            } else {
                log::info!("Creating database at {}", tauri_db_path);
                Sqlite::create_database(tauri_db_path).await?;
            }
        }

        let pool = SqlitePool::connect(tauri_db_path).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(DatabaseManager { pool })
    }

    pub async fn new_from_app_handle(app_handle: &tauri::AppHandle) -> Result<Self> {
        migrate_legacy_identity_app_data(app_handle)
            .map_err(|error| sqlx::Error::Io(std::io::Error::other(error)))?;

        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|error| sqlx::Error::Io(std::io::Error::other(error.to_string())))?;
        if !app_data_dir.exists() {
            fs::create_dir_all(&app_data_dir).map_err(sqlx::Error::Io)?;
        }

        let tauri_db_path = app_data_dir
            .join("meeting_minutes.sqlite")
            .to_string_lossy()
            .to_string();
        let backend_db_path = app_data_dir
            .join("meeting_minutes.db")
            .to_string_lossy()
            .to_string();
        let wal_path = app_data_dir.join("meeting_minutes.sqlite-wal");
        let shm_path = app_data_dir.join("meeting_minutes.sqlite-shm");

        log::info!("Tauri DB path: {}", tauri_db_path);
        log::info!("Legacy backend DB path: {}", backend_db_path);

        match Self::new(&tauri_db_path, &backend_db_path).await {
            Ok(db_manager) => {
                log::info!("Database opened successfully");
                Ok(db_manager)
            }
            Err(e) => {
                let error_msg = e.to_string();
                if error_msg.contains("malformed") || error_msg.contains("corrupt") {
                    log::warn!("Database appears corrupted, likely due to orphaned WAL file. Attempting recovery...");
                    log::warn!("Error details: {}", error_msg);

                    if wal_path.exists() {
                        match fs::remove_file(&wal_path) {
                            Ok(_) => log::info!("Removed orphaned WAL file: {:?}", wal_path),
                            Err(e) => log::warn!("Failed to remove WAL file: {}", e),
                        }
                    }
                    if shm_path.exists() {
                        match fs::remove_file(&shm_path) {
                            Ok(_) => log::info!("Removed orphaned SHM file: {:?}", shm_path),
                            Err(e) => log::warn!("Failed to remove SHM file: {}", e),
                        }
                    }

                    log::info!("Retrying database connection after WAL cleanup...");
                    match Self::new(&tauri_db_path, &backend_db_path).await {
                        Ok(db_manager) => {
                            log::info!("Database opened successfully after WAL recovery");
                            Ok(db_manager)
                        }
                        Err(retry_err) => {
                            log::error!("Database connection failed even after WAL cleanup: {}", retry_err);
                            Err(retry_err)
                        }
                    }
                } else {
                    log::error!("Database connection failed: {}", error_msg);
                    Err(e)
                }
            }
        }
    }

    pub async fn is_first_launch(app_handle: &tauri::AppHandle) -> Result<bool> {
        migrate_legacy_identity_app_data(app_handle)
            .map_err(|error| sqlx::Error::Io(std::io::Error::other(error)))?;

        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|error| sqlx::Error::Io(std::io::Error::other(error.to_string())))?;
        let tauri_db_path = app_data_dir.join("meeting_minutes.sqlite");
        Ok(!tauri_db_path.exists())
    }

    pub async fn import_legacy_database(
        app_handle: &tauri::AppHandle,
        legacy_db_path: &str,
    ) -> Result<Self> {
        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .expect("failed to get app data dir");

        if !app_data_dir.exists() {
            fs::create_dir_all(&app_data_dir).map_err(sqlx::Error::Io)?;
        }

        let target_legacy_path = app_data_dir.join("meeting_minutes.db");
        log::info!(
            "Copying legacy database from {} to {}",
            legacy_db_path,
            target_legacy_path.display()
        );
        fs::copy(legacy_db_path, &target_legacy_path).map_err(sqlx::Error::Io)?;
        Self::new_from_app_handle(app_handle).await
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn with_transaction<T, F, Fut>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut Transaction<'_, Sqlite>) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let mut tx = self.pool.begin().await?;
        let result = f(&mut tx).await;

        match result {
            Ok(val) => {
                tx.commit().await?;
                Ok(val)
            }
            Err(err) => {
                tx.rollback().await?;
                Err(err)
            }
        }
    }

    pub async fn cleanup(&self) -> Result<()> {
        log::info!("Starting database cleanup...");
        match sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&self.pool)
            .await
        {
            Ok(_) => log::info!("WAL checkpoint completed successfully"),
            Err(e) => log::warn!("WAL checkpoint failed (non-fatal): {}", e),
        }
        self.pool.close().await;
        log::info!("Database connection pool closed");
        Ok(())
    }
}

#[cfg(test)]
mod identity_migration_tests {
    use super::{migrate_legacy_data_dir, IDENTITY_MIGRATION_MARKER};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn copies_meetings_and_app_data_without_removing_legacy_data() {
        let root = TempDir::new().unwrap();
        let legacy = root.path().join("com.meetily.ai");
        let target = root.path().join("com.meetodds.app");
        fs::create_dir_all(legacy.join("models")).unwrap();
        fs::write(legacy.join("meeting_minutes.sqlite"), b"meeting-history").unwrap();
        fs::write(legacy.join("recording_preferences.json"), b"preferences").unwrap();
        fs::write(legacy.join("models/model.bin"), b"model").unwrap();

        assert!(migrate_legacy_data_dir(&legacy, &target).unwrap());
        assert_eq!(fs::read(target.join("meeting_minutes.sqlite")).unwrap(), b"meeting-history");
        assert_eq!(fs::read(target.join("recording_preferences.json")).unwrap(), b"preferences");
        assert_eq!(fs::read(target.join("models/model.bin")).unwrap(), b"model");
        assert!(target.join(IDENTITY_MIGRATION_MARKER).exists());
        assert!(legacy.join("meeting_minutes.sqlite").exists());
    }

    #[test]
    fn refuses_to_overwrite_a_different_meeting_database() {
        let root = TempDir::new().unwrap();
        let legacy = root.path().join("com.meetily.ai");
        let target = root.path().join("com.meetodds.app");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(legacy.join("meeting_minutes.sqlite"), b"legacy-meetings").unwrap();
        fs::write(target.join("meeting_minutes.sqlite"), b"different-meetings").unwrap();

        let error = migrate_legacy_data_dir(&legacy, &target).unwrap_err();
        assert!(error.contains("refusing to overwrite"));
        assert_eq!(fs::read(legacy.join("meeting_minutes.sqlite")).unwrap(), b"legacy-meetings");
        assert_eq!(fs::read(target.join("meeting_minutes.sqlite")).unwrap(), b"different-meetings");
        assert!(!target.join(IDENTITY_MIGRATION_MARKER).exists());
    }

    #[test]
    fn resumes_a_partial_copy_and_is_idempotent_after_marker() {
        let root = TempDir::new().unwrap();
        let legacy = root.path().join("com.meetily.ai");
        let target = root.path().join("com.meetodds.app");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(legacy.join("meeting_minutes.sqlite"), b"meeting-history").unwrap();
        fs::write(target.join("meeting_minutes.sqlite"), b"meeting-history").unwrap();
        fs::write(legacy.join("onboarding-status.json"), b"complete").unwrap();

        assert!(migrate_legacy_data_dir(&legacy, &target).unwrap());
        assert_eq!(fs::read(target.join("onboarding-status.json")).unwrap(), b"complete");
        assert!(!migrate_legacy_data_dir(&legacy, &target).unwrap());
    }
}
