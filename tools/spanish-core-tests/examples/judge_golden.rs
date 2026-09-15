//! Manual only. Start your existing Qwen 3.5 4B llama-server first; no model
//! download, cloud connection, API key, or speech recording is performed here.
use serde::Deserialize;
use serde_json::{json, Value};
use spanish_core::policy;
use spanish_core::text::{self, Intent};
use spanish_core::tutor::{judge_prompt, Prompt};
use spanish_core::{Category, Level, SessionState, Severity, SpanishProfile};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Instant;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    level: Level,
    learner: String,
    #[serde(default)] question: String,
    #[serde(default)] variety: String,
    expected: Expected,
    #[serde(default)] acceptable_categories: Vec<Category>,
}
#[derive(Deserialize)]
struct Expected { intent: Intent, category: Option<Category>, severity: Option<Severity> }

/// The corpus is Spanish; the engine now takes the profile's language id.
fn profile_language() -> &'static str { spanish_core::LEGACY_LANGUAGE_ID }
fn local_endpoint(url: &str) -> Result<String, String> {
    let rest = url.strip_prefix("http://").ok_or("Use an explicit loopback HTTP server, not a hosted endpoint.")?;
    if rest.contains(['@', '?', '#', '\\']) { return Err("Unsupported endpoint URL.".into()); }
    let authority = rest.split('/').next().unwrap_or("");
    let port = authority.strip_prefix("127.0.0.1:").or_else(|| authority.strip_prefix("localhost:"))
        .or_else(|| authority.strip_prefix("[::1]:")).ok_or("The evaluation endpoint must be loopback with an explicit port.")?;
    if port.parse::<u16>().ok().is_none_or(|p| p == 0) { return Err("Invalid loopback port.".into()); }
    if rest[authority.len()..].trim_matches('/') != "" { return Err("Pass the origin only; /v1/chat/completions is added by the runner.".into()); }
    Ok(format!("{}/v1/chat/completions", url.trim_end_matches('/')))
}
fn query(endpoint: &str, model: &str, prompt: Prompt) -> Result<String, String> {
    let body = serde_json::to_vec(&json!({
        "model": model,
        "messages": [{"role":"system","content":prompt.system},{"role":"user","content":prompt.user}],
        "temperature": prompt.temperature,
        "top_p": prompt.top_p,
        "top_k": 1,
        "max_tokens": prompt.max_tokens,
        "stream": false,
        "chat_template_kwargs": {"enable_thinking":false}
    })).map_err(|e| e.to_string())?;
    let mut child = Command::new("curl")
        .args(["--silent", "--fail", "--max-time", "30", "--noproxy", "*", "--proto", "=http",
            "--header", "Content-Type: application/json", "--data-binary", "@-", "--url", endpoint])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| "Cannot start curl; install it before running this manual check.")?;
    let sent = child.stdin.take().ok_or("Missing curl stdin.")?.write_all(&body);
    if sent.is_err() { let _ = child.kill(); let _ = child.wait(); return Err("Cannot send the evaluation request.".into()); }
    let mut bytes = Vec::new();
    child.stdout.take().ok_or("Missing curl stdout.")?.take(128_001).read_to_end(&mut bytes).map_err(|_| "Cannot read the evaluation response.")?;
    if bytes.len() > 128_000 { let _ = child.kill(); let _ = child.wait(); return Err("The evaluation response exceeded the size limit.".into()); }
    if !child.wait().map_err(|_| "Cannot wait for curl.")?.success() { return Err("Local model request failed or exceeded 30 seconds; no fallback was used.".into()); }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "The local server returned invalid JSON.")?;
    value.pointer("/choices/0/message/content").and_then(Value::as_str).map(str::to_owned).ok_or_else(|| "The server returned no text completion.".into())
}
fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("Usage: cargo run --manifest-path tools/spanish-core-tests/Cargo.toml --locked --example judge_golden -- http://127.0.0.1:8080 qwen3.5-4b\nStart the exact Qwen 3.5 4B reference GGUF on that server first and use its model alias.".into());
    }
    let endpoint = local_endpoint(&args[0])?;
    let model = &args[1];
    let lower = model.to_ascii_lowercase();
    if !(lower.contains("qwen") && lower.contains("3.5") && lower.contains("4b")) {
        return Err("This benchmark targets Qwen 3.5 4B; use an explicit matching model alias and verify the loaded GGUF.".into());
    }
    let cases: Vec<Case> = include_str!("../../../frontend/src-tauri/src/spanish/golden.jsonl")
        .lines().filter(|line| !line.trim().is_empty()).map(|line| serde_json::from_str(line).map_err(|e| e.to_string())).collect::<Result<_,_>>()?;
    let (mut passed, mut failed, mut false_corrections, mut invalid) = (0, 0, 0, 0);
    let mut latencies = Vec::new();
    eprintln!("Manual synthetic corpus; model alias: {model}. Confirm the server's GGUF/version/quantization separately. This is judge-call latency, NOT first spoken-word latency.");
    for case in cases {
        let intent = text::classify(profile_language(), &case.learner);
        if intent != case.expected.intent {
            println!("{}: FAIL intent {:?} != {:?}", case.id, intent, case.expected.intent); failed += 1; continue;
        }
        if matches!(intent, Intent::EmptyOrNoise | Intent::MetaRequest | Intent::Minimal) {
            println!("{}: PASS deterministic intent (no model call)", case.id); passed += 1; continue;
        }
        let profile = SpanishProfile { level: case.level, variety: case.variety, ..Default::default() };
        let mut state = SessionState::new("golden", "just_talk", case.level);
        state.last_reply = case.question;
        let start = Instant::now();
        let raw = query(&endpoint, model, judge_prompt(&profile, &state, &case.learner, intent == Intent::EnglishMixed))?;
        let millis = start.elapsed().as_secs_f64() * 1000.0;
        latencies.push(millis);
        match policy::validate(profile.language_id(), &raw, &case.learner, intent == Intent::EnglishMixed) {
            Err(reason) => { println!("{}: FAIL invalid finding {:?} ({millis:.0} ms)", case.id, reason); failed += 1; invalid += 1; }
            Ok(finding) => {
                let error = finding.as_ref().filter(|finding| finding.has_error);
                let category = error.and_then(|f| f.category);
                let severity = error.map(|f| f.severity);
                let category_ok = category == case.expected.category || (case.expected.category.is_some() && category.is_some_and(|c| case.acceptable_categories.contains(&c)));
                let good = category_ok && severity == case.expected.severity;
                if good { passed += 1; } else { failed += 1; }
                if case.expected.category.is_none() && category.is_some() { false_corrections += 1; }
                println!("{}: {} category={:?}, severity={:?}, {millis:.0} ms", case.id, if good {"PASS"} else {"FAIL"}, category, severity);
            }
        }
    }
    latencies.sort_by(|a,b| a.total_cmp(b));
    let median = latencies.get(latencies.len()/2).copied().unwrap_or_default();
    let p95 = latencies.get(((latencies.len() as f64 * 0.95).ceil() as usize).saturating_sub(1)).copied().unwrap_or_default();
    println!("Summary: {passed} passed; {failed} failed; {false_corrections} false corrections; {invalid} invalid responses. Judge median={median:.0} ms; p95={p95:.0} ms.");
    if failed > 0 { Err("Golden mismatches require review/tuning; this run is not a model-quality pass.".into()) } else { Ok(()) }
}
fn main() { if let Err(message) = run() { eprintln!("{message}"); std::process::exit(1); } }

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn rejects_remote_and_credentials() {
        assert!(local_endpoint("http://127.0.0.1:8080").is_ok());
        for url in ["http://example.com:8080", "http://localhost.evil:8080", "http://user@localhost:8080", "http://127.0.0.1:0", "http://localhost:8080/redirect"] { assert!(local_endpoint(url).is_err()); }
    }
    #[test] fn corpus_has_unique_ids_and_valid_intents() {
        let mut ids = std::collections::HashSet::new();
        for line in include_str!("../../../frontend/src-tauri/src/spanish/golden.jsonl").lines() {
            let case: Case = serde_json::from_str(line).unwrap();
            assert!(ids.insert(case.id.clone()));
            assert_eq!(text::classify(profile_language(), &case.learner), case.expected.intent, "{}", case.id);
        }
        assert!(ids.len() >= 40);
    }
}
