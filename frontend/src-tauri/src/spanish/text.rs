//! Deterministic, deliberately conservative speech-text heuristics; not language identification.
use serde::{Deserialize, Serialize};

pub fn normalize(input: &str) -> String {
    let mut out = String::new();
    for c in input.to_lowercase().chars() {
        // Both precomposed and decomposed Spanish diacritics. Retain letters/digits,
        // never concatenate words across punctuation.
        let c = match c {
            'á' | 'à' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ñ' => 'n',
            '\u{0300}'..='\u{036f}' => continue,
            other => other,
        };
        if c.is_alphanumeric() {
            out.push(c);
        } else {
            out.push(' ');
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}
pub fn words(input: &str) -> Vec<String> {
    normalize(input)
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}
pub fn speech_equivalent(a: &str, b: &str) -> bool {
    fn key(s: &str) -> String {
        normalize(s)
            .replace("ll", "y")
            .replace('v', "b")
            .replace('z', "s")
    }
    key(a) == key(b)
}
pub fn contains_phrase(text: &str, phrase: &str) -> bool {
    let text = words(text);
    let phrase = words(phrase);
    !phrase.is_empty()
        && phrase.len() <= text.len()
        && text.windows(phrase.len()).any(|w| w == phrase)
}

// ~120 function/common English words. Ambiguous Spanish tokens (a, me, no, he,
// has, son) are deliberately omitted from evidence. This is only a heuristic.
const ENGLISH: &str = "the this that these those i you she it we they my your his her its our their mine yours ours theirs am is are was were be been being have had do does did doing will would shall should can could may might must and or but because although if then than as of to for from with without by at in on into onto through about during before after under over between among up down out off not never always sometimes often very too also just only even still already yet here there where when why how what which who whom whose yes please thanks thank hello goodbye want need like know think understand mean say said tell speak help repeat slower again much many more most less least some any every each all both either neither other another such own same now today yesterday tomorrow really actually so well let done get got go going went been while until unless whether however";
fn english_word(w: &str) -> bool {
    ENGLISH.split_whitespace().any(|e| e == w)
}
pub fn english_ratio(input: &str) -> f32 {
    let tokens = words(input);
    if tokens.is_empty() {
        0.0
    } else {
        tokens.iter().filter(|w| english_word(w)).count() as f32 / tokens.len() as f32
    }
}
pub fn english_question(input: &str) -> bool {
    let n = normalize(input);
    n.contains("how do you say")
        || n.contains("how can i say")
        || (n.contains("what does") && n.contains("mean"))
        || n.starts_with("what is the spanish")
}
pub fn is_english_mixed(input: &str) -> bool {
    english_question(input) || english_ratio(input) >= 0.4
}
/// Strong English tokens also reject mixed Spanish suggestions below the 40% threshold.
pub fn contains_english(input: &str) -> bool {
    is_english_mixed(input)
        || words(input).iter().any(|w| {
            "the with without would should because please yesterday tomorrow thanks"
                .split_whitespace()
                .any(|e| e == w)
        })
}
pub fn english_explanation(input: &str) -> bool {
    let n = normalize(input);
    let count = n.split_whitespace().count();
    count > 0
        && count <= 30
        && english_ratio(input) >= 0.25
        && !n.starts_with("usa ")
        && !n.starts_with("debes ")
        && input.matches(['.', '!', '?']).count() <= 1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    SpanishAttempt,
    EnglishMixed,
    MetaRequest,
    Minimal,
    EmptyOrNoise,
}
pub fn classify(input: &str) -> Intent {
    let n = normalize(input);
    let raw = input.trim();
    // Recognized one-word controls/minimal answers take precedence over the
    // brief's generic <2-word noise rule; otherwise "sí"/"repeat" disappear.
    if [
        "repeat",
        "repeat please",
        "slower",
        "otra vez",
        "mas despacio",
        "mas lento",
        "no entiendo",
        "que",
        "repite",
        "repite por favor",
    ]
    .contains(&n.as_str())
    {
        return Intent::MetaRequest;
    }
    if ["si", "no", "no se", "ok", "okay", "vale", "bien", "tal vez"].contains(&n.as_str()) {
        return Intent::Minimal;
    }
    let alphabetic = n
        .split_whitespace()
        .filter(|w| w.chars().any(char::is_alphabetic))
        .count();
    if alphabetic < 2
        || ((raw.starts_with('[') && raw.ends_with(']'))
            || (raw.starts_with('(') && raw.ends_with(')')))
        || ["silence", "inaudible", "music", "musica", "unintelligible"].contains(&n.as_str())
    {
        return Intent::EmptyOrNoise;
    }
    if is_english_mixed(input) {
        return Intent::EnglishMixed;
    }
    if n.split_whitespace().count() <= 2 {
        Intent::Minimal
    } else {
        Intent::SpanishAttempt
    }
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
pub fn clean_reply(input: &str, fallback: &str) -> (String, bool) {
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
        || english_ratio(text) >= 0.5
        || words(text).len() > 65
    {
        return (fallback.into(), false);
    }
    (text.to_string(), next)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordDiff {
    pub score: f32,
    pub missed_word_indices: Vec<usize>,
    pub missed_words: Vec<String>,
}
pub fn word_diff(target: &str, attempt: &str) -> Result<WordDiff, &'static str> {
    let a = words(target);
    let b = words(attempt);
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
pub fn practice_attempt(
    target: &str,
    attempt: &str,
    previous_attempts: u8,
) -> Result<PracticeResult, &'static str> {
    if previous_attempts >= 3 {
        return Err("This practice exercise has already ended");
    }
    let diff = word_diff(target, attempt)?;
    let succeeded = diff.score >= 0.8;
    let attempts = previous_attempts + 1;
    let message = if succeeded {
        "¡Muy bien!"
    } else if attempts == 3 {
        "Casi. Sigamos."
    } else {
        "Casi. ¿Otra vez?"
    };
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
    #[test]
    fn normalization() {
        assert_eq!(normalize("  ¡Áyer, FUI! al café… "), "ayer fui al cafe");
        assert_eq!(normalize("cafe\u{301}"), "cafe");
    }
    #[test]
    fn intents() {
        for s in [
            "how do you say parque",
            "what does bonito mean",
            "I want to order food",
        ] {
            assert_eq!(classify(s), Intent::EnglishMixed);
        }
        for s in ["repeat", "¿Qué?", "No entiendo", "más despacio"] {
            assert_eq!(classify(s), Intent::MetaRequest);
        }
        for s in ["sí", "no sé", "ok", "muy bien"] {
            assert_eq!(classify(s), Intent::Minimal);
        }
        for s in ["", "[background music]", "...", "1234", "xyz"] {
            assert_eq!(classify(s), Intent::EmptyOrNoise);
        }
        assert_eq!(classify("Ayer fui al parque"), Intent::SpanishAttempt);
    }
    #[test]
    fn spanish_shared_words_are_not_english() {
        assert!(!is_english_mixed("A mi me gusta el parque"));
        assert!(!contains_english("He ido al parque"));
        assert!(contains_english("Quiero the agua"));
    }
    #[test]
    fn phrase_boundaries() {
        assert!(contains_phrase("Yo quiero agua hoy", "quiero agua"));
        assert!(!contains_phrase("Quiero aguacate", "quiero agua"));
    }
    #[test]
    fn orthographic_noise() {
        assert!(speech_equivalent("Bamos a la caza", "Vamos a la casa"));
        assert!(!speech_equivalent(
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
            clean_reply("¿Quieres agua? [[next]]", "¿Agua o leche?"),
            ("¿Quieres agua?".into(), true)
        );
        assert_eq!(
            clean_reply("What do you want?", "¿Agua o leche?").0,
            "¿Agua o leche?"
        );
        // Real replies survive even without a closing question or with 3 sentences.
        assert_eq!(
            clean_reply("Tutor: \"¡Qué bien! Fuiste al parque. ¿Con quién fuiste?\"", "x").0,
            "¡Qué bien! Fuiste al parque. ¿Con quién fuiste?"
        );
        assert_eq!(clean_reply("Me gusta mucho el fútbol.", "x").0, "Me gusta mucho el fútbol.");
        assert_eq!(clean_reply("{\"reply\": \"hola\"}", "x").0, "x");
    }
    #[test]
    fn diff_and_threshold() {
        let d = word_diff("Ayer fui al parque contigo", "ayer fui parque contigo").unwrap();
        assert_eq!(d.score, 0.8);
        assert_eq!(d.missed_word_indices, vec![2]);
        assert!(
            practice_attempt("Ayer fui al parque contigo", "ayer fui parque contigo", 0)
                .unwrap()
                .succeeded
        );
    }
    #[test]
    fn repeated_words_count_once() {
        assert_eq!(
            word_diff("muy muy bien", "muy bien").unwrap().score,
            2.0 / 3.0
        );
    }
    #[test]
    fn three_attempts_exit_positively() {
        let r = practice_attempt("Quiero un vaso de agua", "hola", 2).unwrap();
        assert!(r.done);
        assert!(!r.succeeded);
        assert_eq!(r.message, "Casi. Sigamos.");
        assert!(practice_attempt("agua", "agua", 3).is_err());
    }
    #[test]
    fn oversized_diff_is_bounded() {
        assert!(word_diff(&vec!["a"; 65].join(" "), "a").is_err());
    }
}
