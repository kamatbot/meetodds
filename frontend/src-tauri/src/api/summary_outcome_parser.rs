// Included by meeting_intelligence.rs. This parser reads AI OUTPUT only.
// Transcripts may supply an evidence link; they never create or replace a task.

fn classify_heading(heading: &str) -> Option<&'static str> {
    let heading = heading.trim_matches('*').trim().to_lowercase();
    if heading.contains("decision") || heading.contains("agreed") { Some("decision") }
    else if heading.contains("action") || heading.contains("next step") || heading.contains("commitment") || heading.contains("follow-up") || heading.contains("follow up") { Some("action") }
    else if heading.contains("open question") || heading.contains("unresolved") || heading == "questions" || heading.contains("question to resolve") { Some("open_question") }
    else if heading.contains("outcome") || heading.contains("executive summary") || heading == "summary" || heading.contains("meeting overview") { Some("outcome") }
    else { None }
}

fn marker_kind(line: &str) -> Option<&'static str> {
    match line.trim() {
        "<!-- meetodds:outcome -->" => Some("outcome"),
        "<!-- meetodds:decisions -->" => Some("decision"),
        "<!-- meetodds:actions -->" => Some("action"),
        "<!-- meetodds:questions -->" => Some("open_question"),
        _ => None,
    }
}

fn clean_candidate_line(line: &str) -> String {
    let mut value = line.trim();
    for prefix in ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "+ ", "• "] {
        if let Some(rest) = value.strip_prefix(prefix) { value = rest.trim(); break; }
    }
    let prefix: String = value.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ')' || c.is_whitespace()).collect();
    if prefix.chars().any(|c| c.is_ascii_digit()) && (prefix.contains('.') || prefix.contains(')')) { value = value[prefix.len()..].trim(); }
    value.trim_matches('`').trim().to_string()
}

fn useful_candidate(text: &str) -> bool {
    let cleaned = text.trim().trim_matches('*').trim().trim_end_matches('.');
    let lower = cleaned.to_lowercase();
    !cleaned.is_empty() && cleaned.chars().count() >= 3
        && !["none", "n/a", "unknown", "not specified", "not discussed", "no action items", "no actions", "ninguna", "ninguno", "aucun", "aucune", "keine", "ไม่มี", "なし", "无", "無"].contains(&lower.as_str())
        && !["none noted", "not discussed", "no decision", "no action", "no open question"].iter().any(|p| lower.starts_with(p))
        && !lower.starts_with("<!--")
}

fn inline_text(value: &Value) -> String {
    if let Some(text) = value.as_str() { return text.to_string(); }
    if let Some(items) = value.as_array() { return items.iter().map(inline_text).collect::<Vec<_>>().join(""); }
    value.get("text").and_then(Value::as_str).map(str::to_string)
        .or_else(|| value.get("content").map(inline_text)).unwrap_or_default()
}

fn json_summary_to_markdown(value: &Value) -> String {
    if let Some(markdown) = value.get("markdown").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) { return markdown.to_string(); }
    if let Some(blocks) = value.get("summary_json").and_then(Value::as_array) {
        fn blocks_to_markdown(blocks: &[Value], out: &mut String) {
            for block in blocks {
                let text = block.get("content").map(inline_text).unwrap_or_default();
                let heading = block.get("type").and_then(Value::as_str) == Some("heading");
                out.push_str(if heading { "\n## " } else { "- " }); out.push_str(&text); out.push('\n');
                if let Some(children) = block.get("children").and_then(Value::as_array) { blocks_to_markdown(children, out); }
            }
        }
        let mut out = String::new(); blocks_to_markdown(blocks, &mut out); return out;
    }
    let mut out = String::new();
    if let Some(object) = value.as_object() {
        let keys: Vec<&str> = value.get("_section_order").and_then(Value::as_array)
            .map(|keys| keys.iter().filter_map(Value::as_str).collect())
            .unwrap_or_else(|| object.keys().map(String::as_str).collect());
        for key in keys {
            if key.starts_with('_') || key == "MeetingName" { continue; }
            let Some(section) = object.get(key) else { continue; };
            let Some(blocks) = section.get("blocks").and_then(Value::as_array) else { continue; };
            let title = section.get("title").and_then(Value::as_str).unwrap_or(key);
            out.push_str(&format!("\n## {title}\n"));
            for block in blocks { out.push_str("- "); out.push_str(&block.get("content").map(inline_text).unwrap_or_default()); out.push('\n'); }
        }
    }
    out
}

fn summary_markdown(result: Option<String>) -> String {
    let Some(result) = result else { return String::new(); };
    match serde_json::from_str::<Value>(&result) {
        Ok(Value::String(text)) => text,
        Ok(value) => json_summary_to_markdown(&value),
        Err(_) if !result.trim_start().starts_with('{') && !result.trim_start().starts_with('[') => result,
        Err(_) => String::new(),
    }
}

fn parse_summary_candidates(markdown: &str, transcripts: &[TranscriptSource]) -> Vec<DerivedCandidate> {
    let marked = markdown.lines().any(|line| marker_kind(line).is_some());
    let mut kind: Option<&'static str> = None;
    let mut line_buffer = String::new();
    let mut candidates = Vec::new();
    let mut in_fence = false;
    let flush = |kind: Option<&'static str>, buffer: &mut String, result: &mut Vec<DerivedCandidate>| {
        let original = std::mem::take(buffer);
        let Some(kind) = kind else { return; };
        let pieces: Vec<&str> = original.split(" | ").collect();
        let text = clean_candidate_line(pieces.first().copied().unwrap_or_default());
        if !useful_candidate(&text) || (kind == "outcome" && result.iter().any(|c| c.kind == "outcome")) { return; }
        let mut owner = None; let mut due_text = None; let mut commitment = "detected";
        if kind == "action" {
            for part in pieces.iter().skip(1) {
                if let Some((key, value)) = part.split_once(':') {
                    let value = value.trim().trim_matches('*').trim();
                    if ["unknown", "none", "not specified", "unassigned", "n/a"].contains(&value.to_lowercase().as_str()) || value.is_empty() { continue; }
                    match key.trim().to_ascii_lowercase().as_str() {
                        "owner" => owner = Some(value.to_string()),
                        "due" => due_text = Some(value.to_string()),
                        "commitment" if value.eq_ignore_ascii_case("agreed") => commitment = "agreed",
                        "commitment" if value.eq_ignore_ascii_case("proposed") => commitment = "proposed",
                        _ => {},
                    }
                }
            }
        }
        let matched = best_evidence(&text, transcripts);
        let confidence = matched.as_ref().map(|(_, score)| *score).unwrap_or(0.0);
        if result.iter().any(|c| c.kind == kind && normalize_for_key(&c.text) == normalize_for_key(&text)) { return; }
        result.push(DerivedCandidate {
            kind, text, state: match kind { "decision" => "agreed", "open_question" => "open", "outcome" => "stated", _ => "detected" }.to_string(),
            owner, due_text, commitment_state: (kind == "action").then(|| commitment.to_string()), evidence: matched.map(|(source, _)| source), confidence,
        });
    };
    for raw in markdown.lines() {
        let line = raw.trim();
        if line.starts_with("```") { flush(kind, &mut line_buffer, &mut candidates); in_fence = !in_fence; continue; }
        if in_fence { continue; }
        if line.starts_with("<!-- meetodds:") { flush(kind, &mut line_buffer, &mut candidates); kind = marker_kind(line); continue; }
        if line.starts_with('#') {
            flush(kind, &mut line_buffer, &mut candidates);
            if !marked { kind = classify_heading(line.trim_start_matches('#').trim()); }
            continue;
        }
        if line.is_empty() { flush(kind, &mut line_buffer, &mut candidates); continue; }
        if kind.is_none() || line.starts_with("<!--") { continue; }
        let bullet = ["- ", "* ", "+ ", "• "].iter().any(|prefix| line.starts_with(prefix))
            || line.chars().next().is_some_and(|c| c.is_ascii_digit()) && (line.contains(". ") || line.contains(") "));
        if bullet { flush(kind, &mut line_buffer, &mut candidates); }
        if !line_buffer.is_empty() { line_buffer.push(' '); }
        line_buffer.push_str(&clean_candidate_line(line));
    }
    flush(kind, &mut line_buffer, &mut candidates);
    candidates
}
