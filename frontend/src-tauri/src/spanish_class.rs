//! Spanish practice: build a lesson from a recorded class transcript.
//!
//! The meeting recorder captures online Spanish classes. These commands list
//! meetings that have transcripts and turn one transcript into a short lesson
//! brief (topic, key phrases, grammar) that the tutor then practices.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::state::AppState;

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ClassMeeting {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub segments: i64,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LessonPhrase {
    #[serde(default)]
    pub es: String,
    #[serde(default)]
    pub en: String,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LessonBrief {
    #[serde(default)]
    pub meeting_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub phrases: Vec<LessonPhrase>,
    #[serde(default)]
    pub grammar: Vec<String>,
    #[serde(default)]
    pub prompts: Vec<String>,
    /// The situation string handed to the tutor session.
    #[serde(default)]
    pub situation: String,
}

static HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .expect("reqwest client")
});

// ponytail: small local models get ~9k chars of transcript (head + tail); a
// map-reduce over long classes can come later if briefs look thin.
const HEAD_CHARS: usize = 6_000;
const TAIL_CHARS: usize = 3_000;

#[tauri::command]
pub async fn spanish_list_class_meetings(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<ClassMeeting>, String> {
    sqlx::query_as::<_, ClassMeeting>(
        "SELECT m.id, m.title, m.created_at, COUNT(t.id) AS segments \
         FROM meetings m JOIN transcripts t ON t.meeting_id = m.id \
         WHERE m.deleted_at IS NULL \
         GROUP BY m.id ORDER BY m.created_at DESC LIMIT ?",
    )
    .bind(limit.clamp(1, 200) as i64)
    .fetch_all(state.db_manager.pool())
    .await
    .map_err(|e| e.to_string())
}

async fn load_transcript_text(pool: &SqlitePool, meeting_id: &str) -> Result<(String, String), String> {
    let title = sqlx::query_scalar::<_, String>("SELECT title FROM meetings WHERE id = ? AND deleted_at IS NULL")
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That meeting no longer exists.".to_string())?;
    let lines = sqlx::query_scalar::<_, String>(
        "SELECT transcript FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time, timestamp",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let text = lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        return Err("This meeting has no transcript to learn from.".to_string());
    }
    Ok((title, text))
}

fn clip_transcript(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= HEAD_CHARS + TAIL_CHARS {
        return text.to_string();
    }
    let head: String = chars[..HEAD_CHARS].iter().collect();
    let tail: String = chars[chars.len() - TAIL_CHARS..].iter().collect();
    format!("{head}\n[...]\n{tail}")
}

fn extract_json(raw: &str) -> Option<&str> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    (end > start).then(|| &raw[start..=end])
}

fn parse_lesson(raw: &str) -> LessonBrief {
    // Strip <think> blocks that some local models emit before the JSON.
    let cleaned = match (raw.find("<think>"), raw.find("</think>")) {
        (Some(s), Some(e)) if e > s => format!("{}{}", &raw[..s], &raw[e + "</think>".len()..]),
        _ => raw.to_string(),
    };
    let mut brief: LessonBrief = extract_json(&cleaned)
        .and_then(|slice| serde_json::from_str(slice).ok())
        .unwrap_or_default();
    brief.phrases.retain(|p| !p.es.trim().is_empty());
    brief.phrases.truncate(12);
    brief.grammar.retain(|g| !g.trim().is_empty());
    brief.grammar.truncate(3);
    brief.prompts.retain(|p| !p.trim().is_empty());
    brief.prompts.truncate(3);
    brief
}

fn build_situation(brief: &LessonBrief) -> String {
    let phrases = brief
        .phrases
        .iter()
        .map(|p| if p.en.trim().is_empty() { p.es.clone() } else { format!("{} ({})", p.es, p.en) })
        .collect::<Vec<_>>()
        .join("; ");
    let mut s = format!("Reviewing the learner's Spanish class \"{}\"", brief.title.trim());
    if !brief.topic.trim().is_empty() {
        s.push_str(&format!(" about {}", brief.topic.trim()));
    }
    s.push('.');
    if !phrases.is_empty() {
        s.push_str(&format!(" Work these phrases from the class into the conversation and invite the learner to use them: {phrases}."));
    }
    if !brief.grammar.is_empty() {
        s.push_str(&format!(" Grammar covered in class: {}.", brief.grammar.join("; ")));
    }
    if !brief.prompts.is_empty() {
        s.push_str(&format!(" Good questions to ask: {}", brief.prompts.join(" / ")));
    }
    s
}

#[tauri::command]
pub async fn spanish_build_lesson<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<LessonBrief, String> {
    let pool = state.db_manager.pool();
    let (title, text) = load_transcript_text(pool, &meeting_id).await?;
    let cfg = crate::live_translation::resolve_provider_config(pool).await?;
    let system_prompt = "You help a Spanish learner review an online Spanish class. You are given the class transcript from speech recognition: it may contain errors and mix Spanish and English. Extract what was taught. Output ONLY a JSON object: {\"topic\": one short English line naming what the class was about, \"phrases\": [{\"es\": a Spanish phrase or word as taught, exactly as a learner would say it, \"en\": its English meaning}] with 8 to 12 of the most useful items, \"grammar\": [1 to 3 short English lines naming grammar points covered], \"prompts\": [3 short questions in Spanish a tutor could ask to practice this material]}.";
    let user_prompt = format!("Class title: {title}\n\nTranscript:\n{}", clip_transcript(&text));
    let app_data_dir = app.path().app_data_dir().ok();
    let raw = crate::summary::llm_client::generate_summary(
        &HTTP_CLIENT,
        &cfg.provider,
        &cfg.model_name,
        &cfg.api_key,
        system_prompt,
        &user_prompt,
        cfg.ollama_endpoint.as_deref(),
        cfg.custom_openai_endpoint.as_deref(),
        Some(700),
        cfg.temperature,
        cfg.top_p,
        app_data_dir.as_ref(),
        None,
    )
    .await?;
    let mut brief = parse_lesson(&raw);
    if brief.phrases.is_empty() && brief.topic.trim().is_empty() {
        return Err("Could not build a lesson from this transcript. Try a longer recording or a different summary model.".to_string());
    }
    brief.meeting_id = meeting_id;
    brief.title = title;
    brief.situation = build_situation(&brief);
    Ok(brief)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fenced_lesson_json_and_builds_situation() {
        let raw = "<think>hmm</think>```json\n{\"topic\":\"ordering food\",\"phrases\":[{\"es\":\"la cuenta, por favor\",\"en\":\"the bill, please\"},{\"es\":\"\",\"en\":\"x\"}],\"grammar\":[\"quiero + noun\"],\"prompts\":[\"¿Qué quieres comer?\"]}\n```";
        let mut brief = parse_lesson(raw);
        assert_eq!(brief.phrases.len(), 1);
        brief.title = "Clase 3".into();
        let s = build_situation(&brief);
        assert!(s.contains("la cuenta, por favor (the bill, please)"));
        assert!(s.contains("quiero + noun"));
    }

    #[test]
    fn garbage_gives_empty_brief_and_long_transcripts_are_clipped() {
        assert!(parse_lesson("no json here").phrases.is_empty());
        let long = "a".repeat(HEAD_CHARS + TAIL_CHARS + 100);
        let clipped = clip_transcript(&long);
        assert!(clipped.contains("[...]"));
        assert!(clipped.chars().count() < long.chars().count());
    }
}
