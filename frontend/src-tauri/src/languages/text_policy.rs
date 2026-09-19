//! Per-language TEXT behaviour for the unified tutoring engine.
//!
//! `spanish::text` hardcodes Spanish at four points: which diacritics
//! `normalize()` folds, which ASR confusions `speech_equivalent()` forgives,
//! how `words()` segments, and an English stopword list that detects the
//! learner falling back to English. A [`TextPolicy`] carries those four
//! decisions (plus the control words intent classification keys off) for ONE
//! target language, so the engine can stop knowing about Spanish.
//!
//! Deterministic and deliberately conservative; this is not language
//! identification. The `es` policy reproduces `spanish::text` exactly (see the
//! `spanish_parity_*` tests). Only `std` and `serde`: no regex, no unicode
//! crates, and nothing here can panic on model output or stored profile data.

use serde::{Deserialize, Serialize};

/// Where a speech-equivalence rule applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum At {
    /// Every occurrence in the normalized string (`str::replace` semantics,
    /// which is what the Spanish rules use).
    Anywhere,
    /// Only as a word prefix.
    WordStart,
    /// Only as a word suffix, and only on words of at least `min_len` chars.
    /// The length gate keeps short function words (fr `les`, `chez`, en
    /// `our`, `hour`) out of rules meant for open-class words.
    WordEnd { min_len: usize },
    /// Only when the whole token equals `from`. For languages with no fixed
    /// spelling (Roman Hindi `nahi`/`nahin`, `kya`/`kyaa`) a variant is a
    /// property of the word, not of a letter sequence: `Anywhere` rules would
    /// fold substrings of unrelated words.
    Word,
}

/// One ASR confusion the tutor forgives: `from` and `to` sound the same in the
/// target language, so a transcript spelling one for the other is noise, not
/// a learner error. Rules run in order on the normalized text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Equivalence {
    pub from: &'static str,
    pub to: &'static str,
    pub at: At,
}

const fn anywhere(from: &'static str, to: &'static str) -> Equivalence {
    Equivalence { from, to, at: At::Anywhere }
}
const fn word_start(from: &'static str, to: &'static str) -> Equivalence {
    Equivalence { from, to, at: At::WordStart }
}
const fn word_end(from: &'static str, to: &'static str, min_len: usize) -> Equivalence {
    Equivalence { from, to, at: At::WordEnd { min_len } }
}
const fn word(from: &'static str, to: &'static str) -> Equivalence {
    Equivalence { from, to, at: At::Word }
}

/// What the learner's utterance is, before the model sees it. Mirrors
/// `spanish::text::Intent` with the language-specific variants renamed:
/// `SpanishAttempt` → `TargetAttempt`, `EnglishMixed` → `NativeMixed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    TargetAttempt,
    NativeMixed,
    MetaRequest,
    Minimal,
    EmptyOrNoise,
}

/// How one target language's text behaves. All fields are data so a policy can
/// live in a `static`; the methods are the engine-facing API.
pub struct TextPolicy {
    /// Stable language id (`languages::LanguageModule::id`), or `"default"`.
    pub id: &'static str,
    /// The learner's own language, i.e. the language they fall back to. Only
    /// English evidence exists today, so this is always `"en"`; it is a field
    /// so `id == native_id` (an English-target learner speaking English) is an
    /// explicit, testable case rather than an accident of the stopword list.
    pub native_id: &'static str,
    /// `false` for scripts written without spaces (Mandarin). Then `words()`
    /// segments per CJK codepoint instead of on whitespace; otherwise
    /// `contains_phrase` and every ratio silently see one giant token.
    pub whitespace_segmented: bool,
    /// Keep combining marks (U+0300..=U+036F) attached instead of dropping
    /// them. Mandarin: tone-marked pinyin such as `ni\u{30C}` must not split.
    pub keep_combining_marks: bool,
    /// Letters of the target alphabet that must survive `normalize()` intact
    /// even when they arrive decomposed (nb `æ ø å`, de `ß`). Everything the
    /// `fold` maps is implicitly preserved-by-folding; this is for letters the
    /// fold deliberately leaves alone.
    pub native_letters: &'static [char],
    /// Diacritic folding applied by `normalize()` after lowercasing. `None`
    /// keeps the char as-is (alphanumerics are kept, everything else becomes a
    /// word boundary). `Some("")` drops it.
    pub fold: fn(char) -> Option<&'static str>,
    /// Speech-equivalence rules, applied in order to `normalize()` output.
    pub equivalences: &'static [Equivalence],
    /// Words in the English evidence list that are also ordinary words of the
    /// target language (de `was`, nb `i`, fr `on`). Removed from evidence so
    /// a correct target-language sentence is never counted as mixing.
    pub native_homographs: &'static [&'static str],
    /// Normalized prefixes of a native-language "how do I say X" question,
    /// beyond the shared `how do you say` / `what does … mean` patterns.
    pub native_question_prefixes: &'static [&'static str],
    /// Normalized prefixes that mark a judge explanation as written in the
    /// target language instead of the learner's (es `usa `, `debes `).
    pub explanation_rejects: &'static [&'static str],
    /// Whole normalized utterances that are control requests (repeat, slower).
    pub meta_words: &'static [&'static str],
    /// Whole normalized utterances that are minimal answers (yes, no, ok).
    pub minimal_words: &'static [&'static str],
    /// Whole normalized utterances that are ASR noise markers.
    pub noise_words: &'static [&'static str],
}

fn is_combining_mark(c: char) -> bool {
    ('\u{0300}'..='\u{036f}').contains(&c)
}

/// CJK codepoints, plus kana and bopomofo: scripts written without spaces.
fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x3005 | 0x3040..=0x30FF | 0x3100..=0x312F | 0x31A0..=0x31BF | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x323AF
    )
}

/// Precompose a lowercase base letter with a following combining mark, so
/// decomposed input folds the same way as precomposed input. Only pairs some
/// policy cares about; everything else falls back to "keep base, drop mark",
/// which is what `spanish::text::normalize` does for every pair.
fn compose(base: char, mark: char) -> Option<char> {
    Some(match (base, mark) {
        ('a', '\u{300}') => 'à',
        ('a', '\u{301}') => 'á',
        ('a', '\u{302}') => 'â',
        ('a', '\u{303}') => 'ã',
        ('a', '\u{308}') => 'ä',
        ('a', '\u{30a}') => 'å',
        ('e', '\u{300}') => 'è',
        ('e', '\u{301}') => 'é',
        ('e', '\u{302}') => 'ê',
        ('e', '\u{308}') => 'ë',
        ('i', '\u{300}') => 'ì',
        ('i', '\u{301}') => 'í',
        ('i', '\u{302}') => 'î',
        ('i', '\u{308}') => 'ï',
        ('o', '\u{300}') => 'ò',
        ('o', '\u{301}') => 'ó',
        ('o', '\u{302}') => 'ô',
        ('o', '\u{303}') => 'õ',
        ('o', '\u{308}') => 'ö',
        ('u', '\u{300}') => 'ù',
        ('u', '\u{301}') => 'ú',
        ('u', '\u{302}') => 'û',
        ('u', '\u{308}') => 'ü',
        ('n', '\u{303}') => 'ñ',
        ('c', '\u{327}') => 'ç',
        ('y', '\u{301}') => 'ý',
        ('y', '\u{308}') => 'ÿ',
        _ => return None,
    })
}

impl TextPolicy {
    /// The learner's native language is the target: mixing cannot happen.
    pub fn targets_native(&self) -> bool {
        self.id == self.native_id
    }

    /// Lowercase, fold diacritics per policy, keep letters/digits, turn
    /// everything else into a single space. Never concatenates words across
    /// punctuation. For `es` this is byte-for-byte `spanish::text::normalize`.
    pub fn normalize(&self, input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        let lowered = input.to_lowercase();
        let mut chars = lowered.chars().peekable();
        while let Some(mut c) = chars.next() {
            // Precompose base+mark only when this policy has an opinion about
            // the composed letter; otherwise the mark is handled below exactly
            // as the legacy code handled it (kept base, dropped mark).
            while let Some(&mark) = chars.peek() {
                match compose(c, mark).filter(|&x| {
                    (self.fold)(x).is_some() || self.native_letters.contains(&x)
                }) {
                    Some(composed) => {
                        c = composed;
                        chars.next();
                    }
                    None => break,
                }
            }
            if is_combining_mark(c) {
                if self.keep_combining_marks {
                    out.push(c);
                }
                continue;
            }
            match (self.fold)(c) {
                Some(folded) => out.push_str(folded),
                None if c.is_alphanumeric() => out.push(c),
                None => out.push(' '),
            }
        }
        out.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// Normalized word tokens. Whitespace-delimited for segmented languages;
    /// for unsegmented scripts every CJK codepoint is its own token while runs
    /// of other characters (digits, pinyin, loanwords) stay whole.
    pub fn words(&self, input: &str) -> Vec<String> {
        let normalized = self.normalize(input);
        if self.whitespace_segmented {
            return normalized.split_whitespace().map(str::to_owned).collect();
        }
        let mut out: Vec<String> = Vec::new();
        for token in normalized.split_whitespace() {
            let mut run = String::new();
            for c in token.chars() {
                if is_cjk(c) {
                    if !run.is_empty() {
                        out.push(std::mem::take(&mut run));
                    }
                    out.push(c.to_string());
                } else if is_combining_mark(c) && run.is_empty() {
                    // A mark right after a CJK char attaches to it rather than
                    // becoming a phantom token.
                    match out.last_mut() {
                        Some(last) => last.push(c),
                        None => run.push(c),
                    }
                } else {
                    run.push(c);
                }
            }
            if !run.is_empty() {
                out.push(run);
            }
        }
        out
    }

    /// The comparison key behind `speech_equivalent`: normalized text with the
    /// policy's equivalence rules applied in order.
    pub fn speech_key(&self, input: &str) -> String {
        let mut key = self.normalize(input);
        for rule in self.equivalences {
            key = match rule.at {
                At::Anywhere => key.replace(rule.from, rule.to),
                At::WordStart => key
                    .split(' ')
                    .map(|w| match w.strip_prefix(rule.from) {
                        Some(rest) => format!("{}{rest}", rule.to),
                        None => w.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
                At::WordEnd { min_len } => key
                    .split(' ')
                    .map(|w| {
                        if w.chars().count() < min_len {
                            return w.to_string();
                        }
                        match w.strip_suffix(rule.from) {
                            Some(stem) => format!("{stem}{}", rule.to),
                            None => w.to_string(),
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
                At::Word => key
                    .split(' ')
                    .map(|w| if w == rule.from { rule.to.to_string() } else { w.to_string() })
                    .collect::<Vec<_>>()
                    .join(" "),
            };
        }
        key
    }

    /// `a` and `b` differ only by ASR confusions this language forgives.
    pub fn speech_equivalent(&self, a: &str, b: &str) -> bool {
        self.speech_key(a) == self.speech_key(b)
    }

    /// `phrase` occurs in `text` on token boundaries (no `agua`-in-`aguacate`).
    pub fn contains_phrase(&self, text: &str, phrase: &str) -> bool {
        let text = self.words(text);
        let phrase = self.words(phrase);
        !phrase.is_empty()
            && phrase.len() <= text.len()
            && text.windows(phrase.len()).any(|w| w == phrase)
    }

    fn native_word(&self, w: &str) -> bool {
        NATIVE_ENGLISH.split_whitespace().any(|e| e == w) && !self.native_homographs.contains(&w)
    }

    /// Share of tokens that are native-language evidence, regardless of target.
    /// Private: callers want [`TextPolicy::native_ratio`], which knows that an
    /// English-target learner speaking English is not mixing.
    fn raw_native_ratio(&self, input: &str) -> f32 {
        let tokens = self.words(input);
        if tokens.is_empty() {
            0.0
        } else {
            tokens.iter().filter(|w| self.native_word(w)).count() as f32 / tokens.len() as f32
        }
    }

    /// Share of tokens that show the learner fell back to their native language.
    /// Always `0.0` when the target IS the native language: there is nothing to
    /// fall back from, and callers use this to reject majority-native replies.
    pub fn native_ratio(&self, input: &str) -> f32 {
        if self.targets_native() {
            0.0
        } else {
            self.raw_native_ratio(input)
        }
    }

    /// A native-language "how do I say X" / "what does X mean" question.
    pub fn native_question(&self, input: &str) -> bool {
        if self.targets_native() {
            return false;
        }
        let n = self.normalize(input);
        n.contains("how do you say")
            || n.contains("how can i say")
            || (n.contains("what does") && n.contains("mean"))
            || self.native_question_prefixes.iter().any(|p| n.starts_with(p))
    }

    /// The learner fell back to a language that is not the target.
    pub fn is_native_mixed(&self, input: &str) -> bool {
        self.native_question(input) || self.native_ratio(input) >= 0.4
    }

    /// Strong native tokens also reject mixed suggestions below the 40% ratio
    /// threshold. Guards the judge's `try_this`, which must be target-language.
    pub fn contains_native(&self, input: &str) -> bool {
        if self.targets_native() {
            return false;
        }
        self.is_native_mixed(input)
            || self
                .words(input)
                .iter()
                .any(|w| STRONG_ENGLISH.split_whitespace().any(|e| e == w) && self.native_word(w))
    }

    /// A short judge explanation written in the learner's native language.
    /// This is a positive check, so it uses the raw ratio even for the English
    /// target: an English explanation to an English learner is correct.
    pub fn native_explanation(&self, input: &str) -> bool {
        let n = self.normalize(input);
        let count = n.split_whitespace().count();
        count > 0
            && count <= 30
            && self.raw_native_ratio(input) >= 0.25
            && !self.explanation_rejects.iter().any(|p| n.starts_with(p))
            && input.matches(['.', '!', '?']).count() <= 1
    }

    /// Intent of a learner utterance. Recognized one-word controls and minimal
    /// answers take precedence over the generic "<2 words is noise" rule, or
    /// "sí" / "repeat" / "对" would disappear.
    pub fn classify(&self, input: &str) -> Intent {
        let n = self.normalize(input);
        let raw = input.trim();
        if self.meta_words.contains(&n.as_str()) {
            return Intent::MetaRequest;
        }
        if self.minimal_words.contains(&n.as_str()) {
            return Intent::Minimal;
        }
        let tokens = self.words(input);
        let alphabetic = tokens.iter().filter(|w| w.chars().any(char::is_alphabetic)).count();
        if alphabetic < 2
            || ((raw.starts_with('[') && raw.ends_with(']'))
                || (raw.starts_with('(') && raw.ends_with(')')))
            || self.noise_words.contains(&n.as_str())
        {
            return Intent::EmptyOrNoise;
        }
        if self.is_native_mixed(input) {
            return Intent::NativeMixed;
        }
        if tokens.len() <= 2 {
            Intent::Minimal
        } else {
            Intent::TargetAttempt
        }
    }
}

// ~120 function/common English words. Ambiguous Spanish tokens (a, me, no, he,
// has, son) are deliberately omitted from evidence. Verbatim from
// `spanish::text::ENGLISH`; per-target homographs are subtracted at match time.
const NATIVE_ENGLISH: &str = "the this that these those i you she it we they my your his her its our their mine yours ours theirs am is are was were be been being have had do does did doing will would shall should can could may might must and or but because although if then than as of to for from with without by at in on into onto through about during before after under over between among up down out off not never always sometimes often very too also just only even still already yet here there where when why how what which who whom whose yes please thanks thank hello goodbye want need like know think understand mean say said tell speak help repeat slower again much many more most less least some any every each all both either neither other another such own same now today yesterday tomorrow really actually so well let done get got go going went been while until unless whether however";
const STRONG_ENGLISH: &str =
    "the with without would should because please yesterday tomorrow thanks";

// ---------------------------------------------------------------------------
// Folding tables
// ---------------------------------------------------------------------------

/// Verbatim `spanish::text::normalize` table. Folds both the accents Spanish
/// uses and their grave/circumflex/diaeresis neighbours, because ASR and
/// keyboards produce them. Note it folds `ä`→`a` and leaves `ç`, `ã`, `œ`
/// alone; the parity tests pin that.
fn fold_spanish(c: char) -> Option<&'static str> {
    Some(match c {
        'á' | 'à' | 'â' | 'ä' => "a",
        'é' | 'è' | 'ê' | 'ë' => "e",
        'í' | 'ì' | 'î' | 'ï' => "i",
        'ó' | 'ò' | 'ô' | 'ö' => "o",
        'ú' | 'ù' | 'û' | 'ü' => "u",
        'ñ' => "n",
        _ => return None,
    })
}

/// Generic Latin folding for en / fr / it / pt and the fallback: the Spanish
/// table plus the letters those languages add (`ã õ ç œ æ ý`). Folding is
/// applied identically to both sides of every comparison, so it only matters
/// where two real words differ solely by a diacritic (fr `parle`/`parlé`, pt
/// `caça`/`caca`). That is the same trade Spanish already makes with
/// `año`/`ano`: transcripts carry the marks, and matching typed-without-
/// accents learner input is worth more than the rare collision.
fn fold_latin(c: char) -> Option<&'static str> {
    Some(match c {
        'á' | 'à' | 'â' | 'ä' | 'ã' => "a",
        'é' | 'è' | 'ê' | 'ë' => "e",
        'í' | 'ì' | 'î' | 'ï' => "i",
        'ó' | 'ò' | 'ô' | 'ö' | 'õ' => "o",
        'ú' | 'ù' | 'û' | 'ü' => "u",
        'ñ' => "n",
        'ç' => "c",
        'œ' => "oe",
        'æ' => "ae",
        'ý' | 'ÿ' => "y",
        _ => return None,
    })
}

/// German: umlauts change meaning (`schon`/`schön`, `Mutter`/`Mütter`,
/// `Apfel`/`Äpfel`), so `ä`→`a` would make the tutor accept real errors.
/// `ae oe ue` is the official fallback spelling and what learners type
/// without a German keyboard, so folding to the digraph keeps `schön` ≠
/// `schon` while `schoen` still matches `schön`. `ß` is kept as a letter here;
/// `ß`/`ss` is forgiven in `speech_equivalent` instead. Foreign accents
/// (`Café`) fold like the generic table.
fn fold_german(c: char) -> Option<&'static str> {
    Some(match c {
        'ä' => "ae",
        'ö' => "oe",
        'ü' => "ue",
        'á' | 'à' | 'â' | 'ã' => "a",
        'é' | 'è' | 'ê' | 'ë' => "e",
        'í' | 'ì' | 'î' | 'ï' => "i",
        'ó' | 'ò' | 'ô' | 'õ' => "o",
        'ú' | 'ù' | 'û' => "u",
        'ñ' => "n",
        'ç' => "c",
        'œ' => "oe",
        'æ' => "ae",
        _ => return None,
    })
}

/// Norwegian: `æ ø å` are letters of the alphabet with minimal pairs
/// (`far`/`får`, `bare`/`bære`) and are never folded. Loan accents (`kafé`,
/// `idé`, `én`) fold like the generic table.
fn fold_norwegian(c: char) -> Option<&'static str> {
    match c {
        'æ' => None,
        other => fold_latin(other),
    }
}

/// Roman Hindi: learner-facing content is plain ASCII by design, but a model
/// or keyboard can still produce IAST (`ā ī ū ṭ ḍ ṇ ṃ ś ṣ ṛ`). Those marks
/// carry information a Roman-Hindi learner never sees, so they fold to the
/// everyday spelling (`ā`→`a`, `ṭ`→`t`, `ś`/`ṣ`→`sh`, `ṛ`→`ri`). Ordinary Latin
/// accents fold like the generic table.
fn fold_roman_hindi(c: char) -> Option<&'static str> {
    Some(match c {
        'ā' => "a",
        'ī' => "i",
        'ū' => "u",
        'ṭ' => "t",
        'ḍ' => "d",
        'ṇ' | 'ṅ' | 'ṃ' | 'ṁ' | 'ñ' => "n",
        'ś' | 'ṣ' => "sh",
        'ṛ' => "ri",
        'ḷ' => "l",
        'ḥ' => "h",
        other => return fold_latin(other),
    })
}

/// Mandarin: nothing is folded and every codepoint is kept. Tones are not in
/// the transcript, so there is nothing to forgive; pinyin tone marks, if
/// typed, are kept as written.
fn fold_none(_: char) -> Option<&'static str> {
    None
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/// Native (English) control words shared by every non-Spanish target. The
/// Spanish policy carries its own copy of exactly the words it had before.
const SHARED_NOISE: [&str; 4] = ["silence", "inaudible", "music", "unintelligible"];

pub static SPANISH_TEXT: TextPolicy = TextPolicy {
    id: "es",
    native_id: "en",
    whitespace_segmented: true,
    keep_combining_marks: false,
    native_letters: &[],
    fold: fold_spanish,
    // Verbatim `spanish::text::speech_equivalent`: ll/y, v/b, z/s (seseo).
    equivalences: &[anywhere("ll", "y"), anywhere("v", "b"), anywhere("z", "s")],
    native_homographs: &[],
    native_question_prefixes: &["what is the spanish"],
    explanation_rejects: &["usa ", "debes "],
    meta_words: &[
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
    ],
    minimal_words: &["si", "no", "no se", "ok", "okay", "vale", "bien", "tal vez"],
    noise_words: &["silence", "inaudible", "music", "musica", "unintelligible"],
};

pub static ENGLISH_TEXT: TextPolicy = TextPolicy {
    id: "en",
    native_id: "en",
    whitespace_segmented: true,
    keep_combining_marks: false,
    native_letters: &[],
    fold: fold_latin,
    // British/American spelling pairs the module already tells the tutor to
    // accept; ASR picks one arbitrarily. Length gates keep `our`, `hour`,
    // `rise` out. `-re`/`-er` is NOT folded: `tire`/`tier` would collide.
    equivalences: &[
        word_end("isation", "ization", 8),
        word_end("ise", "ize", 5),
        word_end("yse", "yze", 6),
        word_end("our", "or", 5),
    ],
    // Target == native: evidence is meaningless and the methods short-circuit.
    native_homographs: &[],
    native_question_prefixes: &[],
    explanation_rejects: &[],
    meta_words: &[
        "repeat",
        "repeat please",
        "slower",
        "again",
        "say again",
        "say that again",
        "i don t understand",
        "what",
        "sorry",
        "pardon",
    ],
    minimal_words: &[
        "yes", "no", "ok", "okay", "yeah", "yep", "nope", "maybe", "fine", "good", "i don t know",
        "don t know", "not sure",
    ],
    noise_words: &SHARED_NOISE,
};

pub static FRENCH_TEXT: TextPolicy = TextPolicy {
    id: "fr",
    native_id: "en",
    whitespace_segmented: true,
    keep_combining_marks: false,
    native_letters: &[],
    fold: fold_latin,
    // Silent-letter homophones ASR resolves by guesswork: `-er`/`-ez`/`-é`/
    // `-ée(s)` are all [e], so `j'ai parler` vs `j'ai parlé` is inaudible.
    // `-é` is already `e` after folding. `-es`→`e` is deliberately absent
    // (`les`≠`le`) and the 5-char gate keeps `chez`/`cher`/`nez`/`mer` apart.
    // Elision (`j'ai` → `j ai`) and liaison `-t-` are handled by `normalize`.
    equivalences: &[
        word_end("ees", "e", 5),
        word_end("ee", "e", 4),
        word_end("ez", "e", 5),
        word_end("er", "e", 5),
    ],
    native_homographs: &["on", "as", "or", "if", "but", "mine"],
    native_question_prefixes: &["what is the french", "what is the word"],
    explanation_rejects: &["utilise ", "utilisez ", "tu dois ", "il faut "],
    meta_words: &[
        "repeat",
        "repeat please",
        "slower",
        "again",
        "repete",
        "repetez",
        "encore",
        "encore une fois",
        "plus lentement",
        "moins vite",
        "je ne comprends pas",
        "je comprends pas",
        "quoi",
        "comment",
        "pardon",
    ],
    minimal_words: &[
        "oui", "non", "ouais", "si", "ok", "okay", "d accord", "bien", "peut etre", "je ne sais pas",
        "je sais pas", "sais pas",
    ],
    noise_words: &["silence", "inaudible", "music", "musique", "unintelligible"],
};

pub static GERMAN_TEXT: TextPolicy = TextPolicy {
    id: "de",
    native_id: "en",
    whitespace_segmented: true,
    keep_combining_marks: false,
    native_letters: &['ß'],
    fold: fold_german,
    // `ß`/`ss` is inaudible and Swiss spelling is valid per the module.
    equivalences: &[anywhere("ß", "ss")],
    native_homographs: &["am", "in", "so", "also", "was", "will", "her", "still", "all"],
    native_question_prefixes: &["what is the german", "what is the word"],
    explanation_rejects: &["benutze ", "benutz ", "verwende ", "du musst ", "man sagt "],
    meta_words: &[
        "repeat",
        "repeat please",
        "slower",
        "again",
        "wiederhole",
        "wiederholen",
        "noch mal",
        "nochmal",
        "noch einmal",
        "langsamer",
        "bitte langsamer",
        "ich verstehe nicht",
        "verstehe nicht",
        "wie bitte",
        "was",
        "wie",
    ],
    minimal_words: &[
        "ja", "nein", "ok", "okay", "gut", "vielleicht", "weiß nicht", "ich weiß nicht",
        "keine ahnung", "genau", "klar", "doch",
    ],
    noise_words: &["silence", "inaudible", "music", "musik", "unintelligible"],
};

pub static ITALIAN_TEXT: TextPolicy = TextPolicy {
    id: "it",
    native_id: "en",
    whitespace_segmented: true,
    keep_combining_marks: false,
    native_letters: &[],
    fold: fold_latin,
    // Initial `h` is silent: `ho`/`o`, `hai`/`ai`, `hanno`/`anno` are ASR
    // context guesses. Double consonants (`pala`/`palla`) are audible and
    // meaningful, so they are NOT folded.
    equivalences: &[word_start("h", "")],
    native_homographs: &["i", "so", "in", "do"],
    native_question_prefixes: &["what is the italian", "what is the word"],
    explanation_rejects: &["usa ", "devi ", "bisogna "],
    meta_words: &[
        "repeat",
        "repeat please",
        "slower",
        "again",
        "ripeti",
        "ripeta",
        "ancora",
        "un altra volta",
        "di nuovo",
        "piu piano",
        "piu lentamente",
        "non capisco",
        "non ho capito",
        "come",
        "cosa",
        "che",
    ],
    minimal_words: &[
        "si", "no", "ok", "okay", "va bene", "bene", "forse", "non so", "non lo so", "boh",
    ],
    noise_words: &["silence", "inaudible", "music", "musica", "unintelligible"],
};

pub static PORTUGUESE_TEXT: TextPolicy = TextPolicy {
    id: "pt",
    native_id: "en",
    whitespace_segmented: true,
    keep_combining_marks: false,
    native_letters: &[],
    fold: fold_latin,
    // Word-final `z` and `s` are both [s] in Brazilian Portuguese (`faz`,
    // `vez`, `paz`): the analogue of Spanish `z`→`s`, kept word-final so
    // `zero`/`sero` and the like are untouched.
    equivalences: &[word_end("z", "s", 3)],
    native_homographs: &["as", "do", "so", "for"],
    native_question_prefixes: &["what is the portuguese", "what is the word"],
    explanation_rejects: &["usa ", "voce deve ", "deve "],
    meta_words: &[
        "repeat",
        "repeat please",
        "slower",
        "again",
        "repete",
        "repita",
        "de novo",
        "outra vez",
        "mais devagar",
        "mais lento",
        "nao entendi",
        "nao entendo",
        "nao compreendo",
        "o que",
        "que",
        "como",
    ],
    minimal_words: &[
        "sim", "nao", "ok", "okay", "ta", "ta bom", "bem", "talvez", "nao sei", "sei la", "claro",
        "beleza",
    ],
    noise_words: &["silence", "inaudible", "music", "musica", "unintelligible"],
};

pub static NORWEGIAN_TEXT: TextPolicy = TextPolicy {
    id: "nb",
    native_id: "en",
    whitespace_segmented: true,
    keep_combining_marks: false,
    native_letters: &['æ', 'ø', 'å'],
    fold: fold_norwegian,
    // Bokmål's optional forms (boka/boken) are grammar variants the module
    // already accepts, not ASR noise; nothing is folded.
    equivalences: &[],
    native_homographs: &[
        "i", "at", "is", "her", "for", "under", "over", "to", "mine", "all", "like", "be",
    ],
    native_question_prefixes: &["what is the norwegian", "what is the word"],
    explanation_rejects: &["bruk ", "du må ", "man sier "],
    meta_words: &[
        "repeat",
        "repeat please",
        "slower",
        "again",
        "en gang til",
        "gjenta",
        "igjen",
        "saktere",
        "langsommere",
        "jeg forstår ikke",
        "forstår ikke",
        "hva",
    ],
    minimal_words: &[
        "ja", "nei", "jo", "ok", "okay", "vet ikke", "jeg vet ikke", "kanskje", "bra", "greit",
        "fint",
    ],
    noise_words: &["silence", "inaudible", "music", "musikk", "unintelligible", "stillhet"],
};

pub static MANDARIN_TEXT: TextPolicy = TextPolicy {
    id: "zh",
    native_id: "en",
    whitespace_segmented: false,
    keep_combining_marks: true,
    native_letters: &[],
    fold: fold_none,
    // Tones are not in the transcript; do not invent folding.
    equivalences: &[],
    native_homographs: &[],
    native_question_prefixes: &["what is the mandarin", "what is the chinese", "what is the word"],
    explanation_rejects: &["用", "你应该", "应该", "要用"],
    meta_words: &[
        "repeat",
        "repeat please",
        "slower",
        "again",
        "再说一遍",
        "再说一次",
        "请再说一遍",
        "请再说一次",
        "再来一次",
        "慢一点",
        "慢一点儿",
        "请说慢一点",
        "我不明白",
        "我不懂",
        "我听不懂",
        "听不懂",
        "不明白",
        "什么",
        "什么意思",
    ],
    minimal_words: &[
        "是", "是的", "对", "对的", "不是", "不", "不对", "好", "好的", "嗯", "可以", "行", "也许",
        "不知道", "我不知道", "不清楚", "ok", "okay",
    ],
    noise_words: &["silence", "inaudible", "music", "unintelligible", "音乐", "沉默"],
};

/// Hindi in ROMAN SCRIPT. Learners speak Hindi and never read Devanagari, so
/// every string here is plain ASCII (see `languages::HINDI` and
/// docs/SCENE-AUTHORING.md).
///
/// Romanisation decisions, fixed once and used across all Hindi content
/// (scenes, free talk, guidance, grammar wording) so the tutor is internally
/// consistent even though learners and ASR will not be:
///   hai / hain (not he, hein)     nahi (not nahin, nahee)    kya (not kyaa)
///   chahiye (not chaahiye)        mein = in, main = I         toh = then/so
///   aap, aapko, aapka; tum, tumhe, tumhara (tu is never modelled)
///   yeh / woh, yahan / wahan / kahan (w, not v)   kyun, kaun sa, kaise
///   achha (not acha, accha)       theek (not thik)           bahut (not bohot)
///   zyada, zaroori (z, not j)     phir, pehle (ph)           kuch, chhoti (chh)
///   long a as aa in the stressed stem: khaana, jaana, paani, naam, saath, baat
///   -ein for the subjunctive (karein, milein), -enge/-oge for the future.
///
/// Roman Hindi collides head-on with English function words: `main` (I),
/// `to`/`toh` (then), `is` (this, oblique), `do` (two), `the` (were), `in`
/// (these), `so` (sleep), `or` (and), `are` (hey), `me` (in), `hum` (we),
/// `bad` (after), `sun` (listen). `main`, `me`, `hum`, `bad` and `sun` are not
/// in the shared English evidence list, so they need nothing; of the rest,
/// `the is do to so or` are subtracted as homographs so
/// a correct Hindi sentence such as "main to bas yahi keh raha tha" is never
/// read as the learner giving up, and a judge suggestion such as "hum bazaar
/// gaye the" is never rejected as English (`the` is otherwise a STRONG token).
/// `in` and `are` stay as evidence: they are rare in learner Hindi, and every
/// homograph removed also weakens detection of a genuine English fallback.
/// Everyday English loanwords (bus, time, phone, class) are ordinary Hindi and
/// are neither evidence of mixing nor errors.
pub static HINDI_TEXT: TextPolicy = TextPolicy {
    id: "hi",
    native_id: "en",
    whitespace_segmented: true,
    keep_combining_marks: false,
    native_letters: &[],
    fold: fold_roman_hindi,
    // Spelling variance is the norm in Roman Hindi, so `speech_equivalent`
    // forgives the common variants of the most frequent words as WHOLE WORDS
    // (raw spellings, before the letter rules below run), then `-ay` for `-e`
    // (mujhay, kaisay, aisay), then letter pairs Hindi does not contrast:
    // w/v, z/j, ph/f, q/k and chh/cch/ch. Vowel length is deliberately NOT
    // folded (`kaam` work / `kam` less, `din` day / `deen` faith) and nasals
    // are folded only in listed words (`kaha` said / `kahan` where).
    equivalences: &[
        word("hain", "hai"),
        word("he", "hai"),
        word("hein", "hai"),
        word("hay", "hai"),
        word("nahin", "nahi"),
        word("nahee", "nahi"),
        word("nhi", "nahi"),
        word("nai", "nahi"),
        word("kyaa", "kya"),
        word("mujhay", "mujhe"),
        word("mujhey", "mujhe"),
        word("ap", "aap"),
        word("apko", "aapko"),
        word("apka", "aapka"),
        word("apki", "aapki"),
        word("apke", "aapke"),
        word("kaisay", "kaise"),
        word("kese", "kaise"),
        word("kesa", "kaisa"),
        word("kesi", "kaisi"),
        word("toh", "to"),
        word("me", "mein"),
        word("mei", "mein"),
        word("mai", "main"),
        word("hun", "hoon"),
        word("hu", "hoon"),
        word("kyu", "kyun"),
        word("kyon", "kyun"),
        word("kyoon", "kyun"),
        word("wo", "woh"),
        word("vo", "woh"),
        word("ye", "yeh"),
        word("yaha", "yahan"),
        word("yahaan", "yahan"),
        word("waha", "wahan"),
        word("wahaan", "wahan"),
        word("vaha", "wahan"),
        word("vahaan", "wahan"),
        word("vahan", "wahan"),
        word("thik", "theek"),
        word("teek", "theek"),
        word("bohot", "bahut"),
        word("bahot", "bahut"),
        word("bohut", "bahut"),
        word("chaiye", "chahiye"),
        word("chahie", "chahiye"),
        word("chaahiye", "chahiye"),
        word("or", "aur"),
        word("koyi", "koi"),
        word("haa", "haan"),
        word("han", "haan"),
        word("ha", "haan"),
        word_end("ay", "e", 4),
        anywhere("w", "v"),
        anywhere("z", "j"),
        anywhere("ph", "f"),
        anywhere("q", "k"),
        anywhere("cch", "ch"),
        anywhere("chh", "ch"),
    ],
    native_homographs: &["the", "is", "do", "to", "so", "or"],
    native_question_prefixes: &["what is the hindi", "what is the word"],
    explanation_rejects: &["aap ", "tum ", "yahan ", "yeh ", "isko ", "iska ", "hindi mein "],
    meta_words: &[
        "repeat",
        "repeat please",
        "slower",
        "again",
        "phir se",
        "phir se bolo",
        "phir se boliye",
        "dobara",
        "dobara bolo",
        "dobara boliye",
        "ek baar aur",
        "dheere",
        "dheere bolo",
        "dheere boliye",
        "thoda dheere",
        "samajh nahi aaya",
        "mujhe samajh nahi aaya",
        "samjha nahi",
        "main samjha nahi",
        "kya",
        "kya bola",
        "kya kaha",
    ],
    minimal_words: &[
        "haan", "ha", "han", "ji", "ji haan", "ji nahi", "nahi", "nahin", "ok", "okay", "theek hai",
        "thik hai", "theek", "achha", "accha", "acha", "pata nahi", "mujhe nahi pata", "shayad",
        "bilkul", "sahi hai",
    ],
    noise_words: &["silence", "inaudible", "music", "unintelligible", "sangeet", "khamoshi"],
};

/// Safe fallback for an unknown or missing language id: generic Latin folding,
/// no speech-equivalence (forgive nothing rather than the wrong thing), native
/// mixing detection on (an unknown target cannot be English, which is
/// registered), and only the native control words.
pub static DEFAULT_TEXT_POLICY: TextPolicy = TextPolicy {
    id: "default",
    native_id: "en",
    whitespace_segmented: true,
    keep_combining_marks: false,
    native_letters: &[],
    fold: fold_latin,
    equivalences: &[],
    native_homographs: &[],
    native_question_prefixes: &["what is the word"],
    explanation_rejects: &[],
    meta_words: &["repeat", "repeat please", "slower", "again"],
    minimal_words: &["ok", "okay", "yes", "no"],
    noise_words: &SHARED_NOISE,
};

/// Registry order matches `languages::LANGUAGES`.
pub static TEXT_POLICIES: [&TextPolicy; 9] = [
    &NORWEGIAN_TEXT,
    &SPANISH_TEXT,
    &ENGLISH_TEXT,
    &FRENCH_TEXT,
    &GERMAN_TEXT,
    &ITALIAN_TEXT,
    &PORTUGUESE_TEXT,
    &MANDARIN_TEXT,
    &HINDI_TEXT,
];

/// The text policy for a language id, or [`DEFAULT_TEXT_POLICY`] for an
/// unknown, empty or malformed id. Exact match, like `languages::module`.
pub fn text_policy(language_id: &str) -> &'static TextPolicy {
    TEXT_POLICIES
        .iter()
        .copied()
        .find(|p| p.id == language_id)
        .unwrap_or(&DEFAULT_TEXT_POLICY)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn es() -> &'static TextPolicy {
        text_policy("es")
    }

    // -- Spanish parity: the legacy functions, verbatim, as the oracle --------

    fn legacy_normalize(input: &str) -> String {
        let mut out = String::new();
        for c in input.to_lowercase().chars() {
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
    fn legacy_key(s: &str) -> String {
        legacy_normalize(s).replace("ll", "y").replace('v', "b").replace('z', "s")
    }

    const CORPUS: &[&str] = &[
        "",
        "   ",
        "  ¡Áyer, FUI! al café… ",
        "cafe\u{301}",
        "A\u{301}yer nin\u{303}o pingu\u{308}ino",
        "Bamos a la caza",
        "Vamos a la casa",
        "Ayer voy al parque",
        "Yo quiero agua hoy",
        "Quiero aguacate",
        "ÑANDÚ y llave, calle, valle, vez, veces, luz",
        "garçon façade ação São coração œuvre Ærø straße Straẞe",
        "c\u{327}a o\u{303} a\u{30a} e\u{301}\u{301}",
        "\u{301}\u{308}",
        "你好，我想要一杯咖啡。",
        "こんにちは",
        "emoji 🙂🎉 and 1234 numbers",
        "tabs\tand\nnewlines\r\n  everywhere",
        "j'ai parlé — c'est ça? d'accord!",
        "Schön, schon, Äpfel, Apfel, Müller, weiß",
        "[background music]",
        "(inaudible)",
        "ĀĒĪŌŪ āēīōū ǎǐǒǔ",
        "İstanbul ı Ø ø Å å Æ æ",
    ];

    #[test]
    fn spanish_parity_normalize_matches_legacy_on_corpus() {
        for s in CORPUS {
            assert_eq!(es().normalize(s), legacy_normalize(s), "normalize({s:?})");
            assert_eq!(
                es().words(s),
                legacy_normalize(s).split_whitespace().map(str::to_owned).collect::<Vec<_>>(),
                "words({s:?})"
            );
            assert_eq!(es().speech_key(s), legacy_key(s), "speech_key({s:?})");
        }
    }

    #[test]
    fn spanish_parity_normalization() {
        assert_eq!(es().normalize("  ¡Áyer, FUI! al café… "), "ayer fui al cafe");
        assert_eq!(es().normalize("cafe\u{301}"), "cafe");
    }

    #[test]
    fn spanish_parity_intents() {
        for s in ["how do you say parque", "what does bonito mean", "I want to order food"] {
            assert_eq!(es().classify(s), Intent::NativeMixed, "{s}");
        }
        for s in ["repeat", "¿Qué?", "No entiendo", "más despacio"] {
            assert_eq!(es().classify(s), Intent::MetaRequest, "{s}");
        }
        for s in ["sí", "no sé", "ok", "muy bien"] {
            assert_eq!(es().classify(s), Intent::Minimal, "{s}");
        }
        for s in ["", "[background music]", "...", "1234", "xyz"] {
            assert_eq!(es().classify(s), Intent::EmptyOrNoise, "{s}");
        }
        assert_eq!(es().classify("Ayer fui al parque"), Intent::TargetAttempt);
    }

    #[test]
    fn spanish_parity_shared_words_are_not_english() {
        assert!(!es().is_native_mixed("A mi me gusta el parque"));
        assert!(!es().contains_native("He ido al parque"));
        assert!(es().contains_native("Quiero the agua"));
    }

    #[test]
    fn spanish_parity_phrase_boundaries() {
        assert!(es().contains_phrase("Yo quiero agua hoy", "quiero agua"));
        assert!(!es().contains_phrase("Quiero aguacate", "quiero agua"));
    }

    #[test]
    fn spanish_parity_orthographic_noise() {
        assert!(es().speech_equivalent("Bamos a la caza", "Vamos a la casa"));
        assert!(!es().speech_equivalent("Ayer voy al parque", "Ayer fui al parque"));
    }

    #[test]
    fn spanish_parity_ratios_and_explanations() {
        // "I want to order food": i, want, to → 3/5, same tokens the legacy list counts.
        assert_eq!(es().native_ratio("I want to order food"), 0.6);
        // clean_reply rejects majority-English replies at 0.5.
        assert!(es().native_ratio("What do you want?") >= 0.5);
        assert!(es().native_ratio("¿Quieres agua?") < 0.5);
        assert_eq!(es().native_ratio(""), 0.0);
        assert!(es().native_question("what is the Spanish for dog"));
        assert!(es().native_explanation("Use the preterite for a completed action."));
        assert!(!es().native_explanation("Usa el pretérito aquí."));
        assert!(!es().native_explanation("Debes usar ser."));
        assert!(!es().native_explanation("Good. Now try again. And again."));
        assert!(!es().native_explanation(""));
    }

    // -- Mandarin --------------------------------------------------------------

    #[test]
    fn mandarin_segments_per_character_so_phrases_are_found() {
        let zh = text_policy("zh");
        assert_eq!(zh.normalize("你好，我想要一杯咖啡。"), "你好 我想要一杯咖啡");
        assert_eq!(zh.words("你好，我想要一杯咖啡。").len(), 9);
        assert!(zh.contains_phrase("你好，我想要一杯咖啡。", "我想要"));
        assert!(zh.contains_phrase("我想要一杯咖啡", "咖啡"));
        assert!(!zh.contains_phrase("我想要一杯咖啡", "我要"));
        // Latin runs and digits stay whole between characters.
        assert_eq!(zh.words("我要2杯coffee"), ["我", "要", "2", "杯", "coffee"]);
        // A whitespace-segmented policy would see one token here.
        assert_eq!(es().words("我想要一杯咖啡").len(), 1);
    }

    #[test]
    fn mandarin_folds_nothing_and_classifies_by_character_count() {
        let zh = text_policy("zh");
        assert!(zh.equivalences.is_empty());
        assert!(!zh.speech_equivalent("买", "卖"));
        assert_eq!(zh.normalize("nǐ hǎo Ni\u{30C}"), "nǐ hǎo ni\u{30C}");
        assert_eq!(zh.classify("我想要一杯咖啡"), Intent::TargetAttempt);
        assert_eq!(zh.classify("谢谢"), Intent::Minimal);
        assert_eq!(zh.classify("对"), Intent::Minimal);
        assert_eq!(zh.classify("再说一遍"), Intent::MetaRequest);
        assert_eq!(zh.classify("[音乐]"), Intent::EmptyOrNoise);
        assert_eq!(zh.classify("how do you say 咖啡"), Intent::NativeMixed);
    }

    // -- English target --------------------------------------------------------

    #[test]
    fn english_target_does_not_flag_english_as_mixed() {
        let en = text_policy("en");
        assert!(en.targets_native());
        for s in ["I want to order food", "how do you say hello", "What do you want?"] {
            assert!(!en.is_native_mixed(s), "{s}");
            assert!(!en.contains_native(s), "{s}");
            assert_eq!(en.native_ratio(s), 0.0, "{s}");
        }
        assert_eq!(en.classify("I want to order food"), Intent::TargetAttempt);
        assert_eq!(en.classify("yes"), Intent::Minimal);
        assert_eq!(en.classify("say that again"), Intent::MetaRequest);
        // Explanations are still checked to be English: a positive check.
        assert!(en.native_explanation("Use the past tense for a finished action."));
        assert!(!en.native_explanation("用过去时。"));
        assert!(en.speech_equivalent("colour", "color"));
        assert!(en.speech_equivalent("organise", "organize"));
        assert!(!en.speech_equivalent("our", "or"));
        assert!(!en.speech_equivalent("tire", "tier"));
    }

    // -- Other languages -------------------------------------------------------

    #[test]
    fn german_keeps_umlaut_meaning_and_forgives_eszett() {
        let de = text_policy("de");
        assert_eq!(de.normalize("Äpfel"), "aepfel");
        assert_eq!(de.normalize("A\u{308}pfel"), "aepfel");
        assert_eq!(de.normalize("Straße STRAẞE"), "straße straße");
        assert!(!de.speech_equivalent("schon", "schön"));
        assert!(de.speech_equivalent("schoen", "schön"));
        assert!(de.speech_equivalent("Straße", "Strasse"));
        assert!(!de.is_native_mixed("Ich will so in die Stadt, was war das?"));
        assert_eq!(de.classify("Ich weiß nicht"), Intent::Minimal);
        assert_eq!(de.classify("noch mal"), Intent::MetaRequest);
    }

    #[test]
    fn french_forgives_silent_endings_but_not_function_words() {
        let fr = text_policy("fr");
        assert!(fr.speech_equivalent("j'ai parlé", "j'ai parler"));
        assert!(fr.speech_equivalent("vous allez", "vous aller"));
        assert!(fr.speech_equivalent("elle est allée", "elle est allé"));
        assert!(!fr.speech_equivalent("chez", "cher"));
        assert!(!fr.speech_equivalent("les", "le"));
        assert!(!fr.speech_equivalent("nez", "ne"));
        assert_eq!(fr.normalize("Ça va, garçon ? Où est l'œuvre ?"), "ca va garcon ou est l oeuvre");
        assert!(!fr.is_native_mixed("on est sur son vélo, mais or if but"));
        assert_eq!(fr.classify("je ne comprends pas"), Intent::MetaRequest);
    }

    #[test]
    fn italian_portuguese_norwegian_choices() {
        let it = text_policy("it");
        assert!(it.speech_equivalent("ho fame", "o fame"));
        assert!(!it.speech_equivalent("pala", "palla"));
        assert!(!it.is_native_mixed("i ragazzi so che in casa do"));

        let pt = text_policy("pt");
        assert!(pt.speech_equivalent("uma vez", "uma ves"));
        assert!(!pt.speech_equivalent("zero", "sero"));
        assert_eq!(pt.normalize("Não, coração"), "nao coracao");
        assert!(!pt.is_native_mixed("as meninas do bairro só for"));
        assert_eq!(pt.classify("não sei"), Intent::Minimal);

        let nb = text_policy("nb");
        assert_eq!(nb.normalize("Får, bære, kafé, ØL"), "får bære kafe øl");
        assert_eq!(nb.normalize("a\u{30a}"), "å");
        assert!(!nb.speech_equivalent("far", "får"));
        assert!(!nb.is_native_mixed("Jeg er her i byen for å be"));
        assert_eq!(nb.classify("jeg forstår ikke"), Intent::MetaRequest);
    }

    // -- Hindi (Roman script) --------------------------------------------------

    /// The case from the product brief: every token is Hindi, and `main`,
    /// `to`, `the`, `is`, `do` look like English. Without homographs the mixing
    /// detector would read correct Hindi as the learner giving up.
    #[test]
    fn hindi_roman_homographs_are_not_english_evidence() {
        let hi = text_policy("hi");
        let brief = "main to bas yahi keh raha tha";
        assert!(!hi.is_native_mixed(brief));
        assert!(!hi.contains_native(brief));
        assert_eq!(hi.native_ratio(brief), 0.0);
        assert_eq!(hi.classify(brief), Intent::TargetAttempt);
        assert_eq!(hi.classify("Main toh bas yahi keh raha tha."), Intent::TargetAttempt);
        assert!(!hi.is_native_mixed("woh log kal aaye the, is baar do din ke liye"));
        assert!(!hi.contains_native("woh log kal aaye the"));
        assert!(!hi.contains_native("hum bazaar gaye the"));
        assert!(!hi.is_native_mixed("Tum so jao, main in sab ko dekh lunga"));
        // Real English is still caught, including with the homographs removed.
        assert!(hi.is_native_mixed("I want to order food"));
        assert!(hi.is_native_mixed("What do you want?"));
        assert!(hi.native_question("what is the Hindi for water"));
        assert!(hi.native_question("how do you say thank you"));
        assert!(hi.contains_native("mujhe please paani chahiye"));
        // Loanwords are ordinary Hindi, not evidence of mixing.
        assert!(!hi.is_native_mixed("main bus se office jaata hoon, phone ghar pe hai"));
    }

    #[test]
    fn hindi_forgives_romanisation_variants_but_not_real_words() {
        let hi = text_policy("hi");
        let same = [
            ("Aap kaise hain?", "ap kaisay hai"),
            ("mujhe nahi chahiye", "mujhay nahin chaahiye"),
            ("kya woh yahan hai", "kyaa vo yaha he"),
            ("main toh bas yahi keh raha tha", "mai to bas yahi keh raha tha"),
            ("bahut achha", "bohot accha"),
            ("bahut achha", "bahut acha"),
            ("zyada zaroori", "jyada jaroori"),
            ("phir se boliye", "fir se boliye"),
            ("theek hai", "thik he"),
            ("ghar mein", "ghar me"),
            ("main hoon", "mai hun"),
            ("kyun nahi", "kyon nhi"),
            ("haan, wahan", "han, vahan"),
            ("aapko kya chahiye", "apko kya chaiye"),
        ];
        for (a, b) in same {
            assert!(hi.speech_equivalent(a, b), "{a:?} vs {b:?}");
        }
        let different = [
            ("kaam", "kam"),
            ("kaha", "kahan"),
            ("apne", "aapne"),
            ("din", "deen"),
            ("pakka", "paka"),
            ("baat", "bat"),
            ("hai", "ho"),
            ("mujhe", "tumhe"),
            ("aap kaise hain", "tum kaise ho"),
        ];
        for (a, b) in different {
            assert!(!hi.speech_equivalent(a, b), "{a:?} vs {b:?}");
        }
        // IAST from a model or keyboard folds to the everyday spelling.
        assert_eq!(hi.normalize("Āp kyā pīnā chāhenge?"), "ap kya pina chahenge");
        assert_eq!(hi.normalize("ṭhīk hai, śukriyā"), "thik hai shukriya");
        assert!(hi.speech_equivalent("Āp kyā chāhenge?", "aap kya chahenge"));
        assert!(hi.speech_equivalent("ṭhīk hai", "theek hai"));
        // IAST marks every long vowel while everyday spelling marks only some
        // (pīnā / peena), so the fold is best-effort, not a guarantee.
        assert!(!hi.speech_equivalent("pīnā", "peena"));
        // A whole-word rule never touches a longer word that merely contains it.
        assert!(!hi.speech_equivalent("apne", "aapne"));
        assert!(!hi.speech_equivalent("mehnat", "mainhnat"));
    }

    #[test]
    fn hindi_control_words_and_script_are_roman() {
        let hi = text_policy("hi");
        for s in ["haan", "Theek hai", "ji haan", "nahi", "pata nahi", "achha"] {
            assert_eq!(hi.classify(s), Intent::Minimal, "{s}");
        }
        for s in ["phir se", "Dheere boliye", "kya?", "samajh nahi aaya", "repeat"] {
            assert_eq!(hi.classify(s), Intent::MetaRequest, "{s}");
        }
        assert_eq!(hi.classify("[music]"), Intent::EmptyOrNoise);
        assert_eq!(hi.classify("sangeet"), Intent::EmptyOrNoise);
        assert_eq!(hi.classify("Aap kya peena chahenge?"), Intent::TargetAttempt);
        assert!(hi.contains_phrase("Mujhe ek chai chahiye", "chai chahiye"));
        assert!(!hi.contains_phrase("Mujhe chaiwala chahiye", "chai chahiye"));
        // Judge explanations must be English, not Roman Hindi. Note `the` and
        // `is` are Hindi homographs, so they no longer count as English here.
        assert!(hi.native_explanation("Use ne because the verb is transitive and in the past."));
        assert!(hi.native_explanation("The verb must agree with the subject."));
        assert!(!hi.native_explanation("Aap yahan ne lagaiye."));
        assert!(!hi.native_explanation("Yeh galat hai, tum ne bolo."));
        // Every string in the policy is plain ASCII: no Devanagari, no IAST.
        let all = hi
            .meta_words
            .iter()
            .chain(hi.minimal_words)
            .chain(hi.noise_words)
            .chain(hi.native_homographs)
            .chain(hi.native_question_prefixes)
            .chain(hi.explanation_rejects)
            .copied()
            .chain(hi.equivalences.iter().flat_map(|e| [e.from, e.to]));
        for w in all {
            assert!(w.is_ascii(), "{w:?} is not plain ASCII");
        }
        // Devanagari input never panics and never matches Roman content.
        assert!(!hi.speech_equivalent("नमस्ते", "namaste"));
        assert!(!hi.contains_phrase("नमस्ते", "namaste"));
    }

    // -- Registry and robustness -----------------------------------------------

    #[test]
    fn unknown_ids_fall_back_safely() {
        for id in ["", "xx", "ES", "es ", "es-ES", "日本語", "default"] {
            let p = text_policy(id);
            assert_eq!(p.id, DEFAULT_TEXT_POLICY.id, "{id:?}");
            assert!(p.equivalences.is_empty());
            assert_eq!(p.normalize("Café, ¡Hola!"), "cafe hola");
            assert!(p.is_native_mixed("I want to order food"));
            assert_eq!(p.classify("repeat"), Intent::MetaRequest);
        }
        for m in TEXT_POLICIES {
            assert_eq!(text_policy(m.id).id, m.id);
        }
        assert_eq!(
            TEXT_POLICIES.iter().map(|p| p.id).collect::<Vec<_>>(),
            ["nb", "es", "en", "fr", "de", "it", "pt", "zh", "hi"]
        );
    }

    #[test]
    fn control_words_are_stored_in_normalized_form() {
        for p in TEXT_POLICIES.iter().copied().chain([&DEFAULT_TEXT_POLICY]) {
            for w in p.meta_words.iter().chain(p.minimal_words).chain(p.noise_words) {
                assert_eq!(p.normalize(w), *w, "{}: {w:?}", p.id);
                assert_ne!(p.classify(w), Intent::TargetAttempt, "{}: {w:?}", p.id);
            }
            for w in p.native_homographs {
                assert!(
                    NATIVE_ENGLISH.split_whitespace().any(|e| e == *w),
                    "{}: homograph {w:?} is not in the evidence list",
                    p.id
                );
            }
        }
    }

    #[test]
    fn nothing_panics_on_hostile_input() {
        let long = "ñ你a\u{301}🙂 ".repeat(4_000);
        let inputs = [
            "",
            " \t\n",
            "🙂🎉🇳🇴",
            "\u{301}\u{308}\u{30C}",
            "[",
            "(",
            "[]",
            "()",
            "….!?",
            "ﬁ ß İ ǅ",
            long.as_str(),
        ];
        for p in TEXT_POLICIES.iter().copied().chain([&DEFAULT_TEXT_POLICY]) {
            for s in inputs {
                let _ = p.normalize(s);
                let _ = p.words(s);
                let _ = p.speech_key(s);
                let _ = p.speech_equivalent(s, "x");
                let _ = p.contains_phrase(s, s);
                let _ = p.contains_phrase(s, "");
                let _ = p.native_ratio(s);
                let _ = p.native_question(s);
                let _ = p.is_native_mixed(s);
                let _ = p.contains_native(s);
                let _ = p.native_explanation(s);
                let _ = p.classify(s);
            }
            assert_eq!(p.classify(""), Intent::EmptyOrNoise);
            assert_eq!(p.classify("🙂🎉"), Intent::EmptyOrNoise);
            assert!(!p.contains_phrase("anything", ""));
        }
    }
}
