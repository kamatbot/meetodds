//! One-click cleanup of model files downloaded by older versions: Whisper, Parakeet
//! and the built-in summary LLM. Only these app-managed paths under
//! `<app data>/models` are ever listed or deleted, and only on explicit request.
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LegacyModel {
    /// "whisper" | "parakeet" | "builtin-llm"
    pub kind: &'static str,
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct LegacyModelsUsage {
    pub bytes: u64,
    pub items: Vec<LegacyModel>,
}

/// Size on disk without following symlinks.
fn size(path: &Path) -> u64 {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::read_dir(path)
            .map(|entries| entries.flatten().map(|entry| size(&entry.path())).sum())
            .unwrap_or(0),
        Ok(meta) => meta.len(),
        Err(_) => 0,
    }
}

fn children(dir: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
        .unwrap_or_default();
    paths.sort();
    paths
}

fn item(kind: &'static str, path: PathBuf) -> LegacyModel {
    LegacyModel { kind, bytes: size(&path), path: path.to_string_lossy().into_owned() }
}

/// Lists legacy model files in `models_dir` (`<app data>/models`).
pub fn find(models_dir: &Path) -> Vec<LegacyModel> {
    let name = |path: &Path| path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut items = Vec::new();
    // Whisper stored ggml-*.bin (and any Core ML encoder) directly in models/.
    for path in children(models_dir) {
        if name(&path).starts_with("ggml-") {
            items.push(item("whisper", path));
        }
    }
    // Parakeet stored one folder per model in models/parakeet.
    for path in children(&models_dir.join("parakeet")) {
        items.push(item("parakeet", path));
    }
    // The built-in summary model stored GGUF files (partial downloads use the same name).
    for path in children(&models_dir.join("summary")) {
        if name(&path).to_ascii_lowercase().ends_with(".gguf") {
            items.push(item("builtin-llm", path));
        }
    }
    items
}

/// Deletes exactly what `find` lists and returns the bytes freed.
/// Files that cannot be removed are left in place and reported again by `find`.
pub fn delete(models_dir: &Path) -> u64 {
    let mut freed = 0;
    for model in find(models_dir) {
        let path = Path::new(&model.path);
        let is_dir = std::fs::symlink_metadata(path).map(|m| m.is_dir()).unwrap_or(false);
        let removed = if is_dir { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
        match removed {
            Ok(()) => freed += model.bytes,
            Err(error) => log::warn!("Could not delete a legacy {} model: {}", model.kind, error),
        }
    }
    // Drop the per-engine folders only when they are now empty.
    for folder in ["parakeet", "summary"] {
        let _ = std::fs::remove_dir(models_dir.join(folder));
    }
    freed
}

fn models_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("models"))
        .map_err(|e| format!("App data folder unavailable: {}", e))
}

#[tauri::command]
pub async fn api_legacy_models_usage<R: Runtime>(app: AppHandle<R>) -> Result<LegacyModelsUsage, String> {
    let dir = models_dir(&app)?;
    let items = tauri::async_runtime::spawn_blocking(move || find(&dir))
        .await
        .map_err(|e| e.to_string())?;
    Ok(LegacyModelsUsage { bytes: items.iter().map(|i| i.bytes).sum(), items })
}

#[tauri::command]
pub async fn api_delete_legacy_models<R: Runtime>(app: AppHandle<R>) -> Result<u64, String> {
    let dir = models_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || delete(&dir))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn legacy_models_lists_only_app_managed_model_files() {
        let root = tempfile::tempdir().unwrap();
        let models = root.path().join("models");
        write(&models.join("ggml-small-q5_1.bin"), 10);
        write(&models.join("ggml-base-encoder.mlmodelc/weights.bin"), 5);
        write(&models.join("parakeet/parakeet-tdt-0.6b-v3-int8/encoder.onnx"), 20);
        write(&models.join("summary/Qwen3.5-4B-Q4_K_M.gguf"), 30);
        // Unrelated files must never be listed.
        write(&models.join("summary/notes.txt"), 7);
        write(&models.join("readme.txt"), 3);
        write(&root.path().join("meeting_minutes.sqlite"), 9);

        let items = find(&models);
        let kinds: Vec<_> = items.iter().map(|i| (i.kind, i.bytes)).collect();
        assert_eq!(kinds, vec![("whisper", 5), ("whisper", 10), ("parakeet", 20), ("builtin-llm", 30)]);
        assert!(items.iter().all(|i| Path::new(&i.path).starts_with(&models)));
    }

    #[test]
    fn legacy_models_delete_frees_bytes_and_keeps_everything_else() {
        let root = tempfile::tempdir().unwrap();
        let models = root.path().join("models");
        write(&models.join("ggml-small-q5_1.bin"), 10);
        write(&models.join("parakeet/parakeet-tdt-0.6b-v3-int8/encoder.onnx"), 20);
        write(&models.join("summary/Qwen3.5-4B-Q4_K_M.gguf"), 30);
        write(&models.join("summary/notes.txt"), 7);
        write(&models.join("readme.txt"), 3);
        write(&root.path().join("meeting_minutes.sqlite"), 9);

        assert_eq!(delete(&models), 60);
        assert!(find(&models).is_empty());
        assert!(!models.join("parakeet").exists());
        assert!(models.join("summary/notes.txt").exists());
        assert!(models.join("readme.txt").exists());
        assert!(root.path().join("meeting_minutes.sqlite").exists());
        assert_eq!(delete(&models), 0);
    }

    #[test]
    fn legacy_models_missing_folder_is_empty() {
        let root = tempfile::tempdir().unwrap();
        assert!(find(&root.path().join("models")).is_empty());
        assert_eq!(delete(&root.path().join("models")), 0);
    }

    #[cfg(unix)]
    #[test]
    fn legacy_models_symlink_is_removed_not_followed() {
        let root = tempfile::tempdir().unwrap();
        let models = root.path().join("models");
        let outside = root.path().join("keep.bin");
        write(&outside, 50);
        fs::create_dir_all(&models).unwrap();
        std::os::unix::fs::symlink(&outside, models.join("ggml-linked.bin")).unwrap();
        delete(&models);
        assert!(outside.exists());
        assert!(!models.join("ggml-linked.bin").exists());
    }
}
