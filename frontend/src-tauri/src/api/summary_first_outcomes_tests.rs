use super::*;
use sqlx::sqlite::SqlitePoolOptions;

async fn execute_statements(pool: &SqlitePool, sql: &str) {
    let sql = sql.lines().filter(|line| !line.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n");
    for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
        sqlx::query(statement).execute(pool).await.unwrap();
    }
}
async fn setup() -> SqlitePool {
    let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
    execute_statements(&pool, "
        PRAGMA foreign_keys = ON;
        CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, notes_markdown TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT);
        CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT, transcript TEXT NOT NULL, timestamp TEXT DEFAULT CURRENT_TIMESTAMP, audio_start_time REAL, audio_end_time REAL, speaker_label TEXT);
        CREATE TABLE summary_processes (meeting_id TEXT PRIMARY KEY, status TEXT NOT NULL, result TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE meeting_manual_notes (meeting_id TEXT PRIMARY KEY, content TEXT NOT NULL);
    ").await;
    execute_statements(&pool, include_str!("../../migrations/20260907163000_meeting_intelligence.sql")).await;
    execute_statements(&pool, include_str!("../../migrations/20260911020000_summary_first_outcomes.sql")).await;
    sqlx::query("INSERT INTO meetings(id,title) VALUES ('m','Review')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO transcripts(id,meeting_id,transcript) VALUES ('t','m','I will um we should well can you do the report we agreed maybe')").execute(&pool).await.unwrap();
    pool
}
async fn summary(pool: &SqlitePool, status: &str, markdown: &str) {
    sqlx::query("INSERT INTO summary_processes(meeting_id,status,result) VALUES ('m',?,?) ON CONFLICT(meeting_id) DO UPDATE SET status=excluded.status,result=excluded.result")
        .bind(status).bind(serde_json::json!({"markdown":markdown}).to_string()).execute(pool).await.unwrap();
}
const RESULT: &str = "<!-- meetodds:outcome -->\n## Meeting outcome\nThe team agreed to prepare a revised report.\n<!-- meetodds:actions -->\n## Action items\n- Prepare and send the revised report. | Owner: Alex | Due: Friday | Commitment: agreed\n<!-- meetodds:questions -->\n## Open questions\n- None\n<!-- meetodds:end -->";

#[tokio::test]
async fn transcript_only_creates_no_actions_from_get_refresh_or_inbox_backfill() {
    let pool=setup().await;
    refresh_meeting_intelligence(&pool,"m").await.unwrap();
    refresh_recent_missing(&pool).await.unwrap();
    let data=load_intelligence(&pool,"m",true).await.unwrap();
    assert!(data.actions.is_empty()); assert!(data.decisions.is_empty()); assert!(data.outcome.is_none());
}
#[tokio::test]
async fn pending_failed_and_cancelled_results_never_create_actions() {
    let pool=setup().await;
    for status in ["pending","processing","failed","cancelled"] {
        summary(&pool,status,RESULT).await;
        assert!(load_intelligence(&pool,"m",true).await.unwrap().actions.is_empty(),"{status}");
    }
}
#[tokio::test]
async fn only_completed_model_text_becomes_an_action_not_the_raw_fragment() {
    let pool=setup().await; summary(&pool,"completed",RESULT).await;
    let data=load_intelligence(&pool,"m",true).await.unwrap();
    assert_eq!(data.actions.len(),1);
    let a=&data.actions[0];
    assert_eq!(a.text,"Prepare and send the revised report.");
    assert_eq!(a.owner.as_deref(),Some("Alex")); assert_eq!(a.due_text.as_deref(),Some("Friday"));
    assert_eq!(a.commitment_state,"agreed"); assert!(a.due_at.is_none()); assert!(!a.confirmed);
}
#[tokio::test]
async fn unchanged_results_are_idempotent_and_empty_actions_are_valid() {
    let pool=setup().await; summary(&pool,"completed",RESULT).await;
    let first=load_intelligence(&pool,"m",true).await.unwrap().actions[0].id.clone();
    assert_eq!(first,load_intelligence(&pool,"m",true).await.unwrap().actions[0].id);
    summary(&pool,"completed","## Meeting outcome\nDiscussion only.\n## Action items\nNone.").await;
    assert!(load_intelligence(&pool,"m",true).await.unwrap().actions.is_empty());
    let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM meeting_outcome_state WHERE meeting_id='m'").fetch_one(&pool).await.unwrap(); assert_eq!(count,1);
}
#[tokio::test]
async fn regeneration_preserves_confirmed_edits_completed_tasks_and_rejections() {
    let pool=setup().await;
    let markdown="## Action items\n- Send the report.\n- Review the design.\n- Share the schedule.\n- Disposable suggestion.";
    summary(&pool,"completed",markdown).await; refresh_meeting_intelligence(&pool,"m").await.unwrap();
    sqlx::query("UPDATE meeting_actions SET text='User edited report task',owner='User chosen owner',confirmed=1 WHERE text='Send the report.'").execute(&pool).await.unwrap();
    sqlx::query("UPDATE meeting_actions SET status='done' WHERE text='Review the design.'").execute(&pool).await.unwrap();
    sqlx::query("UPDATE meeting_actions SET status='dismissed',confirmed=1 WHERE text='Share the schedule.'").execute(&pool).await.unwrap();
    summary(&pool,"completed","## Action items\n- Send the report.\n- Review the design.\n- Share the schedule.\n- A new AI task.").await;
    let data=load_intelligence(&pool,"m",true).await.unwrap();
    assert_eq!(data.actions.len(),3);
    assert!(data.actions.iter().any(|a|a.text=="User edited report task"&&a.confirmed&&a.owner.as_deref()==Some("User chosen owner")));
    assert!(data.actions.iter().any(|a|a.text=="Review the design."&&a.status=="done"));
    assert!(!data.actions.iter().any(|a|a.text=="Disposable suggestion."||a.text=="Share the schedule."));
}
#[tokio::test]
async fn failed_regeneration_retains_the_previous_successful_projection() {
    let pool=setup().await; summary(&pool,"completed",RESULT).await;
    let first=load_intelligence(&pool,"m",true).await.unwrap().actions[0].id.clone();
    summary(&pool,"failed","## Actions\n- Incomplete new output.").await;
    let data=load_intelligence(&pool,"m",true).await.unwrap(); assert_eq!(data.actions[0].id,first);
}
#[tokio::test]
async fn a_projection_write_failure_rolls_back_previous_tasks_and_hash() {
    let pool=setup().await; summary(&pool,"completed",RESULT).await;
    let before=load_intelligence(&pool,"m",true).await.unwrap().actions[0].id.clone();
    sqlx::query("CREATE TRIGGER reject_new_action BEFORE INSERT ON meeting_actions BEGIN SELECT RAISE(ABORT,'injected failure'); END").execute(&pool).await.unwrap();
    summary(&pool,"completed","## Action items\n- A changed task.").await;
    assert!(refresh_meeting_intelligence(&pool,"m").await.is_err());
    let after:String=sqlx::query_scalar("SELECT id FROM meeting_actions WHERE meeting_id='m'").fetch_one(&pool).await.unwrap(); assert_eq!(before,after);
}
#[test]
fn translated_headings_are_supported_by_machine_markers() {
    let rows=parse_summary_candidates("<!-- meetodds:actions -->\n## Próximos pasos\n- Enviar el informe completo. | Owner: Ana | Commitment: proposed\n<!-- meetodds:end -->\nIgnore this unrelated text",&[]);
    assert_eq!(rows.len(),1); assert_eq!(rows[0].kind,"action"); assert_eq!(rows[0].owner.as_deref(),Some("Ana")); assert_eq!(rows[0].commitment_state.as_deref(),Some("proposed"));
}
#[test]
fn multiline_tasks_stay_whole_unknown_metadata_stays_unknown() {
    let rows=parse_summary_candidates("## Action items\n- Prepare the report\n  including the corrected figures. | Owner: Unknown | Due: Not specified\n- None.",&[]);
    assert_eq!(rows.len(),1); assert_eq!(rows[0].text,"Prepare the report including the corrected figures."); assert!(rows[0].owner.is_none()); assert!(rows[0].due_text.is_none());
}
#[test]
fn no_heuristic_tasks_from_unstructured_speech_or_summary_prose() {
    assert!(parse_summary_candidates("I will send the report. Please review it.",&[]).is_empty());
    let rows=parse_summary_candidates("## Discussion\n- Can you review this?\n## Actions\nNone.",&[]);assert!(rows.is_empty());
}
#[test]
fn modern_legacy_and_blocknote_summary_formats_are_supported() {
    assert_eq!(summary_markdown(Some("{\"markdown\":\"## Actions\\n- Send report.\"}".into())),"## Actions\n- Send report.");
    assert!(summary_markdown(Some("{\"action_items\":{\"title\":\"Action items\",\"blocks\":[{\"content\":\"Send report.\"}]}}".into())).contains("Send report."));
    assert!(summary_markdown(Some("{\"summary_json\":[{\"type\":\"heading\",\"content\":[{\"text\":\"Actions\"}]},{\"type\":\"bulletListItem\",\"content\":[{\"text\":\"Send report.\"}]}]}".into())).contains("Send report."));
    assert!(summary_markdown(Some("{bad-json".into())).is_empty());
}
#[test]
fn local_recall_vectors_still_rank_relevant_sources() {
    let q=memory_vector("sqlite database local storage");
    assert!((cosine(&q,&q)-1.0).abs()<1e-4);
    assert!(cosine(&q,&memory_vector("SQLite database local storage"))>cosine(&q,&memory_vector("pancakes flour milk")));
    assert_eq!(snippet_for_query("Quick test","test"),"Quick test");
}
#[tokio::test]
async fn local_recall_indexes_transcripts_without_creating_an_action() {
    let pool=setup().await; index_meeting_memory(&pool,"m").await.unwrap();
    let docs:i64=sqlx::query_scalar("SELECT COUNT(*) FROM meeting_memory_documents").fetch_one(&pool).await.unwrap(); assert!(docs>0);
    let actions:i64=sqlx::query_scalar("SELECT COUNT(*) FROM meeting_actions").fetch_one(&pool).await.unwrap(); assert_eq!(actions,0);
}

/// Real on-device check of the Apple Intelligence summary path and this parser:
/// `MEETODDS_AI_TRANSCRIPT=/path/en.txt MEETODDS_AI_TRANSCRIPT_UNSUPPORTED=/path/hi.txt
///  cargo test --lib -- --ignored apple_intelligence_long_meeting --nocapture`
/// Transcripts must be synthetic; output text is not printed, only structure.
#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires Apple Intelligence and a synthetic transcript file"]
async fn apple_intelligence_long_meeting_summary_yields_parsed_actions() {
    use crate::summary::llm_client::LLMProvider;
    let ts = include_str!("../../../src/lib/post-meeting-flow.ts");
    let instructions = ts.split("POST_MEETING_INSTRUCTIONS = `").nth(1).unwrap().split("`;").next().unwrap();
    let template = crate::summary::templates::get_template("standard_meeting").unwrap();
    let run = |text: String| {
        let template = template.clone();
        async move {
            let detected = crate::summary::language_detection::detect_summary_language(&[text.clone()]).language;
            crate::summary::generate_meeting_summary(
                &reqwest::Client::new(), &LLMProvider::AppleIntelligence, "system", "", &text, instructions,
                "standard_meeting", &template, 4096, None, None, None, None, None, None, None, None,
                detected.as_deref(), None,
            ).await
        }
    };
    let text = std::fs::read_to_string(std::env::var("MEETODDS_AI_TRANSCRIPT").unwrap()).unwrap();
    let started = std::time::Instant::now();
    let (markdown, _, chunks) = run(text.clone()).await.unwrap();
    if let Ok(out) = std::env::var("MEETODDS_AI_OUTPUT") { std::fs::write(out, &markdown).unwrap(); }
    println!("words={} chunks={} seconds={:.1}", text.split_whitespace().count(), chunks, started.elapsed().as_secs_f64());
    for marker in ["outcome", "decisions", "actions", "questions"] {
        println!("marker {marker}: {}", markdown.contains(&format!("<!-- meetodds:{marker} -->")));
    }
    let pool = setup().await;
    summary(&pool, "completed", &markdown).await;
    let data = load_intelligence(&pool, "m", true).await.unwrap();
    println!("parsed: actions={} decisions={} outcome={} owners={:?}", data.actions.len(), data.decisions.len(),
        data.outcome.is_some(), data.actions.iter().map(|a| a.owner.clone()).collect::<Vec<_>>());
    assert!(markdown.contains("<!-- meetodds:actions -->"));
    assert!(!data.actions.is_empty());

    let hindi = std::fs::read_to_string(std::env::var("MEETODDS_AI_TRANSCRIPT_UNSUPPORTED").unwrap()).unwrap();
    let error = run(hindi).await.unwrap_err();
    println!("unsupported language error: {error}");
    assert!(error.contains("ChatGPT"));
}
