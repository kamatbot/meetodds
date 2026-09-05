use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

#[derive(Debug, Clone)]
struct MeetingExportBundle {
    meeting_id: String,
    title: String,
    created_at: String,
    notes_markdown: Option<String>,
    summary: Option<Value>,
    transcripts: Vec<ExportTranscript>,
    audio_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportTranscript {
    text: String,
    timestamp: String,
    audio_start_time: Option<f64>,
    audio_end_time: Option<f64>,
    duration: Option<f64>,
    speaker: Option<String>,
    speaker_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingExportInfo {
    pub meeting_id: String,
    pub title: String,
    pub created_at: String,
    pub has_summary: bool,
    pub has_notes: bool,
    pub has_transcript: bool,
    pub has_audio: bool,
    pub transcript_has_timing: bool,
    pub audio_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingExportSelection {
    pub include_summary: bool,
    pub include_notes: bool,
    pub include_transcript: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingExportRequest {
    pub meeting_id: String,
    pub format: String,
    pub selection: MeetingExportSelection,
    #[serde(default)]
    pub expected_markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingExportResult {
    pub cancelled: bool,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonMeetingExport<'a> {
    meeting_id: &'a str,
    title: &'a str,
    created_at: &'a str,
    summary: Option<&'a Value>,
    notes_markdown: Option<&'a str>,
    transcript: Option<&'a [ExportTranscript]>,
}

async fn load_bundle(pool: &SqlitePool, meeting_id: &str) -> Result<MeetingExportBundle, String> {
    let meeting_id = meeting_id.trim();
    if meeting_id.is_empty() {
        return Err("meeting_id cannot be empty".to_string());
    }

    let row = sqlx::query_as::<_, (String, String, Option<String>, Option<String>)>(
        r#"
        SELECT title, CAST(created_at AS TEXT), folder_path, notes_markdown
        FROM meetings
        WHERE id = ? AND deleted_at IS NULL
        "#,
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("Failed to load meeting for export: {error}"))?
    .ok_or_else(|| format!("Meeting not found: {meeting_id}"))?;

    let transcript_rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            Option<f64>,
            Option<f64>,
            Option<f64>,
            Option<String>,
            Option<String>,
        ),
    >(
        r#"
        SELECT transcript, timestamp, audio_start_time, audio_end_time, duration, speaker, speaker_label
        FROM transcripts
        WHERE meeting_id = ?
        ORDER BY
            CASE WHEN audio_start_time IS NULL THEN 1 ELSE 0 END,
            audio_start_time ASC,
            timestamp ASC,
            id ASC
        "#,
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("Failed to load transcript for export: {error}"))?;

    let transcripts = transcript_rows
        .into_iter()
        .map(
            |(text, timestamp, audio_start_time, audio_end_time, duration, speaker, speaker_label)| {
                ExportTranscript {
                    text,
                    timestamp,
                    audio_start_time,
                    audio_end_time,
                    duration,
                    speaker,
                    speaker_label,
                }
            },
        )
        .collect::<Vec<_>>();

    let summary_result = sqlx::query_scalar::<_, Option<String>>(
        "SELECT result FROM summary_processes WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("Failed to load summary for export: {error}"))?
    .flatten();

    let summary = summary_result
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(summary_has_content);

    let notes_markdown = row
        .3
        .filter(|notes| !notes.trim().is_empty());

    let audio_path = row.2.and_then(|folder| {
        let candidate = PathBuf::from(folder).join("audio.mp4");
        if candidate.is_file() {
            Some(candidate)
        } else {
            None
        }
    });

    Ok(MeetingExportBundle {
        meeting_id: meeting_id.to_string(),
        title: row.0,
        created_at: row.1,
        notes_markdown,
        summary,
        transcripts,
        audio_path,
    })
}

fn summary_has_content(summary: &Value) -> bool {
    match summary {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
        _ => true,
    }
}

fn transcript_has_timing(transcript: &ExportTranscript) -> bool {
    let Some(start) = transcript.audio_start_time.filter(|value| value.is_finite() && *value >= 0.0)
    else {
        return false;
    };
    let end = transcript
        .audio_end_time
        .filter(|value| value.is_finite() && *value >= start)
        .or_else(|| {
            transcript
                .duration
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|duration| start + duration)
        });
    end.is_some()
}

fn bundle_info(bundle: &MeetingExportBundle) -> MeetingExportInfo {
    MeetingExportInfo {
        meeting_id: bundle.meeting_id.clone(),
        title: bundle.title.clone(),
        created_at: bundle.created_at.clone(),
        has_summary: bundle.summary.is_some(),
        has_notes: bundle.notes_markdown.is_some(),
        has_transcript: !bundle.transcripts.is_empty(),
        has_audio: bundle.audio_path.is_some(),
        transcript_has_timing: !bundle.transcripts.is_empty()
            && bundle.transcripts.iter().all(transcript_has_timing),
        audio_path: bundle
            .audio_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
    }
}

fn inline_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(inline_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(""),
        Value::Object(object) => {
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                return text.to_string();
            }
            object
                .get("content")
                .map(inline_text)
                .unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn block_to_markdown(block: &Value) -> Option<String> {
    let object = block.as_object()?;
    let block_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("paragraph");
    let text = object
        .get("content")
        .map(inline_text)
        .unwrap_or_default()
        .trim()
        .to_string();

    if text.is_empty() {
        return None;
    }

    let rendered = match block_type {
        "heading" => {
            let level = object
                .get("props")
                .and_then(Value::as_object)
                .and_then(|props| props.get("level"))
                .and_then(Value::as_u64)
                .unwrap_or(2)
                .clamp(1, 6);
            format!("{} {}", "#".repeat(level as usize), text)
        }
        "bulletListItem" => format!("- {text}"),
        "numberedListItem" => format!("1. {text}"),
        "checkListItem" => {
            let checked = object
                .get("props")
                .and_then(Value::as_object)
                .and_then(|props| props.get("checked"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            format!("- [{}] {text}", if checked { "x" } else { " " })
        }
        _ => text,
    };

    Some(rendered)
}

fn summary_to_markdown(summary: &Value) -> Option<String> {
    if let Some(markdown) = summary.get("markdown").and_then(Value::as_str) {
        let markdown = markdown.trim();
        if !markdown.is_empty() {
            return Some(markdown.to_string());
        }
    }

    if let Some(blocks) = summary.get("summary_json").and_then(Value::as_array) {
        let rendered = blocks
            .iter()
            .filter_map(block_to_markdown)
            .collect::<Vec<_>>()
            .join("\n\n");
        if !rendered.trim().is_empty() {
            return Some(rendered);
        }
    }

    let object = summary.as_object()?;
    let section_order = object
        .get("_section_order")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            let mut keys = object
                .keys()
                .filter(|key| *key != "_section_order" && *key != "MeetingName")
                .cloned()
                .collect::<Vec<_>>();
            keys.sort();
            keys
        });

    let mut sections = Vec::new();
    for key in section_order {
        let Some(section) = object.get(&key).and_then(Value::as_object) else {
            continue;
        };
        let title = section
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(&key);
        let body = section
            .get("blocks")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(block_to_markdown)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();

        if !body.trim().is_empty() {
            sections.push(format!("## {title}\n\n{body}"));
        }
    }

    if sections.is_empty() {
        None
    } else {
        Some(sections.join("\n\n"))
    }
}

fn speaker_label(transcript: &ExportTranscript) -> Option<&str> {
    transcript
        .speaker_label
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            transcript
                .speaker
                .as_deref()
                .filter(|value| !value.trim().is_empty())
        })
}

fn transcript_time_label(transcript: &ExportTranscript) -> &str {
    transcript.timestamp.trim()
}

fn transcript_to_markdown(transcripts: &[ExportTranscript]) -> String {
    transcripts
        .iter()
        .map(|segment| {
            let timestamp = transcript_time_label(segment);
            let speaker = speaker_label(segment);
            match (timestamp.is_empty(), speaker) {
                (false, Some(speaker)) => format!("[{timestamp}] **{speaker}:** {}", segment.text.trim()),
                (false, None) => format!("[{timestamp}] {}", segment.text.trim()),
                (true, Some(speaker)) => format!("**{speaker}:** {}", segment.text.trim()),
                (true, None) => segment.text.trim().to_string(),
            }
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn strip_basic_markdown(markdown: &str) -> String {
    markdown
        .lines()
        .map(|line| {
            line.trim_start_matches('#')
                .trim_start()
                .replace("**", "")
                .replace("__", "")
                .replace('`', "")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn selected_markdown(
    bundle: &MeetingExportBundle,
    selection: &MeetingExportSelection,
) -> Result<String, String> {
    let mut parts = Vec::new();

    if selection.include_summary {
        if let Some(summary) = bundle.summary.as_ref().and_then(summary_to_markdown) {
            parts.push(format!("# Summary\n\n{summary}"));
        }
    }

    if selection.include_notes {
        if let Some(notes) = bundle.notes_markdown.as_deref() {
            parts.push(format!("# Notes\n\n{}", notes.trim()));
        }
    }

    if selection.include_transcript && !bundle.transcripts.is_empty() {
        parts.push(format!(
            "# Transcript\n\n{}",
            transcript_to_markdown(&bundle.transcripts)
        ));
    }

    if parts.is_empty() {
        return Err("The selected meeting content is not available".to_string());
    }

    Ok(format!(
        "# {}\n\n{}\n\n{}\n",
        bundle.title.trim(),
        bundle.created_at.trim(),
        parts.join("\n\n")
    ))
}

fn selected_text(
    bundle: &MeetingExportBundle,
    selection: &MeetingExportSelection,
) -> Result<String, String> {
    selected_markdown(bundle, selection).map(|markdown| strip_basic_markdown(&markdown))
}

fn srt_timestamp(seconds: f64) -> String {
    let millis = (seconds.max(0.0) * 1000.0).round() as u64;
    let hours = millis / 3_600_000;
    let minutes = (millis % 3_600_000) / 60_000;
    let seconds = (millis % 60_000) / 1000;
    let milliseconds = millis % 1000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}")
}

fn selected_srt(
    bundle: &MeetingExportBundle,
    selection: &MeetingExportSelection,
) -> Result<String, String> {
    if !selection.include_transcript || selection.include_summary || selection.include_notes {
        return Err("SRT export supports transcript content only".to_string());
    }
    if bundle.transcripts.is_empty() {
        return Err("This meeting has no transcript to export".to_string());
    }
    if !bundle.transcripts.iter().all(transcript_has_timing) {
        return Err("SRT export requires timing for every transcript segment".to_string());
    }

    let mut cues = Vec::with_capacity(bundle.transcripts.len());
    for (index, segment) in bundle.transcripts.iter().enumerate() {
        let start = segment.audio_start_time.unwrap_or_default();
        let end = segment
            .audio_end_time
            .or_else(|| segment.duration.map(|duration| start + duration))
            .unwrap_or(start);
        let text = match speaker_label(segment) {
            Some(speaker) => format!("{speaker}: {}", segment.text.trim()),
            None => segment.text.trim().to_string(),
        };
        cues.push(format!(
            "{}\n{} --> {}\n{}",
            index + 1,
            srt_timestamp(start),
            srt_timestamp(end),
            text
        ));
    }

    Ok(format!("{}\n", cues.join("\n\n")))
}

fn selected_json(
    bundle: &MeetingExportBundle,
    selection: &MeetingExportSelection,
) -> Result<String, String> {
    let visible_summary = if selection.include_summary {
        bundle.summary.as_ref().and_then(summary_to_markdown).map(|markdown| serde_json::json!({"markdown": markdown}))
    } else { None };
    let summary = visible_summary.as_ref();
    let notes_markdown = selection
        .include_notes
        .then_some(bundle.notes_markdown.as_deref())
        .flatten();
    let transcript = if selection.include_transcript && !bundle.transcripts.is_empty() {
        Some(bundle.transcripts.as_slice())
    } else {
        None
    };

    if summary.is_none() && notes_markdown.is_none() && transcript.is_none() {
        return Err("The selected meeting content is not available".to_string());
    }

    serde_json::to_string_pretty(&JsonMeetingExport {
        meeting_id: &bundle.meeting_id,
        title: &bundle.title,
        created_at: &bundle.created_at,
        summary,
        notes_markdown,
        transcript,
    })
    .map(|json| format!("{json}\n"))
    .map_err(|error| format!("Failed to serialize meeting JSON: {error}"))
}

fn sanitize_title_for_filename(title: &str) -> String {
    let mut sanitized = title
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            value if value.is_control() => ' ',
            value => value,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    sanitized = sanitized.trim_matches([' ', '.']).to_string();
    if sanitized.is_empty() {
        sanitized = "Untitled meeting".to_string();
    }

    sanitized.chars().take(120).collect()
}

fn meeting_date(created_at: &str) -> String {
    let candidate = created_at.chars().take(10).collect::<String>();
    let valid = candidate.len() == 10
        && candidate.chars().enumerate().all(|(index, character)| {
            if index == 4 || index == 7 {
                character == '-'
            } else {
                character.is_ascii_digit()
            }
        });
    if valid {
        candidate
    } else {
        "Undated".to_string()
    }
}

fn default_filename(bundle: &MeetingExportBundle, extension: &str) -> String {
    format!(
        "{} — {}.{}",
        meeting_date(&bundle.created_at),
        sanitize_title_for_filename(&bundle.title),
        extension
    )
}

fn serialize_content(
    bundle: &MeetingExportBundle,
    format: &str,
    selection: &MeetingExportSelection,
) -> Result<(&'static str, &'static str, String), String> {
    match format {
        "markdown" | "md" => Ok(("md", "Markdown", selected_markdown(bundle, selection)?)),
        "text" | "txt" => Ok(("txt", "Plain text", selected_text(bundle, selection)?)),
        "srt" => Ok(("srt", "Subtitles", selected_srt(bundle, selection)?)),
        "json" => Ok(("json", "JSON", selected_json(bundle, selection)?)),
        other => Err(format!("Unsupported export format: {other}")),
    }
}

fn save_dialog_path<R: Runtime>(
    app: &AppHandle<R>,
    filename: &str,
    filter_name: &str,
    extension: &str,
) -> Result<Option<PathBuf>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Export meeting")
        .set_file_name(filename)
        .add_filter(filter_name, &[extension])
        .blocking_save_file();

    selected
        .map(|file_path| {
            file_path
                .into_path()
                .map_err(|error| format!("Selected export path is not a local file: {error}"))
        })
        .transpose()
}

fn paths_refer_to_same_file(source: &Path, destination: &Path) -> bool {
    match (source.canonicalize(), destination.canonicalize()) {
        (Ok(source), Ok(destination)) => source == destination,
        _ => false,
    }
}

#[tauri::command]
pub async fn api_get_meeting_export_info(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<MeetingExportInfo, String> {
    let bundle = load_bundle(state.db_manager.pool(), &meeting_id).await?;
    Ok(bundle_info(&bundle))
}

#[tauri::command]
pub async fn api_get_meeting_markdown(
    state: State<'_, AppState>,
    meeting_id: String,
    selection: MeetingExportSelection,
) -> Result<String, String> {
    let bundle = load_bundle(state.db_manager.pool(), &meeting_id).await?;
    selected_markdown(&bundle, &selection)
}

#[tauri::command]
pub async fn api_export_meeting<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    request: MeetingExportRequest,
) -> Result<MeetingExportResult, String> {
    let bundle = load_bundle(state.db_manager.pool(), &request.meeting_id).await?;
    if let Some(expected) = request.expected_markdown.as_deref() {
        if selected_markdown(&bundle, &request.selection)? != expected {
            return Err("Saved content changed after preview. Review it again before exporting.".to_string());
        }
    }
    let (extension, filter_name, content) =
        serialize_content(&bundle, request.format.trim().to_lowercase().as_str(), &request.selection)?;
    let filename = default_filename(&bundle, extension);

    let Some(destination) = save_dialog_path(&app, &filename, filter_name, extension)? else {
        return Ok(MeetingExportResult {
            cancelled: true,
            path: None,
        });
    };

    let parent = destination.parent().ok_or_else(|| "Invalid export destination".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    use std::io::Write;
    temporary.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(&destination).map_err(|e| e.to_string())?;

    Ok(MeetingExportResult {
        cancelled: false,
        path: Some(destination.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub async fn api_export_meeting_audio<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<MeetingExportResult, String> {
    let bundle = load_bundle(state.db_manager.pool(), &meeting_id).await?;
    let source = bundle
        .audio_path
        .as_ref()
        .ok_or_else(|| "No audio saved for this meeting".to_string())?;
    let filename = default_filename(&bundle, "mp4");

    let Some(destination) = save_dialog_path(&app, &filename, "Audio", "mp4")? else {
        return Ok(MeetingExportResult {
            cancelled: true,
            path: None,
        });
    };

    if !paths_refer_to_same_file(source, &destination) {
        std::fs::copy(source, &destination)
            .map_err(|error| format!("Failed to export meeting audio: {error}"))?;
    }

    Ok(MeetingExportResult {
        cancelled: false,
        path: Some(destination.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub async fn api_reveal_meeting_audio(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<(), String> {
    let bundle = load_bundle(state.db_manager.pool(), &meeting_id).await?;
    let audio_path = bundle
        .audio_path
        .ok_or_else(|| "No audio saved for this meeting".to_string())?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&audio_path)
            .spawn()
            .map_err(|error| format!("Failed to reveal recording: {error}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", audio_path.to_string_lossy()))
            .spawn()
            .map_err(|error| format!("Failed to reveal recording: {error}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        let folder = audio_path
            .parent()
            .ok_or_else(|| "Recording folder is not available".to_string())?;
        std::process::Command::new("xdg-open")
            .arg(folder)
            .spawn()
            .map_err(|error| format!("Failed to open recording folder: {error}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        default_filename, selected_json, selected_markdown, selected_srt, selected_text,
        ExportTranscript, MeetingExportBundle, MeetingExportSelection,
    };
    use serde_json::json;

    fn fixture() -> MeetingExportBundle {
        MeetingExportBundle {
            meeting_id: "meeting-unicode".to_string(),
            title: "製品レビュー / Q4 😀".to_string(),
            created_at: "2026-09-03T09:30:00+00:00".to_string(),
            notes_markdown: Some("## Notes\n\nลูกค้า said **yes**.".to_string()),
            summary: Some(json!({
                "markdown": "## Decisions\n\nShip 日本語 support."
            })),
            transcripts: vec![
                ExportTranscript {
                    text: "Hello 世界".to_string(),
                    timestamp: "00:00:01".to_string(),
                    audio_start_time: Some(1.0),
                    audio_end_time: Some(2.25),
                    duration: Some(1.25),
                    speaker: Some("speaker_0".to_string()),
                    speaker_label: Some("Mayur".to_string()),
                },
                ExportTranscript {
                    text: "สวัสดี".to_string(),
                    timestamp: "00:00:03".to_string(),
                    audio_start_time: Some(3.0),
                    audio_end_time: Some(4.0),
                    duration: Some(1.0),
                    speaker: Some("speaker_1".to_string()),
                    speaker_label: Some("Guest".to_string()),
                },
            ],
            audio_path: None,
        }
    }

    #[test]
    fn markdown_and_text_are_deterministic_and_preserve_unicode() {
        let bundle = fixture();
        let selection = MeetingExportSelection {
            include_summary: true,
            include_notes: true,
            include_transcript: true,
        };

        let markdown = selected_markdown(&bundle, &selection).unwrap();
        assert_eq!(markdown, selected_markdown(&bundle, &selection).unwrap());
        assert!(markdown.contains("製品レビュー"));
        assert!(markdown.contains("ลูกค้า"));
        assert!(markdown.contains("**Mayur:** Hello 世界"));

        let text = selected_text(&bundle, &selection).unwrap();
        assert_eq!(text, selected_text(&bundle, &selection).unwrap());
        assert!(text.contains("Mayur: Hello 世界"));
    }

    #[test]
    fn missing_summary_and_notes_are_omitted_without_placeholders() {
        let mut bundle = fixture();
        bundle.summary = None;
        bundle.notes_markdown = None;
        let selection = MeetingExportSelection {
            include_summary: true,
            include_notes: true,
            include_transcript: true,
        };

        let markdown = selected_markdown(&bundle, &selection).unwrap();
        assert!(!markdown.contains("# Summary"));
        assert!(!markdown.contains("# Notes"));
        assert!(markdown.contains("# Transcript"));
    }

    #[test]
    fn srt_keeps_multiple_speakers_and_exact_timing() {
        let bundle = fixture();
        let selection = MeetingExportSelection {
            include_summary: false,
            include_notes: false,
            include_transcript: true,
        };

        let srt = selected_srt(&bundle, &selection).unwrap();
        assert_eq!(srt, selected_srt(&bundle, &selection).unwrap());
        assert!(srt.contains("00:00:01,000 --> 00:00:02,250"));
        assert!(srt.contains("Mayur: Hello 世界"));
        assert!(srt.contains("Guest: สวัสดี"));
    }

    #[test]
    fn json_and_filename_are_stable_and_unicode_safe() {
        let bundle = fixture();
        let selection = MeetingExportSelection {
            include_summary: true,
            include_notes: true,
            include_transcript: true,
        };

        let json = selected_json(&bundle, &selection).unwrap();
        assert_eq!(json, selected_json(&bundle, &selection).unwrap());
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["meetingId"], "meeting-unicode");
        assert_eq!(parsed["transcript"][1]["speakerLabel"], "Guest");
        assert_eq!(
            default_filename(&bundle, "md"),
            "2026-09-03 — 製品レビュー Q4 😀.md"
        );
    }
}
