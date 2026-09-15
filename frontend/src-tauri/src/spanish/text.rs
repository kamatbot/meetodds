//! Deterministic, deliberately conservative speech-text heuristics; not language identification.
//!
//! Every language-dependent decision (which diacritics fold, which ASR
//! confusions are forgiven, how words segment, which English tokens count as
//! the learner falling back) lives in `crate::languages::text_policy`. The
//! functions here take the profile's language id and delegate; an unknown or
//! blank id resolves to Spanish (see [`super::resolve_language_id`]), which is
//! byte-for-byte the behaviour this module had when it was Spanish-only.
use super::resolve_language_id;
use crate::languages::text_policy::{self, TextPolicy};
use serde::{Deserialize, Serialize};

/// The text policy for a language id, resolved as the engine resolves every
/// language: unknown ids read as Spanish, never as the generic default.
pub fn policy(lang: &str) -> &'static TextPolicy {
    text_policy::text_policy(resolve_language_id(lang))
}

pub fn normalize(lang: &str, input: &str) -> String {
    policy(lang).normalize(input)
}
pub fn words(lang: &str, input: &str) -> Vec<String> {
    policy(lang).words(input)
}
pub fn speech_equivalent(lang: &str, a: &str, b: &str) -> bool {
    policy(lang).speech_equivalent(a, b)
}
pub fn contains_phrase(lang: &str, text: &str, phrase: &str) -> bool {
    policy(lang).contains_phrase(text, phrase)
}

/// Share of tokens that show the learner fell back to English. Zero when the
/// target language is English: there is nothing to fall back from.
pub fn english_ratio(lang: &str, input: &str) -> f32 {
    policy(lang).native_ratio(input)
}
pub fn english_question(lang: &str, input: &str) -> bool {
    policy(lang).native_question(input)
}
pub fn is_english_mixed(lang: &str, input: &str) -> bool {
    policy(lang).is_native_mixed(input)
}
/// Strong English tokens also reject mixed target-language suggestions below
/// the 40% threshold.
pub fn contains_english(lang: &str, input: &str) -> bool {
    policy(lang).contains_native(input)
}
pub fn english_explanation(lang: &str, input: &str) -> bool {
    policy(lang).native_explanation(input)
}

/// Learner intent. The variant names and their `snake_case` wire form are
/// part of the golden corpus (`golden.jsonl`) and the manual judge benchmark,
/// so they keep the Spanish-era names: `SpanishAttempt` is an attempt in the
/// profile's target language, `EnglishMixed` a fallback to the learner's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    SpanishAttempt,
    EnglishMixed,
    MetaRequest,
    Minimal,
    EmptyOrNoise,
}
impl From<text_policy::Intent> for Intent {
    fn from(intent: text_policy::Intent) -> Self {
        match intent {
            text_policy::Intent::TargetAttempt => Self::SpanishAttempt,
            text_policy::Intent::NativeMixed => Self::EnglishMixed,
            text_policy::Intent::MetaRequest => Self::MetaRequest,
            text_policy::Intent::Minimal => Self::Minimal,
            text_policy::Intent::EmptyOrNoise => Self::EmptyOrNoise,
        }
    }
}
pub fn classify(lang: &str, input: &str) -> Intent {
    policy(lang).classify(input).into()
}

/// Remove complete AND unfinished reasoning blocks; never speak a partial think block.
pub fn strip_thinking(input: &str) -> String {
    let mut rest = input;
    let mut out = String::new();
    loop {
        let lower = rest.to_ascii_lowercase();
        match lower.find("<think>") {
            None => {
                out.push_str(rest);
                break;
            }
            Some(start) => {
                out.push_str(&rest[..start]);
                if let Some(end) = lower[start + 7..].find("</think>") {
                    rest = &rest[start + 7 + end + 8..];
                } else {
                    break;
                }
            }
        }
    }
    out.trim()
        .trim_matches(|c| matches!(c, '"' | '\'' | '“' | '”' | '`'))
        .trim()
        .to_string()
}
pub fn clean_reply(lang: &str, input: &str, fallback: &str) -> (String, bool) {
    let clean = strip_thinking(input);
    let next = clean.contains("[[next]]");
    let stripped = clean.replace("[[next]]", "");
    let mut text = stripped.trim();
    // Models sometimes label or quote their own line.
    for label in ["Tutor:", "Tutora:", "Profesor:", "Profesora:", "Respuesta:"] {
        if let Some(rest) = text.strip_prefix(label) {
            text = rest.trim();
        }
    }
    let text = text.trim_matches(|c| matches!(c, '"' | '\u{201c}' | '\u{201d}' | '\'')).trim();
    // Reject only structural garbage or majority-English output. A reply that does
    // not end in a question is still the model's real reply and beats a canned line.
    if text.is_empty()
        || text.contains(['{', '}', '<', '>', '`'])
        || english_ratio(lang, text) >= 0.5
        || words(lang, text).len() > 65
    {
        return (fallback.into(), false);
    }
    (text.to_string(), next)
}

/// Keep at most `max` sentences. Small models ignore length instructions, so
/// beginners get the closing question alone rather than a paragraph.
pub fn limit_sentences(text: &str, max: usize) -> String {
    let mut sentences: Vec<String> = vec![];
    let mut current = String::new();
    for c in text.chars() {
        current.push(c);
        if matches!(c, '.' | '!' | '?') {
            let s = current.trim().to_string();
            if !s.is_empty() {
                sentences.push(s);
            }
            current.clear();
        }
    }
    let tail = current.trim();
    if !tail.is_empty() {
        sentences.push(tail.to_string());
    }
    if sentences.len() <= max.max(1) {
        return text.trim().to_string();
    }
    let keep = max.max(1);
    let last_is_question = sentences.last().is_some_and(|s| s.ends_with('?'));
    let chosen: Vec<String> = if last_is_question {
        sentences[sentences.len() - keep..].to_vec()
    } else {
        sentences[..keep].to_vec()
    };
    chosen.join(" ")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordDiff {
    pub score: f32,
    pub missed_word_indices: Vec<usize>,
    pub missed_words: Vec<String>,
}
/// Token-level diff in the profile's language: whitespace words for most
/// targets, single characters for Mandarin, so a Mandarin phrase scores per
/// character instead of as one giant token.
pub fn word_diff(lang: &str, target: &str, attempt: &str) -> Result<WordDiff, &'static str> {
    let a = words(lang, target);
    let b = words(lang, attempt);
    if a.is_empty() || a.len() > 64 || b.len() > 128 {
        return Err("Practice phrase or attempt is outside the supported word budget");
    }
    let mut dp = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in 0..a.len() {
        for j in 0..b.len() {
            dp[i + 1][j + 1] = if a[i] == b[j] {
                dp[i][j] + 1
            } else {
                dp[i][j + 1].max(dp[i + 1][j])
            };
        }
    }
    let mut matched = vec![false; a.len()];
    let (mut i, mut j) = (a.len(), b.len());
    while i > 0 && j > 0 {
        if a[i - 1] == b[j - 1] {
            matched[i - 1] = true;
            i -= 1;
            j -= 1;
        } else if dp[i - 1][j] >= dp[i][j - 1] {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    let missed_word_indices: Vec<usize> = (0..a.len()).filter(|i| !matched[*i]).collect();
    let missed_words = missed_word_indices.iter().map(|i| a[*i].clone()).collect();
    Ok(WordDiff {
        score: dp[a.len()][b.len()] as f32 / a.len() as f32,
        missed_word_indices,
        missed_words,
    })
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeResult {
    pub diff: WordDiff,
    pub message: String,
    pub done: bool,
    pub succeeded: bool,
    pub attempts: u8,
}
/// Spoken feedback after a practice attempt. Spanish keeps its reviewed lines
/// verbatim; the registry carries no such lines for the other languages, so
/// they get the learner's own language (English, like every explanation the
/// tutor shows) rather than a Spanish line or an unreviewed translation.
fn practice_message(lang: &str, succeeded: bool, last: bool) -> &'static str {
    match (resolve_language_id(lang) == super::LEGACY_LANGUAGE_ID, succeeded, last) {
        (true, true, _) => "¡Muy bien!",
        (true, false, true) => "Casi. Sigamos.",
        (true, false, false) => "Casi. ¿Otra vez?",
        (false, true, _) => "Very good!",
        (false, false, true) => "Almost. Let's move on.",
        (false, false, false) => "Almost. Once more?",
    }
}
pub fn practice_attempt(
    lang: &str,
    target: &str,
    attempt: &str,
    previous_attempts: u8,
) -> Result<PracticeResult, &'static str> {
    if previous_attempts >= 3 {
        return Err("This practice exercise has already ended");
    }
    let diff = word_diff(lang, target, attempt)?;
    let succeeded = diff.score >= 0.8;
    let attempts = previous_attempts + 1;
    let message = practice_message(lang, succeeded, attempts == 3);
    Ok(PracticeResult {
        diff,
        message: message.into(),
        done: succeeded || attempts == 3,
        succeeded,
        attempts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Every legacy assertion below is Spanish; the language id is the only
    /// change to these call sites.
    const ES: &str = "es";
    #[test]
    fn normalization() {
        assert_eq!(normalize(ES, "  ¡Áyer, FUI! al café… "), "ayer fui al cafe");
        assert_eq!(normalize(ES, "cafe\u{301}"), "cafe");
    }
    #[test]
    fn intents() {
        for s in [
            "how do you say parque",
            "what does bonito mean",
            "I want to order food",
        ] {
            assert_eq!(classify(ES, s), Intent::EnglishMixed);
        }
        for s in ["repeat", "¿Qué?", "No entiendo", "más despacio"] {
            assert_eq!(classify(ES, s), Intent::MetaRequest);
        }
        for s in ["sí", "no sé", "ok", "muy bien"] {
            assert_eq!(classify(ES, s), Intent::Minimal);
        }
        for s in ["", "[background music]", "...", "1234", "xyz"] {
            assert_eq!(classify(ES, s), Intent::EmptyOrNoise);
        }
        assert_eq!(classify(ES, "Ayer fui al parque"), Intent::SpanishAttempt);
    }
    #[test]
    fn spanish_shared_words_are_not_english() {
        assert!(!is_english_mixed(ES, "A mi me gusta el parque"));
        assert!(!contains_english(ES, "He ido al parque"));
        assert!(contains_english(ES, "Quiero the agua"));
    }
    #[test]
    fn phrase_boundaries() {
        assert!(contains_phrase(ES, "Yo quiero agua hoy", "quiero agua"));
        assert!(!contains_phrase(ES, "Quiero aguacate", "quiero agua"));
    }
    #[test]
    fn orthographic_noise() {
        assert!(speech_equivalent(ES, "Bamos a la caza", "Vamos a la casa"));
        assert!(!speech_equivalent(
            ES,
            "Ayer voy al parque",
            "Ayer fui al parque"
        ));
    }
    #[test]
    fn hidden_reasoning() {
        assert_eq!(
            strip_thinking("<think>secret</think>\"¿Qué quieres?\""),
            "¿Qué quieres?"
        );
        assert_eq!(strip_thinking("<think>unfinished"), "");
    }
    #[test]
    fn reply_marker_never_spoken() {
        assert_eq!(
            clean_reply(ES, "¿Quieres agua? [[next]]", "¿Agua o leche?"),
            ("¿Quieres agua?".into(), true)
        );
        assert_eq!(
            clean_reply(ES, "What do you want?", "¿Agua o leche?").0,
            "¿Agua o leche?"
        );
        // Real replies survive even without a closing question or with 3 sentences.
        assert_eq!(
            clean_reply(ES, "Tutor: \"¡Qué bien! Fuiste al parque. ¿Con quién fuiste?\"", "x").0,
            "¡Qué bien! Fuiste al parque. ¿Con quién fuiste?"
        );
        assert_eq!(clean_reply(ES, "Me gusta mucho el fútbol.", "x").0, "Me gusta mucho el fútbol.");
        assert_eq!(clean_reply(ES, "{\"reply\": \"hola\"}", "x").0, "x");
    }
    #[test]
    fn sentence_limit_keeps_the_question() {
        assert_eq!(
            limit_sentences("¡Qué bien! Me gusta el parque. ¿Qué hiciste allí?", 1),
            "¿Qué hiciste allí?"
        );
        assert_eq!(
            limit_sentences("¡Qué bien! Me gusta el parque. ¿Qué hiciste allí?", 2),
            "Me gusta el parque. ¿Qué hiciste allí?"
        );
        assert_eq!(limit_sentences("Me gusta el pan. Es rico.", 1), "Me gusta el pan.");
        assert_eq!(limit_sentences("¿Y tú?", 1), "¿Y tú?");
    }
    #[test]
    fn diff_and_threshold() {
        let d = word_diff(ES, "Ayer fui al parque contigo", "ayer fui parque contigo").unwrap();
        assert_eq!(d.score, 0.8);
        assert_eq!(d.missed_word_indices, vec![2]);
        assert!(
            practice_attempt(ES, "Ayer fui al parque contigo", "ayer fui parque contigo", 0)
                .unwrap()
                .succeeded
        );
    }
    #[test]
    fn repeated_words_count_once() {
        assert_eq!(
            word_diff(ES, "muy muy bien", "muy bien").unwrap().score,
            2.0 / 3.0
        );
    }
    #[test]
    fn three_attempts_exit_positively() {
        let r = practice_attempt(ES, "Quiero un vaso de agua", "hola", 2).unwrap();
        assert!(r.done);
        assert!(!r.succeeded);
        assert_eq!(r.message, "Casi. Sigamos.");
        assert!(practice_attempt(ES, "agua", "agua", 3).is_err());
    }
    #[test]
    fn oversized_diff_is_bounded() {
        assert!(word_diff(ES, &vec!["a"; 65].join(" "), "a").is_err());
    }
    #[test]
    fn mandarin_tokens_are_characters_and_unknown_language_is_spanish() {
        // Whitespace-free scripts segment per character, so a Mandarin
        // learner's token counts, phrase grounding and practice diffs work.
        assert_eq!(words("zh", "我喜欢喝茶").len(), 5);
        assert_eq!(words("es", "我喜欢喝茶").len(), 1);
        assert_eq!(classify("zh", "我喜欢喝茶"), Intent::SpanishAttempt);
        assert_eq!(classify("zh", "再说一遍"), Intent::MetaRequest);
        assert!(contains_phrase("zh", "我今天喜欢喝茶", "喜欢喝茶"));
        let d = word_diff("zh", "我喜欢喝茶", "我喜欢茶").unwrap();
        assert_eq!(d.score, 0.8);
        assert_eq!(d.missed_words, vec!["喝"]);
        // Spanish practice lines are untouched; other languages get English.
        assert_eq!(practice_attempt("es", "agua", "agua", 0).unwrap().message, "¡Muy bien!");
        assert_eq!(practice_attempt("zh", "茶", "茶", 0).unwrap().message, "Very good!");
        // German keeps ß and umlauts; Spanish folding is not applied to it.
        assert_eq!(normalize("de", "Straße"), "straße");
        assert_eq!(normalize("es", "Straße"), "straße");
        assert_eq!(classify("de", "Ich möchte bitte einen Kaffee"), Intent::SpanishAttempt);
        // A blank or unknown id behaves exactly like Spanish, never panics.
        for lang in ["", "xx", "  "] {
            assert_eq!(normalize(lang, "¡Áyer, FUI!"), normalize("es", "¡Áyer, FUI!"));
            assert!(speech_equivalent(lang, "Bamos a la caza", "Vamos a la casa"));
            assert_eq!(classify(lang, "Ayer fui al parque"), Intent::SpanishAttempt);
            assert_eq!(classify(lang, "más despacio"), Intent::MetaRequest);
        }
        assert!(!speech_equivalent("de", "Bamos a la caza", "Vamos a la casa"));
    }
    #[test]
    fn english_target_replies_are_never_rejected_as_english() {
        assert_eq!(
            clean_reply("en", "What would you like to drink?", "x").0,
            "What would you like to drink?"
        );
        assert_eq!(clean_reply("es", "What would you like to drink?", "x").0, "x");
    }
}
