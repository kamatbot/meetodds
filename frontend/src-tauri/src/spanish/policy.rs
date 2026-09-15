//! Pure teaching policy, validation, memory and recap. No model or UI calls.
use super::text;
use super::{
    Category, CategoryShown, Feedback, FeedbackKind, Level, Observation, PracticingPhrase,
    SessionState, Severity, SpanishProfile, Structure,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgeFinding {
    pub has_error: bool,
    #[serde(default)]
    pub category: Option<Category>,
    #[serde(default)]
    pub severity: Severity,
    #[serde(default)]
    pub structure: Structure,
    #[serde(default)]
    pub you_said: String,
    #[serde(default)]
    pub try_this: String,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub notable: bool,
    #[serde(default)]
    pub notable_why: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    InvalidJson,
    MissingCategory,
    Ungrounded,
    Unchanged,
    EnglishSuggestion,
    EmptySuggestion,
    TooLong,
}
/// No raw learner/model output is logged here. The caller may explicitly opt in
/// to bounded sensitive diagnostics; production diagnostics contain reason only.
pub fn validate(raw: &str, learner: &str, mixed: bool) -> Result<Option<JudgeFinding>, Rejection> {
    if raw.len() > 12_000 {
        return Err(Rejection::TooLong);
    }
    let clean = text::strip_thinking(raw);
    // Cloud models often wrap the object in ```json fences; keep only the object.
    let clean = match (clean.find('{'), clean.rfind('}')) {
        (Some(a), Some(b)) if b > a => &clean[a..=b],
        _ => clean.trim(),
    };
    let mut f: JudgeFinding = serde_json::from_str(clean).map_err(|_| Rejection::InvalidJson)?;
    if !f.has_error && !f.notable && !mixed {
        return Ok(None);
    }
    let category = f.category.ok_or(Rejection::MissingCategory)?;
    if f.you_said.len() > 2000 || f.try_this.len() > 2000 {
        return Err(Rejection::TooLong);
    }
    if f.you_said.trim().is_empty() || !text::contains_phrase(learner, &f.you_said) {
        return Err(Rejection::Ungrounded);
    }
    if f.try_this.trim().is_empty() {
        return Err(Rejection::EmptySuggestion);
    }
    if text::contains_english(&f.try_this) {
        return Err(Rejection::EnglishSuggestion);
    }
    if mixed {
        f.category = Some(Category::EnglishMixed);
        f.has_error = true;
        f.notable = false;
    }
    if f.has_error && text::speech_equivalent(&f.you_said, &f.try_this) {
        return Err(Rejection::Unchanged);
    }
    if !f.has_error && !text::contains_phrase(learner, &f.try_this) {
        return Err(Rejection::Ungrounded);
    }
    // §4 and the explicit tests resolve §3.3's contradictory long-why rule:
    // replace bad explanations with a rule template; don't lose a valid correction.
    if !text::english_explanation(&f.why) {
        f.why = explanation(f.category.unwrap_or(category)).into();
    }
    if !text::english_explanation(&f.notable_why) {
        f.notable_why = "You used this Spanish structure naturally in your answer.".into();
    }
    Ok(Some(f))
}
pub fn explanation(c: Category) -> &'static str {
    match c {
        Category::VerbTense => "The verb tense needs to match when the action happens.",
        Category::VerbConjugation => {
            "The verb ending needs to agree with the person doing the action."
        }
        Category::SerEstar => {
            "Spanish uses different verbs for identity and for states or location."
        }
        Category::GenderAgreement => {
            "The adjective and article need to match the noun's grammatical gender."
        }
        Category::NumberAgreement => {
            "The words describing a noun need to match its singular or plural form."
        }
        Category::Article => "The article needs to fit the noun and how it is used here.",
        Category::Preposition => {
            "This relationship between words needs a different preposition in Spanish."
        }
        Category::WordChoice => {
            "A different Spanish word expresses your intended meaning more clearly here."
        }
        Category::WordOrder => {
            "The order of these words needs to fit the structure of this Spanish sentence."
        }
        Category::MissingWord => {
            "This Spanish sentence needs another word to express the complete idea."
        }
        Category::EnglishMixed => {
            "This Spanish phrase expresses the idea you asked about in English."
        }
        Category::Other => {
            "This sentence structure needs an adjustment to express your intended meaning clearly."
        }
    }
}
pub fn category_name(c: Category) -> &'static str {
    match c {
        Category::VerbTense => "When actions happen",
        Category::VerbConjugation => "Verb endings",
        Category::SerEstar => "Ser and estar",
        Category::GenderAgreement => "Grammatical gender",
        Category::NumberAgreement => "Singular and plural",
        Category::Article => "Articles",
        Category::Preposition => "Prepositions",
        Category::WordChoice => "Choosing words",
        Category::WordOrder => "Word order",
        Category::MissingWord => "Complete sentences",
        Category::EnglishMixed => "Useful Spanish phrases",
        Category::Other => "Sentence structure",
    }
}
pub fn at_level(c: Category, s: Structure, level: Level) -> bool {
    if level == Level::Advanced {
        return true;
    }
    if matches!(
        s,
        Structure::Subjunctive | Structure::Conditional | Structure::Register
    ) {
        return false;
    }
    match level {
        Level::Beginner => match c {
            Category::GenderAgreement
            | Category::NumberAgreement
            | Category::Article
            | Category::MissingWord
            | Category::WordOrder
            | Category::EnglishMixed => true,
            Category::VerbConjugation | Category::SerEstar => s == Structure::Present,
            _ => false,
        },
        Level::Intermediate => {
            c != Category::Other
                && !(matches!(
                    c,
                    Category::VerbConjugation | Category::SerEstar | Category::VerbTense
                ) && s == Structure::General)
        }
        Level::Advanced => true,
    }
}
fn demonstrably_above_level(c: Category, s: Structure, level: Level) -> bool {
    if level == Level::Advanced || c == Category::Other {
        return false;
    }
    match level {
        Level::Beginner => {
            matches!(
                s,
                Structure::Past
                    | Structure::Future
                    | Structure::Subjunctive
                    | Structure::Conditional
                    | Structure::Register
            ) || matches!(c, Category::Preposition | Category::WordChoice)
        }
        Level::Intermediate => matches!(
            s,
            Structure::Subjunctive | Structure::Conditional | Structure::Register
        ),
        Level::Advanced => false,
    }
}
#[derive(Debug, Clone)]
pub enum Decision {
    Show(Feedback),
    SaveForRecap(Feedback),
    Discard,
}
pub fn decide(f: &JudgeFinding, s: &SessionState, p: &SpanishProfile) -> Decision {
    let Some(category) = f.category else {
        return Decision::Discard;
    };
    let t = s.turn_index;
    if !f.has_error {
        if !f.notable
            || s.last_card_turn == Some(t)
            || s.last_praise_turn.is_some_and(|x| t.saturating_sub(x) <= 4)
        {
            return Decision::Discard;
        }
        let practiced = p
            .practicing
            .iter()
            .any(|x| !x.mastered && text::contains_phrase(&f.you_said, &x.phrase));
        if !practiced && !demonstrably_above_level(category, f.structure, p.level) {
            return Decision::Discard;
        }
        // Respect card pacing for praise too: never crowd out conversation.
        if s.last_card_turn.is_some_and(|x| t.saturating_sub(x) <= 1) {
            return Decision::Discard;
        }
        return Decision::Show(Feedback {
            kind: if practiced {
                FeedbackKind::Practiced
            } else {
                FeedbackKind::Praise
            },
            you_said: f.you_said.clone(),
            try_this: f.try_this.clone(),
            why: f.notable_why.clone(),
            category,
            severity: f.severity,
            shown: true,
            turn_index: t,
            count: 1,
        });
    }
    let mut card = Feedback {
        kind: if category == Category::EnglishMixed {
            FeedbackKind::Translation
        } else {
            FeedbackKind::Correction
        },
        you_said: f.you_said.clone(),
        try_this: f.try_this.clone(),
        why: f.why.clone(),
        category,
        severity: f.severity,
        shown: false,
        turn_index: t,
        count: 1,
    };
    if (f.severity == Severity::Polish && p.level != Level::Advanced)
        || !at_level(category, f.structure, p.level)
        || s.shown_categories
            .iter()
            .any(|x| x.category == category && t.saturating_sub(x.turn_index) <= 3)
        || (s.last_card_turn.is_some_and(|x| t.saturating_sub(x) <= 1)
            && f.severity != Severity::Blocking)
    {
        return Decision::SaveForRecap(card);
    }
    card.shown = true;
    Decision::Show(card)
}
/// Apply once, only after cancellation/revision checks in the orchestrator.
pub fn apply(
    decision: Decision,
    s: &mut SessionState,
    p: &mut SpanishProfile,
    now: u64,
) -> Option<Feedback> {
    let (mut card, shown) = match decision {
        Decision::Show(f) => (f, true),
        Decision::SaveForRecap(f) => (f, false),
        Decision::Discard => return None,
    };
    card.shown = shown;
    card.count = s
        .feedback
        .iter()
        .filter(|x| {
            x.category == card.category
                && matches!(x.kind, FeedbackKind::Correction | FeedbackKind::Translation)
        })
        .count()
        + 1;
    if shown {
        s.last_card_turn = Some(s.turn_index);
        match card.kind {
            FeedbackKind::Correction => {
                s.shown_categories.push(CategoryShown {
                    category: card.category,
                    turn_index: s.turn_index,
                });
                add_phrase(p, &card.try_this, card.category, now);
            }
            FeedbackKind::Translation => s.shown_categories.push(CategoryShown {
                category: card.category,
                turn_index: s.turn_index,
            }),
            FeedbackKind::Praise | FeedbackKind::Practiced => {
                s.last_praise_turn = Some(s.turn_index);
                if card.kind == FeedbackKind::Practiced {
                    for x in &mut p.practicing {
                        if !x.mastered
                            && text::contains_phrase(&card.you_said, &x.phrase)
                            && mark_use(x, &s.session_id)
                        {
                            s.mastered_this_session.push(x.phrase.clone());
                        }
                    }
                }
            }
        }
    }
    s.shown_categories
        .retain(|x| s.turn_index.saturating_sub(x.turn_index) <= 3);
    s.feedback.push(card.clone());
    shown.then_some(card)
}
pub fn add_phrase(p: &mut SpanishProfile, phrase: &str, category: Category, now: u64) {
    let n = text::normalize(phrase);
    if n.is_empty() || p.practicing.iter().any(|x| text::normalize(&x.phrase) == n) {
        return;
    }
    p.practicing.push(PracticingPhrase {
        phrase: phrase.into(),
        category,
        uses: 0,
        mastered: false,
        added_at: now,
        use_session_ids: vec![],
    });
    p.practicing.sort_by_key(|x| x.added_at);
    while p.practicing.len() > 8 {
        p.practicing.remove(0);
    }
}
/// A maximum of one credited use per session prevents repeated retry exercises
/// from masquerading as transfer. Returns true only on newly reaching mastery.
pub fn mark_use(phrase: &mut PracticingPhrase, session: &str) -> bool {
    if session.is_empty() || phrase.mastered || phrase.use_session_ids.iter().any(|x| x == session)
    {
        return false;
    }
    phrase.use_session_ids.push(session.into());
    phrase.uses = phrase.uses.saturating_add(1);
    phrase.mastered = phrase.uses >= 2 && phrase.use_session_ids.len() >= 2;
    phrase.mastered
}
pub fn observe(s: &mut SessionState, p: &SpanishProfile, observation: Observation) {
    if let Some(error) = observation.error {
        s.assessed_turns += 1;
        s.error_turns += usize::from(error);
    }
    s.window.push(observation);
    if s.window.len() > 5 {
        s.window.remove(0);
    }
    let mean = s.window.iter().map(|x| x.tokens).sum::<usize>() as f32 / s.window.len() as f32;
    let assessed = s.window.iter().filter(|x| x.error.is_some()).count();
    let errors = s.window.iter().filter(|x| x.error == Some(true)).count();
    let rate = if assessed > 0 {
        errors as f32 / assessed as f32
    } else {
        1.0
    };
    if mean < 4.0 || (assessed > 0 && rate > 0.5) {
        s.dial = s.dial.saturating_sub(1);
    } else if s.window.len() == 5
        && assessed == 5
        && mean > 10.0
        && rate < 0.15
        && s.window.iter().all(|x| !x.english_mixed)
    {
        s.dial = s.dial.saturating_add(1);
    }
    s.dial = s.dial.clamp(
        p.level.dial().saturating_sub(1),
        (p.level.dial() + 1).min(3),
    );
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResult {
    pub session_id: String,
    pub level: Level,
    pub final_dial: u8,
    pub assessed_turns: usize,
    pub error_turns: usize,
}
pub fn suggest_level_bump(recent: &[SessionResult], level: Level) -> bool {
    if level == Level::Advanced || recent.len() < 3 {
        return false;
    }
    let three = &recent[recent.len() - 3..];
    three.iter().all(|x| {
        x.level == level
            && x.final_dial == level.dial() + 1
            && x.assessed_turns >= 5
            && (x.error_turns as f32 / x.assessed_turns as f32) < 0.15
    }) && three[0].session_id != three[1].session_id
        && three[0].session_id != three[2].session_id
        && three[1].session_id != three[2].session_id
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Focus {
    pub category: Category,
    pub title: String,
    pub count: usize,
    pub example: Feedback,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recap {
    pub focus_next_time: Vec<Focus>,
    pub findings: Vec<Feedback>,
    pub mastered_phrases: Vec<String>,
    pub suggest_level_bump: bool,
}
pub fn recap(s: &SessionState, p: &SpanishProfile, recent: &[SessionResult]) -> Recap {
    let mut groups: BTreeMap<Category, Vec<&Feedback>> = BTreeMap::new();
    for f in &s.feedback {
        if matches!(f.kind, FeedbackKind::Correction | FeedbackKind::Translation) {
            groups.entry(f.category).or_default().push(f);
        }
    }
    let mut focus: Vec<Focus> = groups
        .into_iter()
        .map(|(category, fs)| Focus {
            category,
            title: category_name(category).into(),
            count: fs.len(),
            example: fs[0].clone(),
        })
        .collect();
    focus.sort_by(|a, b| b.count.cmp(&a.count).then(a.category.cmp(&b.category)));
    focus.truncate(2);
    Recap {
        focus_next_time: focus,
        findings: s.feedback.clone(),
        mastered_phrases: s.mastered_this_session.clone(),
        suggest_level_bump: suggest_level_bump(recent, p.level),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fenced_judge_json_is_accepted() {
        let raw = "```json\n{\"hasError\":true,\"category\":\"verb_tense\",\"severity\":\"core\",\"structure\":\"past\",\"youSaid\":\"Ayer voy al parque\",\"tryThis\":\"Ayer fui al parque\",\"why\":\"A completed action in the past needs a past tense.\",\"notable\":false,\"notableWhy\":\"\"}\n```";
        let f = validate(raw, "Ayer voy al parque con mi hermano", false).unwrap().unwrap();
        assert_eq!(f.try_this, "Ayer fui al parque");
    }
    fn profile(level: Level) -> SpanishProfile {
        SpanishProfile {
            level,
            ..Default::default()
        }
    }
    fn finding(category: Category) -> JudgeFinding {
        JudgeFinding {
            has_error: true,
            category: Some(category),
            severity: Severity::Core,
            structure: Structure::Present,
            you_said: "La casa es bonito".into(),
            try_this: "La casa es bonita".into(),
            why: explanation(category).into(),
            notable: false,
            notable_why: String::new(),
        }
    }
    #[test]
    fn cooldown_and_blocking() {
        let p = profile(Level::Beginner);
        let mut s = SessionState::new("s", "x", p.level);
        s.turn_index = 2;
        s.last_card_turn = Some(1);
        let mut f = finding(Category::GenderAgreement);
        assert!(matches!(decide(&f, &s, &p), Decision::SaveForRecap(_)));
        f.severity = Severity::Blocking;
        assert!(matches!(decide(&f, &s, &p), Decision::Show(_)));
    }
    #[test]
    fn same_category_last_three() {
        let p = profile(Level::Beginner);
        let mut s = SessionState::new("s", "x", p.level);
        s.turn_index = 4;
        s.shown_categories.push(CategoryShown {
            category: Category::Article,
            turn_index: 1,
        });
        assert!(matches!(
            decide(&finding(Category::Article), &s, &p),
            Decision::SaveForRecap(_)
        ));
        s.turn_index = 5;
        assert!(matches!(
            decide(&finding(Category::Article), &s, &p),
            Decision::Show(_)
        ));
    }
    #[test]
    fn level_table() {
        assert!(!at_level(
            Category::VerbTense,
            Structure::Past,
            Level::Beginner
        ));
        assert!(at_level(
            Category::VerbTense,
            Structure::Past,
            Level::Intermediate
        ));
        assert!(!at_level(
            Category::VerbConjugation,
            Structure::Subjunctive,
            Level::Intermediate
        ));
        assert!(!at_level(
            Category::SerEstar,
            Structure::General,
            Level::Beginner
        ));
        assert!(at_level(
            Category::SerEstar,
            Structure::Present,
            Level::Beginner
        ));
        assert!(at_level(
            Category::Other,
            Structure::Register,
            Level::Advanced
        ));
    }
    #[test]
    fn polish_is_saved() {
        let mut f = finding(Category::Article);
        f.severity = Severity::Polish;
        assert!(matches!(
            decide(&f, &SessionState::default(), &profile(Level::Beginner)),
            Decision::SaveForRecap(_)
        ));
    }
    #[test]
    fn mixed_is_help_not_error_card() {
        let f = finding(Category::EnglishMixed);
        let Decision::Show(card) = decide(&f, &SessionState::default(), &profile(Level::Beginner))
        else {
            panic!()
        };
        assert_eq!(card.kind, FeedbackKind::Translation);
    }
    #[test]
    fn praise_cadence() {
        let p = profile(Level::Beginner);
        let mut s = SessionState::default();
        s.turn_index = 5;
        s.last_praise_turn = Some(1);
        let mut f = finding(Category::VerbTense);
        f.has_error = false;
        f.notable = true;
        f.structure = Structure::Past;
        assert!(matches!(decide(&f, &s, &p), Decision::Discard));
        s.turn_index = 6;
        assert!(matches!(decide(&f, &s, &p), Decision::Show(_)));
    }
    #[test]
    fn ordinary_correct_phrase_is_not_praise() {
        let mut f = finding(Category::Article);
        f.has_error = false;
        f.notable = true;
        assert!(matches!(
            decide(&f, &SessionState::default(), &profile(Level::Beginner)),
            Decision::Discard
        ));
    }
    #[test]
    fn unchanged_and_stt_artifacts_are_dropped() {
        let mut f = finding(Category::Article);
        f.try_this = f.you_said.clone();
        assert_eq!(
            validate(&serde_json::to_string(&f).unwrap(), &f.you_said, false).unwrap_err(),
            Rejection::Unchanged
        );
        f.you_said = "Bamos a casa".into();
        f.try_this = "Vamos a casa".into();
        assert_eq!(
            validate(&serde_json::to_string(&f).unwrap(), &f.you_said, false).unwrap_err(),
            Rejection::Unchanged
        );
    }
    #[test]
    fn invalid_category_and_english_are_dropped() {
        assert_eq!(
            validate(
                r#"{"hasError":true,"category":"invented"}"#,
                "La casa",
                false
            )
            .unwrap_err(),
            Rejection::InvalidJson
        );
        let mut f = finding(Category::Article);
        f.try_this = "The house is nice".into();
        assert_eq!(
            validate(&serde_json::to_string(&f).unwrap(), &f.you_said, false).unwrap_err(),
            Rejection::EnglishSuggestion
        );
    }
    #[test]
    fn long_or_spanish_why_uses_template() {
        let mut f = finding(Category::Article);
        for why in [
            vec!["word"; 31].join(" "),
            "Debes cambiar el articulo".into(),
        ] {
            f.why = why;
            let valid = validate(&serde_json::to_string(&f).unwrap(), &f.you_said, false)
                .unwrap()
                .unwrap();
            assert_eq!(valid.why, explanation(Category::Article));
        }
    }
    #[test]
    fn no_error_and_practiced_phrase_are_not_rejected_as_unchanged() {
        let raw = r#"{"hasError":false}"#;
        assert!(validate(raw, "Hoy hace sol", false).unwrap().is_none());
        let mut f = finding(Category::Article);
        f.has_error = false;
        f.notable = true;
        f.try_this = f.you_said.clone();
        assert!(
            validate(&serde_json::to_string(&f).unwrap(), &f.you_said, false)
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn fabricated_evidence_is_dropped() {
        let f = finding(Category::Article);
        assert_eq!(
            validate(&serde_json::to_string(&f).unwrap(), "Hoy hace sol", false).unwrap_err(),
            Rejection::Ungrounded
        );
    }
    #[test]
    fn fifo_and_dedupe() {
        let mut p = profile(Level::Beginner);
        for n in 0..10 {
            add_phrase(&mut p, &format!("frase {n}"), Category::Article, n);
        }
        assert_eq!(p.practicing.len(), 8);
        assert_eq!(p.practicing[0].phrase, "frase 2");
        add_phrase(&mut p, "¡FRASE 2!", Category::Article, 11);
        assert_eq!(p.practicing.len(), 8);
    }
    #[test]
    fn mastery_requires_two_distinct_sessions() {
        let mut p = profile(Level::Beginner);
        add_phrase(&mut p, "quiero agua", Category::Article, 1);
        let x = &mut p.practicing[0];
        assert!(!mark_use(x, "one"));
        assert!(!mark_use(x, "one"));
        assert_eq!(x.uses, 1);
        assert!(mark_use(x, "two"));
        assert!(x.mastered);
    }
    #[test]
    fn saved_findings_do_not_enter_practicing() {
        let mut p = profile(Level::Beginner);
        let mut s = SessionState::default();
        let mut f = finding(Category::VerbTense);
        f.structure = Structure::Past;
        let d = decide(&f, &s, &p);
        assert!(apply(d, &mut s, &mut p, 1).is_none());
        assert!(p.practicing.is_empty());
        assert_eq!(s.feedback.len(), 1);
        assert!(!s.feedback[0].shown);
    }
    #[test]
    fn dial_uses_known_results_not_failures() {
        let p = profile(Level::Beginner);
        let mut s = SessionState::default();
        for _ in 0..5 {
            observe(
                &mut s,
                &p,
                Observation {
                    tokens: 20,
                    error: None,
                    english_mixed: false,
                },
            );
        }
        assert_eq!(s.dial, 0);
        for _ in 0..5 {
            observe(
                &mut s,
                &p,
                Observation {
                    tokens: 20,
                    error: Some(false),
                    english_mixed: false,
                },
            );
        }
        assert_eq!(s.dial, 1);
        for _ in 0..10 {
            observe(
                &mut s,
                &p,
                Observation {
                    tokens: 20,
                    error: Some(false),
                    english_mixed: false,
                },
            );
        }
        assert_eq!(s.dial, 1);
        assert_eq!(p.level, Level::Beginner);
    }
    #[test]
    fn recap_counts_not_triangular_sum() {
        let mut p = profile(Level::Advanced);
        let mut s = SessionState::default();
        for n in 1..=3 {
            s.turn_index = n;
            let d = decide(&finding(Category::Article), &s, &p);
            apply(d, &mut s, &mut p, n as u64);
        }
        let r = recap(&s, &p, &[]);
        assert_eq!(r.focus_next_time[0].count, 3);
        assert_eq!(r.findings.len(), 3);
    }
    #[test]
    fn promotion_needs_three_distinct_complete_sessions() {
        let sessions: Vec<_> = (0..3)
            .map(|i| SessionResult {
                session_id: i.to_string(),
                level: Level::Beginner,
                final_dial: 1,
                assessed_turns: 5,
                error_turns: 0,
            })
            .collect();
        assert!(suggest_level_bump(&sessions, Level::Beginner));
        assert!(!suggest_level_bump(&sessions[..2], Level::Beginner));
    }
}
