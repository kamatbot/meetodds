//! Per-language grammar taxonomy for the unified tutoring engine.
//!
//! The Spanish engine keys its judge output, level gating, rule sentences and
//! UI labels off a Spanish-only `Category` enum. This module generalises that
//! taxonomy to every language in the registry without changing a single byte
//! of what Spanish persists or shows.
//!
//! # Shape
//!
//! * [`Category`] is one flat enum for all languages. Its wire form is a
//!   snake_case string (`ser_estar`, `measure_word`, ...) that is persisted in
//!   profiles and sent to the frontend, so it is a single namespace: no two
//!   categories can ever share a string, and a Spanish category is the same
//!   value wherever it appears.
//! * A [`Taxonomy`] is a language's view of that enum: the subset its judge may
//!   return, the wording of each rule sentence and label, and which errors are
//!   worth showing at each level. The split is:
//!   - a **neutral core** every language shares ([`Category::CORE`]);
//!   - **shared inflection** categories used by the languages that inflect for
//!     tense, person, gender, number or definiteness;
//!   - **language-specific extensions** (`ser_estar`, `case`, `measure_word`,
//!     `aspect`, ...), each listed only by the languages it applies to.
//!
//! # Compatibility guarantees
//!
//! * The twelve Spanish variants keep their names, wire strings, discriminant
//!   order and wording. `Taxonomy::Spanish` returns exactly what
//!   `spanish::policy::{explanation, category_name, at_level}` return today;
//!   the tests below hold a verbatim copy of those functions as an oracle.
//! * An unknown language id degrades to [`Taxonomy::Neutral`]. A category a
//!   language does not use behaves as [`Category::Other`] for that language:
//!   the conservative, advanced-only gate. Nothing here panics on stored or
//!   model-derived input.
//!
//! Only `serde` and `std` are used, so `tools/languages-tests` compiles it
//! standalone. The `spanish` module is deliberately not imported; the level
//! types below are wire-compatible copies of the ones in `spanish/mod.rs`.

use serde::de::{self, Deserializer, Visitor};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};
use std::fmt;

// ---------------------------------------------------------------------------
// Level types (wire-compatible with `spanish::{Level, Structure}`)
// ---------------------------------------------------------------------------

/// Learner level. Serde form matches `spanish::Level` (`beginner`, ...).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    #[default]
    Beginner,
    Intermediate,
    Advanced,
}

impl Level {
    pub fn dial(self) -> u8 {
        match self {
            Self::Beginner => 0,
            Self::Intermediate => 1,
            Self::Advanced => 2,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Beginner => "beginner",
            Self::Intermediate => "intermediate",
            Self::Advanced => "advanced",
        }
    }
}

/// Optional judge metadata about the structure a finding concerns. Serde form
/// matches `spanish::Structure`. Missing metadata is `General`, which the level
/// tables treat conservatively rather than assuming present tense.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Structure {
    Present,
    Past,
    Future,
    Subjunctive,
    Conditional,
    Register,
    #[default]
    General,
}

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

/// A grammar error category. See the module docs for the core/extension split.
///
/// Declaration order matters: the twelve Spanish variants come first, in the
/// order `spanish::Category` declares them, because `Ord` is used as a
/// tie-break when the recap ranks focus areas. New variants are appended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Category {
    // --- Spanish set, verbatim order. Do not reorder or insert above `Other`.
    VerbTense,
    VerbConjugation,
    SerEstar,
    GenderAgreement,
    NumberAgreement,
    Article,
    Preposition,
    WordChoice,
    WordOrder,
    MissingWord,
    /// The learner fell back to their own language (English in this app) and
    /// the card supplies the target-language phrase. Help, not an error.
    EnglishMixed,
    Other,
    // --- Extensions. Append only; each is listed by the languages that use it.
    /// German: noun-phrase case marking (accusative, dative, genitive).
    Case,
    /// German, Norwegian: the conjugated verb sits second in a main clause.
    VerbSecond,
    /// German, Norwegian: word order inside a subordinate clause.
    SubordinateClause,
    /// German: a separable prefix that must split from its verb.
    SeparableVerb,
    /// Mandarin: classifier between a number or demonstrative and its noun.
    MeasureWord,
    /// Mandarin: completed/experienced/ongoing marking with 了, 过, 着.
    Aspect,
    /// Mandarin: structural and sentence-final particles such as 的, 吗, 呢, 吧.
    Particle,
    /// Mandarin: the 把 and 被 constructions.
    BaBei,
    /// French: `ne ... pas`; Mandarin: 不 versus 没.
    Negation,
    /// French, Italian, Portuguese: object and reflexive pronoun form/position.
    Pronoun,
    /// English: countable versus uncountable nouns and their quantifiers.
    Countability,
    /// English: do/be/have support in questions, negatives and progressives.
    AuxiliaryVerb,
}

impl Default for Category {
    fn default() -> Self {
        Self::Other
    }
}

/// The single source of truth for wire strings. Serde reads and writes through
/// this table, so the persisted form and `wire()`/`from_wire()` cannot drift.
const WIRE: [(Category, &str); 24] = [
    (Category::VerbTense, "verb_tense"),
    (Category::VerbConjugation, "verb_conjugation"),
    (Category::SerEstar, "ser_estar"),
    (Category::GenderAgreement, "gender_agreement"),
    (Category::NumberAgreement, "number_agreement"),
    (Category::Article, "article"),
    (Category::Preposition, "preposition"),
    (Category::WordChoice, "word_choice"),
    (Category::WordOrder, "word_order"),
    (Category::MissingWord, "missing_word"),
    (Category::EnglishMixed, "english_mixed"),
    (Category::Other, "other"),
    (Category::Case, "case"),
    (Category::VerbSecond, "verb_second"),
    (Category::SubordinateClause, "subordinate_clause"),
    (Category::SeparableVerb, "separable_verb"),
    (Category::MeasureWord, "measure_word"),
    (Category::Aspect, "aspect"),
    (Category::Particle, "particle"),
    (Category::BaBei, "ba_bei"),
    (Category::Negation, "negation"),
    (Category::Pronoun, "pronoun"),
    (Category::Countability, "countability"),
    (Category::AuxiliaryVerb, "auxiliary_verb"),
];

const WIRE_NAMES: [&str; 24] = {
    let mut names = [""; 24];
    let mut i = 0;
    while i < WIRE.len() {
        names[i] = WIRE[i].1;
        i += 1;
    }
    names
};

impl Category {
    /// Every category, in declaration order.
    pub const ALL: [Category; 24] = {
        let mut all = [Category::Other; 24];
        let mut i = 0;
        while i < WIRE.len() {
            all[i] = WIRE[i].0;
            i += 1;
        }
        all
    };

    /// The language-neutral core: categories every language's judge may return
    /// and every taxonomy explains. Order follows the Spanish set.
    pub const CORE: [Category; 6] = [
        Category::Preposition,
        Category::WordChoice,
        Category::WordOrder,
        Category::MissingWord,
        Category::EnglishMixed,
        Category::Other,
    ];

    /// The persisted / frontend-facing snake_case string.
    pub fn wire(self) -> &'static str {
        // `ALL` is built from `WIRE`, so every variant has an entry; the
        // fallback is unreachable but keeps this total without a panic path.
        WIRE.iter()
            .find(|(c, _)| *c == self)
            .map(|(_, w)| *w)
            .unwrap_or("other")
    }

    /// Parse a wire string. Unknown strings are `None`, never a panic; whether
    /// that is an error is the caller's decision (the judge validator keeps
    /// rejecting them, exactly as it does today).
    pub fn from_wire(wire: &str) -> Option<Category> {
        WIRE.iter().find(|(_, w)| *w == wire).map(|(c, _)| *c)
    }

    /// True for the neutral core shared by every language.
    pub fn is_core(self) -> bool {
        Self::CORE.contains(&self)
    }

    /// Language-agnostic rule sentence. Used by [`Taxonomy::Neutral`] and as
    /// the default a language falls back to when it has no wording of its own.
    pub fn neutral_explanation(self) -> &'static str {
        match self {
            Self::VerbTense => "The verb tense needs to match when the action happens.",
            Self::VerbConjugation => {
                "The verb ending needs to agree with the person doing the action."
            }
            Self::SerEstar => {
                "This language uses different verbs for identity and for states or location."
            }
            Self::GenderAgreement => {
                "The adjective and article need to match the noun's grammatical gender."
            }
            Self::NumberAgreement => {
                "The words describing a noun need to match its singular or plural form."
            }
            Self::Article => "The article needs to fit the noun and how it is used here.",
            Self::Preposition => "This relationship between words needs a different preposition.",
            Self::WordChoice => {
                "A different word expresses your intended meaning more clearly here."
            }
            Self::WordOrder => {
                "The order of these words needs to fit the structure of this sentence."
            }
            Self::MissingWord => "This sentence needs another word to express the complete idea.",
            Self::EnglishMixed => "This phrase expresses the idea you asked about in English.",
            Self::Other => {
                "This sentence structure needs an adjustment to express your intended meaning clearly."
            }
            Self::Case => "The noun phrase needs the case that its role in the sentence calls for.",
            Self::VerbSecond => {
                "The conjugated verb needs to come second in a main clause, even when something else comes first."
            }
            Self::SubordinateClause => {
                "The word order inside this subordinate clause needs to follow the subordinate-clause pattern."
            }
            Self::SeparableVerb => {
                "The prefix of a separable verb splits off and moves to the end of the clause."
            }
            Self::MeasureWord => {
                "A measure word is needed between the number or demonstrative and the noun."
            }
            Self::Aspect => {
                "Completed, experienced and ongoing actions are marked with particles rather than with tense."
            }
            Self::Particle => {
                "This sentence needs a different particle to work grammatically."
            }
            Self::BaBei => {
                "This construction moves the object in front of the verb and needs its own word order."
            }
            Self::Negation => {
                "The negative form here needs to follow the pattern for this kind of sentence."
            }
            Self::Pronoun => {
                "The pronoun needs the form and position that fit its role in the sentence."
            }
            Self::Countability => {
                "This noun is countable or uncountable, which changes the words used with it."
            }
            Self::AuxiliaryVerb => {
                "This question or negative form needs a helping verb."
            }
        }
    }

    /// Language-agnostic short UI label.
    pub fn neutral_name(self) -> &'static str {
        match self {
            Self::VerbTense => "When actions happen",
            Self::VerbConjugation => "Verb endings",
            Self::SerEstar => "Ser and estar",
            Self::GenderAgreement => "Grammatical gender",
            Self::NumberAgreement => "Singular and plural",
            Self::Article => "Articles",
            Self::Preposition => "Prepositions",
            Self::WordChoice => "Choosing words",
            Self::WordOrder => "Word order",
            Self::MissingWord => "Complete sentences",
            Self::EnglishMixed => "Useful phrases",
            Self::Other => "Sentence structure",
            Self::Case => "Grammatical case",
            Self::VerbSecond => "Verb position",
            Self::SubordinateClause => "Subordinate clauses",
            Self::SeparableVerb => "Separable verbs",
            Self::MeasureWord => "Measure words",
            Self::Aspect => "Completed and experienced actions",
            Self::Particle => "Particles",
            Self::BaBei => "把 and 被",
            Self::Negation => "Negation",
            Self::Pronoun => "Pronouns",
            Self::Countability => "Countable and uncountable nouns",
            Self::AuxiliaryVerb => "Helping verbs",
        }
    }
}

impl fmt::Display for Category {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.wire())
    }
}

impl Serialize for Category {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.wire())
    }
}

impl<'de> Deserialize<'de> for Category {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct WireVisitor;
        impl<'de> Visitor<'de> for WireVisitor {
            type Value = Category;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a grammar category name")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Category, E> {
                Category::from_wire(v).ok_or_else(|| E::unknown_variant(v, &WIRE_NAMES))
            }
        }
        deserializer.deserialize_str(WireVisitor)
    }
}

// ---------------------------------------------------------------------------
// Level gating tables
// ---------------------------------------------------------------------------

/// Which categories are worth showing at each level for one language. Read by
/// [`Taxonomy::at_level`] and [`Taxonomy::demonstrably_above_level`]; the
/// Spanish table reproduces `spanish::policy` exactly.
///
/// Everything not listed is implied: advanced learners see every category;
/// subjunctive, conditional and register structures are advanced-only for all
/// languages; `Other` is never shown below advanced; a category outside the
/// language's set is treated as `Other`.
struct LevelTable {
    /// Shown to beginners regardless of structure.
    beginner: &'static [Category],
    /// Shown to beginners only when the judge marked the structure present.
    beginner_present_only: &'static [Category],
    /// Shown to intermediates only when the judge supplied a structure other
    /// than `General`, so an unlabelled finding is not assumed to be at level.
    intermediate_needs_structure: &'static [Category],
    /// Held back until advanced even though the language uses them.
    advanced_only: &'static [Category],
    /// Correct use of these is praiseworthy for a beginner (above level).
    above_beginner: &'static [Category],
    /// Correct use of these is praiseworthy for an intermediate learner.
    above_intermediate: &'static [Category],
}

impl LevelTable {
    fn at_level(&self, c: Category, s: Structure, level: Level) -> bool {
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
            Level::Beginner => {
                self.beginner.contains(&c)
                    || (self.beginner_present_only.contains(&c) && s == Structure::Present)
            }
            Level::Intermediate => {
                c != Category::Other
                    && !self.advanced_only.contains(&c)
                    && !(self.intermediate_needs_structure.contains(&c)
                        && s == Structure::General)
            }
            Level::Advanced => true,
        }
    }

    fn demonstrably_above_level(&self, c: Category, s: Structure, level: Level) -> bool {
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
                ) || self.above_beginner.contains(&c)
            }
            Level::Intermediate => {
                matches!(
                    s,
                    Structure::Subjunctive | Structure::Conditional | Structure::Register
                ) || self.above_intermediate.contains(&c)
            }
            Level::Advanced => false,
        }
    }
}

// ---------------------------------------------------------------------------
// Per-language data
// ---------------------------------------------------------------------------

use Category as C;

/// Spanish. Set order is the judge prompt's enum order; the table is a
/// data transcription of `spanish::policy::at_level` / `demonstrably_above_level`.
const SPANISH_SET: &[Category] = &[
    C::VerbTense,
    C::VerbConjugation,
    C::SerEstar,
    C::GenderAgreement,
    C::NumberAgreement,
    C::Article,
    C::Preposition,
    C::WordChoice,
    C::WordOrder,
    C::MissingWord,
    C::EnglishMixed,
    C::Other,
];
const SPANISH_LEVELS: LevelTable = LevelTable {
    beginner: &[
        C::GenderAgreement,
        C::NumberAgreement,
        C::Article,
        C::MissingWord,
        C::WordOrder,
        C::EnglishMixed,
    ],
    beginner_present_only: &[C::VerbConjugation, C::SerEstar],
    intermediate_needs_structure: &[C::VerbConjugation, C::SerEstar, C::VerbTense],
    advanced_only: &[],
    above_beginner: &[C::Preposition, C::WordChoice],
    above_intermediate: &[],
};

/// Portuguese (Brazil). Same inflectional profile as Spanish, including ser
/// and estar (band 1 of its teaching focus), plus object pronouns at band 3.
const PORTUGUESE_SET: &[Category] = &[
    C::VerbTense,
    C::VerbConjugation,
    C::SerEstar,
    C::GenderAgreement,
    C::NumberAgreement,
    C::Article,
    C::Pronoun,
    C::Preposition,
    C::WordChoice,
    C::WordOrder,
    C::MissingWord,
    C::EnglishMixed,
    C::Other,
];
const PORTUGUESE_LEVELS: LevelTable = LevelTable {
    beginner: SPANISH_LEVELS.beginner,
    beginner_present_only: &[C::VerbConjugation, C::SerEstar],
    intermediate_needs_structure: &[C::VerbConjugation, C::SerEstar, C::VerbTense],
    advanced_only: &[],
    above_beginner: &[C::Preposition, C::WordChoice, C::Pronoun],
    above_intermediate: &[],
};

/// Italian. Common prepositions are band 1, so they are a beginner correction
/// here; object pronouns arrive at band 3.
const ITALIAN_SET: &[Category] = &[
    C::VerbTense,
    C::VerbConjugation,
    C::GenderAgreement,
    C::NumberAgreement,
    C::Article,
    C::Pronoun,
    C::Preposition,
    C::WordChoice,
    C::WordOrder,
    C::MissingWord,
    C::EnglishMixed,
    C::Other,
];
const ITALIAN_LEVELS: LevelTable = LevelTable {
    beginner: &[
        C::GenderAgreement,
        C::NumberAgreement,
        C::Article,
        C::Preposition,
        C::MissingWord,
        C::WordOrder,
        C::EnglishMixed,
    ],
    beginner_present_only: &[C::VerbConjugation],
    intermediate_needs_structure: &[C::VerbConjugation, C::VerbTense],
    advanced_only: &[],
    above_beginner: &[C::WordChoice, C::Pronoun],
    above_intermediate: &[],
};

/// French. Negation is band 1 ("common negation in conversation"); pronouns
/// band 3.
const FRENCH_SET: &[Category] = &[
    C::VerbTense,
    C::VerbConjugation,
    C::GenderAgreement,
    C::NumberAgreement,
    C::Article,
    C::Negation,
    C::Pronoun,
    C::Preposition,
    C::WordChoice,
    C::WordOrder,
    C::MissingWord,
    C::EnglishMixed,
    C::Other,
];
const FRENCH_LEVELS: LevelTable = LevelTable {
    beginner: &[
        C::GenderAgreement,
        C::NumberAgreement,
        C::Article,
        C::Negation,
        C::MissingWord,
        C::WordOrder,
        C::EnglishMixed,
    ],
    beginner_present_only: &[C::VerbConjugation],
    intermediate_needs_structure: &[C::VerbConjugation, C::VerbTense],
    advanced_only: &[],
    above_beginner: &[C::Preposition, C::WordChoice, C::Pronoun],
    above_intermediate: &[],
};

/// German. Verb-second order and accusative case are band 1 (beginner);
/// separable verbs and dative are band 2; subordinate-clause order is band 3
/// and, like Spanish's band-3 subjunctive, is corrected only at advanced.
const GERMAN_SET: &[Category] = &[
    C::VerbTense,
    C::VerbConjugation,
    C::GenderAgreement,
    C::NumberAgreement,
    C::Article,
    C::Case,
    C::VerbSecond,
    C::SeparableVerb,
    C::SubordinateClause,
    C::Preposition,
    C::WordChoice,
    C::WordOrder,
    C::MissingWord,
    C::EnglishMixed,
    C::Other,
];
const GERMAN_LEVELS: LevelTable = LevelTable {
    beginner: &[
        C::GenderAgreement,
        C::NumberAgreement,
        C::Article,
        C::Case,
        C::VerbSecond,
        C::MissingWord,
        C::WordOrder,
        C::EnglishMixed,
    ],
    beginner_present_only: &[C::VerbConjugation],
    intermediate_needs_structure: &[C::VerbConjugation, C::VerbTense],
    advanced_only: &[C::SubordinateClause],
    above_beginner: &[C::Preposition, C::WordChoice, C::SeparableVerb, C::SubordinateClause],
    above_intermediate: &[C::SubordinateClause],
};

/// Norwegian (Bokmål). Verbs do not conjugate for person, so there is no
/// `VerbConjugation`; present tense is gated through `VerbTense` + `Present`.
/// Definiteness suffixes ride on `Article`. Verb-second is band 2, subordinate
/// clauses band 3.
const NORWEGIAN_SET: &[Category] = &[
    C::VerbTense,
    C::GenderAgreement,
    C::NumberAgreement,
    C::Article,
    C::VerbSecond,
    C::SubordinateClause,
    C::Preposition,
    C::WordChoice,
    C::WordOrder,
    C::MissingWord,
    C::EnglishMixed,
    C::Other,
];
const NORWEGIAN_LEVELS: LevelTable = LevelTable {
    beginner: &[
        C::GenderAgreement,
        C::NumberAgreement,
        C::Article,
        C::MissingWord,
        C::WordOrder,
        C::EnglishMixed,
    ],
    beginner_present_only: &[C::VerbTense],
    intermediate_needs_structure: &[C::VerbTense],
    advanced_only: &[C::SubordinateClause],
    above_beginner: &[C::Preposition, C::WordChoice, C::VerbSecond, C::SubordinateClause],
    above_intermediate: &[C::SubordinateClause],
};

/// English. No gender; articles and countability are band 1; helping verbs
/// (do/be/have) carry questions, negatives and progressives.
const ENGLISH_SET: &[Category] = &[
    C::VerbTense,
    C::VerbConjugation,
    C::NumberAgreement,
    C::Article,
    C::Countability,
    C::AuxiliaryVerb,
    C::Preposition,
    C::WordChoice,
    C::WordOrder,
    C::MissingWord,
    C::EnglishMixed,
    C::Other,
];
const ENGLISH_LEVELS: LevelTable = LevelTable {
    beginner: &[
        C::NumberAgreement,
        C::Article,
        C::Countability,
        C::MissingWord,
        C::WordOrder,
        C::EnglishMixed,
    ],
    beginner_present_only: &[C::VerbConjugation, C::AuxiliaryVerb],
    intermediate_needs_structure: &[C::VerbConjugation, C::AuxiliaryVerb, C::VerbTense],
    advanced_only: &[],
    above_beginner: &[C::Preposition, C::WordChoice],
    above_intermediate: &[],
};

/// Mandarin. No tense, conjugation, gender, number or articles. Measure words,
/// word order and particles are band 1; 了/过 aspect and 不/没 are band 2;
/// 把/被 is band 3 and corrected only at advanced.
const MANDARIN_SET: &[Category] = &[
    C::MeasureWord,
    C::Particle,
    C::Negation,
    C::Aspect,
    C::BaBei,
    C::Preposition,
    C::WordChoice,
    C::WordOrder,
    C::MissingWord,
    C::EnglishMixed,
    C::Other,
];
const MANDARIN_LEVELS: LevelTable = LevelTable {
    beginner: &[
        C::MeasureWord,
        C::Particle,
        C::MissingWord,
        C::WordOrder,
        C::EnglishMixed,
    ],
    beginner_present_only: &[C::Negation],
    intermediate_needs_structure: &[],
    advanced_only: &[C::BaBei],
    above_beginner: &[C::Preposition, C::WordChoice, C::Aspect, C::BaBei],
    above_intermediate: &[C::BaBei],
};

/// The neutral core used for an unknown language id.
const NEUTRAL_LEVELS: LevelTable = LevelTable {
    beginner: &[C::MissingWord, C::WordOrder, C::EnglishMixed],
    beginner_present_only: &[],
    intermediate_needs_structure: &[],
    advanced_only: &[],
    above_beginner: &[C::Preposition, C::WordChoice],
    above_intermediate: &[],
};

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/// One language's view of [`Category`]. Cheap to copy; obtain one with
/// [`Taxonomy::for_id`] or [`Taxonomy::for_module`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Taxonomy {
    /// The shared core only. Used when the language id is unknown or empty.
    Neutral,
    Norwegian,
    Spanish,
    English,
    French,
    German,
    Italian,
    Portuguese,
    Mandarin,
}

impl Taxonomy {
    /// Every real language's taxonomy, in registry order.
    pub const LANGUAGES: [Taxonomy; 8] = [
        Taxonomy::Norwegian,
        Taxonomy::Spanish,
        Taxonomy::English,
        Taxonomy::French,
        Taxonomy::German,
        Taxonomy::Italian,
        Taxonomy::Portuguese,
        Taxonomy::Mandarin,
    ];

    /// Resolve a language id (`nb`, `es`, ...). Anything else, including an
    /// empty id, is [`Taxonomy::Neutral`]. Whether a profile with no stored
    /// language should instead be treated as Spanish (the pre-language data)
    /// is the caller's migration decision, not this module's.
    pub fn for_id(id: &str) -> Taxonomy {
        match id {
            "nb" => Self::Norwegian,
            "es" => Self::Spanish,
            "en" => Self::English,
            "fr" => Self::French,
            "de" => Self::German,
            "it" => Self::Italian,
            "pt" => Self::Portuguese,
            "zh" => Self::Mandarin,
            _ => Self::Neutral,
        }
    }

    /// The taxonomy for a registry module.
    pub fn for_module(module: &super::LanguageModule) -> Taxonomy {
        Self::for_id(module.id)
    }

    /// The registry id, or `None` for the neutral core.
    pub fn language_id(self) -> Option<&'static str> {
        match self {
            Self::Neutral => None,
            Self::Norwegian => Some("nb"),
            Self::Spanish => Some("es"),
            Self::English => Some("en"),
            Self::French => Some("fr"),
            Self::German => Some("de"),
            Self::Italian => Some("it"),
            Self::Portuguese => Some("pt"),
            Self::Mandarin => Some("zh"),
        }
    }

    /// The categories this language's judge may return, in the order they
    /// should be listed in the judge prompt. Always a superset of
    /// [`Category::CORE`].
    pub fn categories(self) -> &'static [Category] {
        match self {
            Self::Neutral => &Category::CORE,
            Self::Norwegian => NORWEGIAN_SET,
            Self::Spanish => SPANISH_SET,
            Self::English => ENGLISH_SET,
            Self::French => FRENCH_SET,
            Self::German => GERMAN_SET,
            Self::Italian => ITALIAN_SET,
            Self::Portuguese => PORTUGUESE_SET,
            Self::Mandarin => MANDARIN_SET,
        }
    }

    /// Wire strings of [`Taxonomy::categories`], for the judge prompt's enum.
    pub fn wire_names(self) -> Vec<&'static str> {
        self.categories().iter().map(|c| c.wire()).collect()
    }

    /// True when this language uses `c`.
    pub fn accepts(self, c: Category) -> bool {
        self.categories().contains(&c)
    }

    /// Parse a wire string, accepting only this language's categories.
    pub fn parse(self, wire: &str) -> Option<Category> {
        Category::from_wire(wire).filter(|c| self.accepts(*c))
    }

    /// The category this language reasons about for `c`: itself when the
    /// language uses it, otherwise the conservative `Other`.
    fn resolve(self, c: Category) -> Category {
        if self.accepts(c) {
            c
        } else {
            Category::Other
        }
    }

    fn levels(self) -> &'static LevelTable {
        match self {
            Self::Neutral => &NEUTRAL_LEVELS,
            Self::Norwegian => &NORWEGIAN_LEVELS,
            Self::Spanish => &SPANISH_LEVELS,
            Self::English => &ENGLISH_LEVELS,
            Self::French => &FRENCH_LEVELS,
            Self::German => &GERMAN_LEVELS,
            Self::Italian => &ITALIAN_LEVELS,
            Self::Portuguese => &PORTUGUESE_LEVELS,
            Self::Mandarin => &MANDARIN_LEVELS,
        }
    }

    /// One plain-English rule sentence. Spanish wording is byte-identical to
    /// `spanish::policy::explanation`. A category the language does not use
    /// gets the `Other` sentence.
    pub fn explanation(self, c: Category) -> &'static str {
        let c = self.resolve(c);
        match (self, c) {
            (Self::Neutral, c) => c.neutral_explanation(),

            // Core categories whose wording names the language.
            (Self::Norwegian, C::Preposition) => "This relationship between words needs a different preposition in Norwegian.",
            (Self::Spanish, C::Preposition) => "This relationship between words needs a different preposition in Spanish.",
            (Self::English, C::Preposition) => "This relationship between words needs a different preposition in English.",
            (Self::French, C::Preposition) => "This relationship between words needs a different preposition in French.",
            (Self::German, C::Preposition) => "This relationship between words needs a different preposition in German.",
            (Self::Italian, C::Preposition) => "This relationship between words needs a different preposition in Italian.",
            (Self::Portuguese, C::Preposition) => "This relationship between words needs a different preposition in Portuguese.",
            (Self::Mandarin, C::Preposition) => "This relationship between words needs a different preposition in Mandarin.",

            (Self::Norwegian, C::WordChoice) => "A different Norwegian word expresses your intended meaning more clearly here.",
            (Self::Spanish, C::WordChoice) => "A different Spanish word expresses your intended meaning more clearly here.",
            (Self::English, C::WordChoice) => "A different English word expresses your intended meaning more clearly here.",
            (Self::French, C::WordChoice) => "A different French word expresses your intended meaning more clearly here.",
            (Self::German, C::WordChoice) => "A different German word expresses your intended meaning more clearly here.",
            (Self::Italian, C::WordChoice) => "A different Italian word expresses your intended meaning more clearly here.",
            (Self::Portuguese, C::WordChoice) => "A different Portuguese word expresses your intended meaning more clearly here.",
            (Self::Mandarin, C::WordChoice) => "A different Mandarin word expresses your intended meaning more clearly here.",

            (Self::Norwegian, C::WordOrder) => "The order of these words needs to fit the structure of this Norwegian sentence.",
            (Self::Spanish, C::WordOrder) => "The order of these words needs to fit the structure of this Spanish sentence.",
            (Self::English, C::WordOrder) => "The order of these words needs to fit the structure of this English sentence.",
            (Self::French, C::WordOrder) => "The order of these words needs to fit the structure of this French sentence.",
            (Self::German, C::WordOrder) => "The order of these words needs to fit the structure of this German sentence.",
            (Self::Italian, C::WordOrder) => "The order of these words needs to fit the structure of this Italian sentence.",
            (Self::Portuguese, C::WordOrder) => "The order of these words needs to fit the structure of this Portuguese sentence.",
            (Self::Mandarin, C::WordOrder) => "The order of these words needs to fit the structure of this Mandarin sentence.",

            (Self::Norwegian, C::MissingWord) => "This Norwegian sentence needs another word to express the complete idea.",
            (Self::Spanish, C::MissingWord) => "This Spanish sentence needs another word to express the complete idea.",
            (Self::English, C::MissingWord) => "This English sentence needs another word to express the complete idea.",
            (Self::French, C::MissingWord) => "This French sentence needs another word to express the complete idea.",
            (Self::German, C::MissingWord) => "This German sentence needs another word to express the complete idea.",
            (Self::Italian, C::MissingWord) => "This Italian sentence needs another word to express the complete idea.",
            (Self::Portuguese, C::MissingWord) => "This Portuguese sentence needs another word to express the complete idea.",
            (Self::Mandarin, C::MissingWord) => "This Mandarin sentence needs another word to express the complete idea.",

            (Self::Norwegian, C::EnglishMixed) => "This Norwegian phrase expresses the idea you asked about in English.",
            (Self::Spanish, C::EnglishMixed) => "This Spanish phrase expresses the idea you asked about in English.",
            (Self::English, C::EnglishMixed) => "This English phrase expresses the idea you asked about in your own words.",
            (Self::French, C::EnglishMixed) => "This French phrase expresses the idea you asked about in English.",
            (Self::German, C::EnglishMixed) => "This German phrase expresses the idea you asked about in English.",
            (Self::Italian, C::EnglishMixed) => "This Italian phrase expresses the idea you asked about in English.",
            (Self::Portuguese, C::EnglishMixed) => "This Portuguese phrase expresses the idea you asked about in English.",
            (Self::Mandarin, C::EnglishMixed) => "This Mandarin phrase expresses the idea you asked about in English.",

            // Language-specific extensions.
            (Self::Spanish, C::SerEstar) => "Spanish uses different verbs for identity and for states or location.",
            (Self::Portuguese, C::SerEstar) => "Portuguese uses different verbs for identity and for states or location.",
            (Self::Norwegian, C::Article) => "The noun's definite or indefinite form needs to fit how it is used here.",
            (Self::Norwegian, C::VerbTense) => "Norwegian marks when an action happens with the verb ending, not with the person.",
            (Self::Norwegian, C::VerbSecond) => "In a Norwegian main clause the verb comes second, so starting with another word moves the subject after it.",
            (Self::Norwegian, C::SubordinateClause) => "In a Norwegian subordinate clause, words like ikke come before the verb rather than after it.",
            (Self::German, C::Case) => "The article, adjective or pronoun needs the case that this noun's role in the sentence calls for.",
            (Self::German, C::VerbSecond) => "In a German main clause the conjugated verb comes second, so starting with another word moves the subject after it.",
            (Self::German, C::SubordinateClause) => "In a German subordinate clause the conjugated verb moves to the end.",
            (Self::German, C::SeparableVerb) => "The prefix of a German separable verb splits off and moves to the end of the clause.",
            (Self::French, C::Negation) => "French negation wraps the verb with ne and pas or a similar pair.",
            (Self::French, C::Pronoun) => "The object pronoun needs the form that fits its role and comes before the verb in French.",
            (Self::Italian, C::Pronoun) => "The object pronoun needs the form that fits its role and its place before or attached to the verb.",
            (Self::Portuguese, C::Pronoun) => "The pronoun needs the form and position that fit its role in this Portuguese sentence.",
            (Self::English, C::Countability) => "This English noun is countable or uncountable, which changes the words that go with it.",
            (Self::English, C::AuxiliaryVerb) => "This English question or negative form needs a helping verb such as do, be or have.",
            (Self::Mandarin, C::MeasureWord) => "In Mandarin a number or 这/那 needs a measure word before the noun.",
            (Self::Mandarin, C::Aspect) => "Mandarin marks completed or experienced actions with 了 and 过 rather than with tense.",
            (Self::Mandarin, C::Particle) => "This sentence needs a different particle, such as 的, 吗 or 呢, to work in Mandarin.",
            (Self::Mandarin, C::BaBei) => "The 把 and 被 constructions put the object before the verb and need their own word order.",
            (Self::Mandarin, C::Negation) => "Mandarin uses 不 for general or future negation and 没 for actions that did not happen.",

            // Shared wording for everything else.
            (_, c) => c.neutral_explanation(),
        }
    }

    /// Short UI label. Spanish labels are byte-identical to
    /// `spanish::policy::category_name`.
    pub fn category_name(self, c: Category) -> &'static str {
        let c = self.resolve(c);
        match (self, c) {
            (Self::Norwegian, C::EnglishMixed) => "Useful Norwegian phrases",
            (Self::Spanish, C::EnglishMixed) => "Useful Spanish phrases",
            (Self::English, C::EnglishMixed) => "Useful English phrases",
            (Self::French, C::EnglishMixed) => "Useful French phrases",
            (Self::German, C::EnglishMixed) => "Useful German phrases",
            (Self::Italian, C::EnglishMixed) => "Useful Italian phrases",
            (Self::Portuguese, C::EnglishMixed) => "Useful Portuguese phrases",
            (Self::Mandarin, C::EnglishMixed) => "Useful Mandarin phrases",
            (Self::Norwegian, C::Article) => "Definite and indefinite forms",
            (Self::Mandarin, C::Negation) => "不 and 没",
            (_, c) => c.neutral_name(),
        }
    }

    /// Whether a correction in category `c` about structure `s` is worth
    /// showing to a learner at `level`. Spanish answers are identical to
    /// `spanish::policy::at_level`.
    pub fn at_level(self, c: Category, s: Structure, level: Level) -> bool {
        self.levels().at_level(self.resolve(c), s, level)
    }

    /// Whether correct use of `c`/`s` is praiseworthy because it is clearly
    /// above `level`. Spanish answers are identical to
    /// `spanish::policy::demonstrably_above_level`.
    pub fn demonstrably_above_level(self, c: Category, s: Structure, level: Level) -> bool {
        self.levels()
            .demonstrably_above_level(self.resolve(c), s, level)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::IntoDeserializer;
    use serde::{Deserialize, Serialize, Serializer};

    const LEVELS: [Level; 3] = [Level::Beginner, Level::Intermediate, Level::Advanced];
    const STRUCTURES: [Structure; 7] = [
        Structure::Present,
        Structure::Past,
        Structure::Future,
        Structure::Subjunctive,
        Structure::Conditional,
        Structure::Register,
        Structure::General,
    ];

    // --- Spanish oracle: verbatim copies of spanish/policy.rs lines 143-195,
    // retyped over the local enums. If spanish/policy.rs changes, change these.

    fn spanish_at_level(c: Category, s: Structure, level: Level) -> bool {
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

    fn spanish_demonstrably_above_level(c: Category, s: Structure, level: Level) -> bool {
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

    /// (variant, wire, explanation, label) as spanish/mod.rs + policy.rs define them.
    const SPANISH_ORACLE: [(Category, &str, &str, &str); 12] = [
        (C::VerbTense, "verb_tense", "The verb tense needs to match when the action happens.", "When actions happen"),
        (C::VerbConjugation, "verb_conjugation", "The verb ending needs to agree with the person doing the action.", "Verb endings"),
        (C::SerEstar, "ser_estar", "Spanish uses different verbs for identity and for states or location.", "Ser and estar"),
        (C::GenderAgreement, "gender_agreement", "The adjective and article need to match the noun's grammatical gender.", "Grammatical gender"),
        (C::NumberAgreement, "number_agreement", "The words describing a noun need to match its singular or plural form.", "Singular and plural"),
        (C::Article, "article", "The article needs to fit the noun and how it is used here.", "Articles"),
        (C::Preposition, "preposition", "This relationship between words needs a different preposition in Spanish.", "Prepositions"),
        (C::WordChoice, "word_choice", "A different Spanish word expresses your intended meaning more clearly here.", "Choosing words"),
        (C::WordOrder, "word_order", "The order of these words needs to fit the structure of this Spanish sentence.", "Word order"),
        (C::MissingWord, "missing_word", "This Spanish sentence needs another word to express the complete idea.", "Complete sentences"),
        (C::EnglishMixed, "english_mixed", "This Spanish phrase expresses the idea you asked about in English.", "Useful Spanish phrases"),
        (C::Other, "other", "This sentence structure needs an adjustment to express your intended meaning clearly.", "Sentence structure"),
    ];

    // --- Spanish behaviour identity ---------------------------------------

    #[test]
    fn spanish_set_is_exactly_the_twelve_in_prompt_order() {
        let expected: Vec<Category> = SPANISH_ORACLE.iter().map(|x| x.0).collect();
        assert_eq!(Taxonomy::Spanish.categories(), expected.as_slice());
        assert_eq!(
            Taxonomy::Spanish.wire_names().join(","),
            "verb_tense,verb_conjugation,ser_estar,gender_agreement,number_agreement,article,preposition,word_choice,word_order,missing_word,english_mixed,other"
        );
    }

    #[test]
    fn spanish_wire_strings_and_wording_are_unchanged() {
        for (c, wire, why, label) in SPANISH_ORACLE {
            assert_eq!(c.wire(), wire);
            assert_eq!(Category::from_wire(wire), Some(c));
            assert_eq!(Taxonomy::Spanish.parse(wire), Some(c));
            assert_eq!(Taxonomy::Spanish.explanation(c), why, "{wire}");
            assert_eq!(Taxonomy::Spanish.category_name(c), label, "{wire}");
        }
    }

    #[test]
    fn spanish_variants_keep_their_declaration_order() {
        // recap() tie-breaks focus areas by Category::cmp, so the relative
        // order of the twelve Spanish variants must not change.
        let es = Taxonomy::Spanish.categories();
        assert!(es.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(&Category::ALL[..12], es);
        assert_eq!(Category::default(), Category::Other);
    }

    #[test]
    fn spanish_level_gating_matches_policy_for_every_input() {
        for c in Taxonomy::Spanish.categories() {
            for s in STRUCTURES {
                for level in LEVELS {
                    assert_eq!(
                        Taxonomy::Spanish.at_level(*c, s, level),
                        spanish_at_level(*c, s, level),
                        "at_level({c}, {s:?}, {level:?})"
                    );
                    assert_eq!(
                        Taxonomy::Spanish.demonstrably_above_level(*c, s, level),
                        spanish_demonstrably_above_level(*c, s, level),
                        "demonstrably_above_level({c}, {s:?}, {level:?})"
                    );
                }
            }
        }
    }

    #[test]
    fn spanish_level_table_from_policy_tests() {
        // Mirrors policy::tests::level_table exactly.
        let es = Taxonomy::Spanish;
        assert!(!es.at_level(C::VerbTense, Structure::Past, Level::Beginner));
        assert!(es.at_level(C::VerbTense, Structure::Past, Level::Intermediate));
        assert!(!es.at_level(C::VerbConjugation, Structure::Subjunctive, Level::Intermediate));
        assert!(!es.at_level(C::SerEstar, Structure::General, Level::Beginner));
        assert!(es.at_level(C::SerEstar, Structure::Present, Level::Beginner));
        assert!(es.at_level(C::Other, Structure::Register, Level::Advanced));
        // Mirrors the gating behind policy::tests::{praise_cadence,
        // ordinary_correct_phrase_is_not_praise, saved_findings_do_not_enter_practicing,
        // cooldown_and_blocking}.
        assert!(es.demonstrably_above_level(C::VerbTense, Structure::Past, Level::Beginner));
        assert!(!es.demonstrably_above_level(C::Article, Structure::Present, Level::Beginner));
        assert!(!es.at_level(C::VerbTense, Structure::Past, Level::Beginner));
        assert!(es.at_level(C::GenderAgreement, Structure::Present, Level::Beginner));
        assert!(es.at_level(C::Article, Structure::Present, Level::Beginner));
        // The judge prompt's band summary.
        assert!(es.at_level(C::Preposition, Structure::General, Level::Intermediate));
        assert!(es.at_level(C::WordChoice, Structure::General, Level::Intermediate));
        assert!(!es.at_level(C::Preposition, Structure::General, Level::Beginner));
        assert!(!es.at_level(C::WordChoice, Structure::Present, Level::Beginner));
    }

    // --- Wire format ----------------------------------------------------------

    /// Minimal serializer that captures a `serialize_str` call, so the serde
    /// path can be exercised without serde_json.
    struct Capture;
    #[derive(Debug)]
    struct Unsupported;
    impl fmt::Display for Unsupported {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("unsupported")
        }
    }
    impl std::error::Error for Unsupported {}
    impl serde::ser::Error for Unsupported {
        fn custom<T: fmt::Display>(_: T) -> Self {
            Unsupported
        }
    }
    macro_rules! unsupported {
        ($($name:ident($($arg:ty),*)),* $(,)?) => {
            $(fn $name(self, $(_: $arg),*) -> Result<Self::Ok, Self::Error> { Err(Unsupported) })*
        };
    }
    impl Serializer for Capture {
        type Ok = String;
        type Error = Unsupported;
        type SerializeSeq = serde::ser::Impossible<String, Unsupported>;
        type SerializeTuple = serde::ser::Impossible<String, Unsupported>;
        type SerializeTupleStruct = serde::ser::Impossible<String, Unsupported>;
        type SerializeTupleVariant = serde::ser::Impossible<String, Unsupported>;
        type SerializeMap = serde::ser::Impossible<String, Unsupported>;
        type SerializeStruct = serde::ser::Impossible<String, Unsupported>;
        type SerializeStructVariant = serde::ser::Impossible<String, Unsupported>;
        fn serialize_str(self, v: &str) -> Result<String, Unsupported> {
            Ok(v.to_owned())
        }
        unsupported! {
            serialize_bool(bool), serialize_i8(i8), serialize_i16(i16), serialize_i32(i32),
            serialize_i64(i64), serialize_u8(u8), serialize_u16(u16), serialize_u32(u32),
            serialize_u64(u64), serialize_f32(f32), serialize_f64(f64), serialize_char(char),
            serialize_bytes(&[u8]), serialize_none(), serialize_unit(),
            serialize_unit_struct(&'static str),
            serialize_unit_variant(&'static str, u32, &'static str),
        }
        fn serialize_some<T: ?Sized + Serialize>(self, _: &T) -> Result<String, Unsupported> {
            Err(Unsupported)
        }
        fn serialize_newtype_struct<T: ?Sized + Serialize>(self, _: &'static str, _: &T) -> Result<String, Unsupported> {
            Err(Unsupported)
        }
        fn serialize_newtype_variant<T: ?Sized + Serialize>(self, _: &'static str, _: u32, _: &'static str, _: &T) -> Result<String, Unsupported> {
            Err(Unsupported)
        }
        fn serialize_seq(self, _: Option<usize>) -> Result<Self::SerializeSeq, Unsupported> {
            Err(Unsupported)
        }
        fn serialize_tuple(self, _: usize) -> Result<Self::SerializeTuple, Unsupported> {
            Err(Unsupported)
        }
        fn serialize_tuple_struct(self, _: &'static str, _: usize) -> Result<Self::SerializeTupleStruct, Unsupported> {
            Err(Unsupported)
        }
        fn serialize_tuple_variant(self, _: &'static str, _: u32, _: &'static str, _: usize) -> Result<Self::SerializeTupleVariant, Unsupported> {
            Err(Unsupported)
        }
        fn serialize_map(self, _: Option<usize>) -> Result<Self::SerializeMap, Unsupported> {
            Err(Unsupported)
        }
        fn serialize_struct(self, _: &'static str, _: usize) -> Result<Self::SerializeStruct, Unsupported> {
            Err(Unsupported)
        }
        fn serialize_struct_variant(self, _: &'static str, _: u32, _: &'static str, _: usize) -> Result<Self::SerializeStructVariant, Unsupported> {
            Err(Unsupported)
        }
    }

    /// Deserialise from a bare string through serde's own `StrDeserializer`,
    /// which is how a JSON string reaches these types without serde_json.
    fn de<'a, T: Deserialize<'a>>(wire: &'a str) -> Result<T, serde::de::value::Error> {
        T::deserialize(wire.into_deserializer())
    }
    fn deserialize(wire: &str) -> Result<Category, serde::de::value::Error> {
        de(wire)
    }

    #[test]
    fn every_category_round_trips_through_serde_and_wire() {
        for c in Category::ALL {
            let wire = c.wire();
            assert_eq!(c.serialize(Capture).unwrap(), wire, "{c:?} serialises to its wire string");
            assert_eq!(deserialize(wire).unwrap(), c, "{wire} deserialises");
            assert_eq!(Category::from_wire(wire), Some(c));
            assert_eq!(c.to_string(), wire);
        }
    }

    #[test]
    fn every_language_set_round_trips_and_has_unique_wire_strings() {
        for t in Taxonomy::LANGUAGES.iter().chain([&Taxonomy::Neutral]) {
            let names = t.wire_names();
            for (c, wire) in t.categories().iter().zip(&names) {
                assert_eq!(t.parse(wire), Some(*c), "{t:?} {wire}");
                assert_eq!(deserialize(wire).unwrap(), *c);
            }
            for (i, a) in names.iter().enumerate() {
                assert!(!names[..i].contains(a), "{t:?} lists {a} twice");
            }
            assert_eq!(names.len(), t.categories().len());
        }
    }

    #[test]
    fn wire_strings_are_snake_case_and_globally_unique() {
        for (i, (_, wire)) in WIRE.iter().enumerate() {
            assert!(
                !wire.is_empty()
                    && wire.chars().all(|ch| ch.is_ascii_lowercase() || ch == '_')
                    && !wire.starts_with('_')
                    && !wire.ends_with('_'),
                "{wire}"
            );
            assert!(!WIRE[..i].iter().any(|(_, w)| w == wire), "{wire} duplicated");
        }
        assert_eq!(WIRE.len(), Category::ALL.len());
        assert_eq!(WIRE_NAMES.len(), WIRE.len());
    }

    #[test]
    fn level_and_structure_wire_forms_match_spanish() {
        assert_eq!(de::<Level>("beginner"), Ok(Level::Beginner));
        assert_eq!(de::<Level>("intermediate"), Ok(Level::Intermediate));
        assert_eq!(de::<Level>("advanced"), Ok(Level::Advanced));
        assert_eq!(Level::default(), Level::Beginner);
        assert_eq!(Level::Beginner.dial(), 0);
        assert_eq!(Level::Advanced.name(), "advanced");
        for (wire, s) in [
            ("present", Structure::Present),
            ("past", Structure::Past),
            ("future", Structure::Future),
            ("subjunctive", Structure::Subjunctive),
            ("conditional", Structure::Conditional),
            ("register", Structure::Register),
            ("general", Structure::General),
        ] {
            assert_eq!(de::<Structure>(wire), Ok(s));
        }
        assert_eq!(Structure::default(), Structure::General);
    }

    // --- Degradation ------------------------------------------------------------

    #[test]
    fn unknown_wire_strings_are_rejected_not_panicked() {
        for bad in ["", "invented", "SerEstar", "ser-estar", "ser_estar ", "verbo"] {
            assert_eq!(Category::from_wire(bad), None, "{bad:?}");
            assert!(deserialize(bad).is_err(), "{bad:?}");
            for t in Taxonomy::LANGUAGES.iter().chain([&Taxonomy::Neutral]) {
                assert_eq!(t.parse(bad), None);
            }
        }
    }

    #[test]
    fn unknown_language_degrades_to_neutral_core() {
        for id in ["", "xx", "ES", "es-ES", "spanish", "  "] {
            let t = Taxonomy::for_id(id);
            assert_eq!(t, Taxonomy::Neutral, "{id:?}");
            assert_eq!(t.language_id(), None);
            assert_eq!(t.categories(), &Category::CORE);
        }
        let n = Taxonomy::Neutral;
        // Core categories keep their own meaning.
        assert_eq!(n.explanation(C::WordOrder), C::WordOrder.neutral_explanation());
        assert_eq!(n.category_name(C::MissingWord), "Complete sentences");
        assert!(n.at_level(C::WordOrder, Structure::Present, Level::Beginner));
        assert!(n.at_level(C::Preposition, Structure::General, Level::Intermediate));
        assert!(!n.at_level(C::Preposition, Structure::General, Level::Beginner));
        // Non-core categories collapse to Other: advanced-only, never a panic.
        for c in [C::SerEstar, C::GenderAgreement, C::MeasureWord, C::Case] {
            assert_eq!(n.explanation(c), C::Other.neutral_explanation());
            assert_eq!(n.category_name(c), "Sentence structure");
            assert!(!n.at_level(c, Structure::Present, Level::Beginner));
            assert!(!n.at_level(c, Structure::Present, Level::Intermediate));
            assert!(n.at_level(c, Structure::Present, Level::Advanced));
            assert!(!n.demonstrably_above_level(c, Structure::Present, Level::Beginner));
        }
    }

    #[test]
    fn out_of_set_category_behaves_as_other_for_that_language() {
        // A judge returning gender agreement for Mandarin or ser/estar for
        // German is wrong; the card degrades to the generic sentence and the
        // conservative advanced-only gate rather than a misleading rule.
        let cases = [
            (Taxonomy::Mandarin, C::GenderAgreement),
            (Taxonomy::Mandarin, C::VerbTense),
            (Taxonomy::German, C::SerEstar),
            (Taxonomy::English, C::MeasureWord),
            (Taxonomy::Spanish, C::Case),
            (Taxonomy::Norwegian, C::VerbConjugation),
        ];
        for (t, c) in cases {
            assert!(!t.accepts(c));
            assert_eq!(t.parse(c.wire()), None);
            assert_eq!(t.explanation(c), t.explanation(C::Other));
            assert_eq!(t.category_name(c), "Sentence structure");
            for s in STRUCTURES {
                assert!(!t.at_level(c, s, Level::Beginner));
                assert!(!t.at_level(c, s, Level::Intermediate));
                assert!(t.at_level(c, s, Level::Advanced));
                for level in LEVELS {
                    assert!(!t.demonstrably_above_level(c, s, level));
                }
            }
        }
    }

    #[test]
    fn nothing_panics_over_the_full_input_space() {
        let ids = ["nb", "es", "en", "fr", "de", "it", "pt", "zh", "", "??"];
        for id in ids {
            let t = Taxonomy::for_id(id);
            for c in Category::ALL {
                assert!(!t.explanation(c).is_empty());
                assert!(!t.category_name(c).is_empty());
                for s in STRUCTURES {
                    for level in LEVELS {
                        let _ = t.at_level(c, s, level);
                        let _ = t.demonstrably_above_level(c, s, level);
                    }
                }
            }
        }
    }

    // --- Structural invariants ---------------------------------------------------

    #[test]
    fn every_registry_language_has_a_taxonomy_containing_the_core() {
        for m in &super::super::LANGUAGES {
            let t = Taxonomy::for_module(m);
            assert_ne!(t, Taxonomy::Neutral, "{}", m.id);
            assert_eq!(t.language_id(), Some(m.id));
            for c in Category::CORE {
                assert!(t.accepts(c), "{} lacks core {c}", m.id);
            }
            assert!(t.categories().contains(&C::Other));
        }
        assert_eq!(Taxonomy::LANGUAGES.len(), super::super::LANGUAGES.len());
    }

    #[test]
    fn level_tables_only_reference_categories_the_language_uses() {
        for t in Taxonomy::LANGUAGES.iter().chain([&Taxonomy::Neutral]) {
            let l = t.levels();
            for list in [
                l.beginner,
                l.beginner_present_only,
                l.intermediate_needs_structure,
                l.advanced_only,
                l.above_beginner,
                l.above_intermediate,
            ] {
                for c in list {
                    assert!(t.accepts(*c), "{t:?} gates {c} but does not use it");
                    assert_ne!(*c, C::Other, "{t:?}: Other is implied, never listed");
                }
            }
            // Advanced-only categories are praiseworthy below advanced and are
            // never also listed as beginner material.
            for c in l.advanced_only {
                assert!(l.above_beginner.contains(c) && l.above_intermediate.contains(c), "{t:?} {c}");
                assert!(!l.beginner.contains(c) && !l.beginner_present_only.contains(c));
            }
        }
    }

    #[test]
    fn every_language_gates_the_same_way_at_advanced_and_for_hard_structures() {
        for t in Taxonomy::LANGUAGES {
            for c in t.categories() {
                for s in STRUCTURES {
                    assert!(t.at_level(*c, s, Level::Advanced));
                    assert!(!t.demonstrably_above_level(*c, s, Level::Advanced));
                }
                for s in [Structure::Subjunctive, Structure::Conditional, Structure::Register] {
                    assert!(!t.at_level(*c, s, Level::Beginner));
                    assert!(!t.at_level(*c, s, Level::Intermediate));
                }
                assert!(!t.at_level(C::Other, Structure::Present, Level::Intermediate));
                assert!(t.at_level(C::EnglishMixed, Structure::General, Level::Beginner));
            }
        }
    }

    // --- Language-specific behaviour --------------------------------------------

    #[test]
    fn mandarin_differs_from_spanish() {
        let zh = Taxonomy::Mandarin;
        for c in [C::VerbTense, C::VerbConjugation, C::GenderAgreement, C::NumberAgreement, C::Article, C::SerEstar] {
            assert!(!zh.accepts(c), "{c}");
        }
        for c in [C::MeasureWord, C::Aspect, C::Particle, C::BaBei, C::Negation] {
            assert!(zh.accepts(c), "{c}");
            assert!(!Taxonomy::Spanish.accepts(c), "{c}");
        }
        assert!(zh.at_level(C::MeasureWord, Structure::General, Level::Beginner));
        assert!(zh.at_level(C::Particle, Structure::General, Level::Beginner));
        assert!(zh.at_level(C::Negation, Structure::Present, Level::Beginner));
        assert!(!zh.at_level(C::Negation, Structure::General, Level::Beginner));
        assert!(!zh.at_level(C::Aspect, Structure::Past, Level::Beginner));
        assert!(zh.at_level(C::Aspect, Structure::Past, Level::Intermediate));
        assert!(zh.at_level(C::Aspect, Structure::General, Level::Intermediate));
        // 把/被 is advanced: not corrected below, praiseworthy below.
        assert!(!zh.at_level(C::BaBei, Structure::Present, Level::Beginner));
        assert!(!zh.at_level(C::BaBei, Structure::Present, Level::Intermediate));
        assert!(zh.at_level(C::BaBei, Structure::Present, Level::Advanced));
        assert!(zh.demonstrably_above_level(C::BaBei, Structure::Present, Level::Intermediate));
        assert!(zh.demonstrably_above_level(C::Aspect, Structure::General, Level::Beginner));
        assert_eq!(zh.category_name(C::EnglishMixed), "Useful Mandarin phrases");
        assert_eq!(zh.category_name(C::Negation), "不 and 没");
        assert!(zh.explanation(C::Aspect).contains('了'));
    }

    #[test]
    fn german_differs_from_spanish() {
        let de = Taxonomy::German;
        for c in [C::Case, C::VerbSecond, C::SubordinateClause, C::SeparableVerb] {
            assert!(de.accepts(c), "{c}");
            assert!(!Taxonomy::Spanish.accepts(c), "{c}");
        }
        assert!(!de.accepts(C::SerEstar));
        // Verb-second and case are beginner corrections.
        assert!(de.at_level(C::VerbSecond, Structure::General, Level::Beginner));
        assert!(de.at_level(C::Case, Structure::General, Level::Beginner));
        // Separable verbs are intermediate.
        assert!(!de.at_level(C::SeparableVerb, Structure::Present, Level::Beginner));
        assert!(de.at_level(C::SeparableVerb, Structure::General, Level::Intermediate));
        assert!(de.demonstrably_above_level(C::SeparableVerb, Structure::Present, Level::Beginner));
        // Subordinate-clause order waits for advanced, like Spanish subjunctive.
        assert!(!de.at_level(C::SubordinateClause, Structure::Present, Level::Beginner));
        assert!(!de.at_level(C::SubordinateClause, Structure::Present, Level::Intermediate));
        assert!(de.at_level(C::SubordinateClause, Structure::Present, Level::Advanced));
        assert!(de.demonstrably_above_level(C::SubordinateClause, Structure::Present, Level::Intermediate));
        // Konjunktiv II requests arrive as `conditional` and stay advanced.
        assert!(!de.at_level(C::VerbConjugation, Structure::Conditional, Level::Intermediate));
        assert_eq!(de.category_name(C::Case), "Grammatical case");
        assert!(de.explanation(C::SubordinateClause).contains("end"));
    }

    #[test]
    fn other_languages_follow_their_teaching_focus() {
        // Norwegian: no person conjugation, present tense at beginner via VerbTense.
        let nb = Taxonomy::Norwegian;
        assert!(!nb.accepts(C::VerbConjugation));
        assert!(nb.at_level(C::VerbTense, Structure::Present, Level::Beginner));
        assert!(!nb.at_level(C::VerbTense, Structure::Past, Level::Beginner));
        assert!(!nb.at_level(C::VerbSecond, Structure::General, Level::Beginner));
        assert!(nb.at_level(C::VerbSecond, Structure::General, Level::Intermediate));
        assert!(!nb.at_level(C::SubordinateClause, Structure::General, Level::Intermediate));
        assert_eq!(nb.category_name(C::Article), "Definite and indefinite forms");
        // English: no gender; countability and articles at beginner; do-support present only.
        let en = Taxonomy::English;
        assert!(!en.accepts(C::GenderAgreement));
        assert!(en.at_level(C::Countability, Structure::General, Level::Beginner));
        assert!(en.at_level(C::AuxiliaryVerb, Structure::Present, Level::Beginner));
        assert!(!en.at_level(C::AuxiliaryVerb, Structure::General, Level::Beginner));
        assert!(!en.at_level(C::AuxiliaryVerb, Structure::General, Level::Intermediate));
        assert!(en.at_level(C::AuxiliaryVerb, Structure::Past, Level::Intermediate));
        // Italian: prepositions are a beginner focus, unlike Spanish.
        assert!(Taxonomy::Italian.at_level(C::Preposition, Structure::General, Level::Beginner));
        assert!(!Taxonomy::Spanish.at_level(C::Preposition, Structure::General, Level::Beginner));
        // French: negation at beginner; pronouns intermediate.
        assert!(Taxonomy::French.at_level(C::Negation, Structure::General, Level::Beginner));
        assert!(!Taxonomy::French.at_level(C::Pronoun, Structure::General, Level::Beginner));
        assert!(Taxonomy::French.at_level(C::Pronoun, Structure::General, Level::Intermediate));
        // Portuguese shares ser/estar with Spanish but says so in its own words.
        let pt = Taxonomy::Portuguese;
        assert!(pt.accepts(C::SerEstar));
        assert!(pt.at_level(C::SerEstar, Structure::Present, Level::Beginner));
        assert_eq!(pt.explanation(C::SerEstar), "Portuguese uses different verbs for identity and for states or location.");
        assert_eq!(pt.category_name(C::SerEstar), "Ser and estar");
        // Shared wording never leaks another language's name.
        for t in Taxonomy::LANGUAGES {
            if t != Taxonomy::Spanish {
                for c in t.categories() {
                    assert!(!t.explanation(*c).contains("Spanish"), "{t:?} {c}");
                    assert!(!t.category_name(*c).contains("Spanish"), "{t:?} {c}");
                }
            }
        }
    }
}
