//! Spanish tutoring core. No microphone, voice, window, meeting, or cloud ownership.
//! The companion branch supplies its command shell and persists these values.
// ponytail: gated so `cargo test --manifest-path tools/spanish-core-tests/Cargo.toml`
// (which compiles this file as a standalone lib target with no tauri/sqlx/reqwest
// deps) doesn't try to pull in the Tauri command shell. See Cargo.toml's
// `tauri-commands` feature, on by default for the real frontend crate.
#[cfg(feature = "tauri-commands")]
pub mod commands;
pub mod persistence;
pub mod policy;
pub mod scenes;
pub mod text;
pub mod speech;
pub mod romanization;
pub mod tutor;
pub use tutor::{Mode, TutorEngine, TutorReplyEvent, TutorRequest, TutorResponse};

use serde::{Deserialize, Serialize};

/// Learner level, grammar category and judge structure metadata are the
/// wire-compatible types from the language registry: one flat `Category`
/// namespace for every language (the Spanish twelve keep their names, order
/// and snake_case wire strings), so a German judge can return `case` and a
/// Mandarin one `measure_word` through the same `Feedback` struct. Which
/// categories a given language's judge may return is decided by
/// `languages::grammar::Taxonomy`, checked in `policy::validate`.
pub use crate::languages::grammar::{Category, Level, Structure};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Blocking,
    #[default]
    Core,
    Polish,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackKind {
    Correction,
    Praise,
    Practiced,
    Translation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticingPhrase {
    pub phrase: String,
    pub category: Category,
    #[serde(default)]
    pub uses: u32,
    #[serde(default)]
    pub mastered: bool,
    pub added_at: u64,
    /// Persisted evidence: repeated uses in one session cannot establish mastery.
    #[serde(default)]
    pub use_session_ids: Vec<String>,
}
/// A learner's practice profile for one target language.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnerProfile {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub level: Level,
    /// `LanguageModule` id from `crate::languages` (nb, es, en, fr, de, it, pt,
    /// zh). Empty on profiles written before the tutor carried a language;
    /// [`LearnerProfile::language_id`] resolves those to Spanish, matching the
    /// `DEFAULT 'es'` the database migration backfills.
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub variety: String,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub practicing: Vec<PracticingPhrase>,
}

/// Target language this profile practises. Never empty, never panics: a blank
/// or unrecognised stored value reads as Spanish, which is what every profile
/// written before the tutor became multilingual actually was.
pub const LEGACY_LANGUAGE_ID: &str = "es";

/// Maps a stored or client-supplied language id onto a registered one. Blank
/// (pre-multilingual profiles) and unrecognised ids both read as Spanish, so
/// every per-language lookup in the engine (text policy, grammar taxonomy,
/// scenes, free-talk content, prompts) degrades to the legacy behaviour
/// instead of to a generic default or a panic.
pub fn resolve_language_id(id: &str) -> &'static str {
    crate::languages::module(id.trim())
        .map(|m| m.id)
        .unwrap_or(LEGACY_LANGUAGE_ID)
}

/// The registry module for a language id, resolved as [`resolve_language_id`].
/// Total: Spanish is always registered, so the fallback is never reached.
pub fn language_module(id: &str) -> &'static crate::languages::LanguageModule {
    crate::languages::module(resolve_language_id(id)).unwrap_or(&crate::languages::SPANISH)
}

impl LearnerProfile {
    pub fn language_id(&self) -> &'static str {
        resolve_language_id(&self.language)
    }
    pub fn language_module(&self) -> &'static crate::languages::LanguageModule {
        language_module(&self.language)
    }
}

/// Former name of [`LearnerProfile`], kept so the Tauri command shell and any
/// stored payloads keep resolving while the rename lands.
pub type SpanishProfile = LearnerProfile;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub kind: FeedbackKind,
    pub you_said: String,
    pub try_this: String,
    pub why: String,
    #[serde(default)]
    pub category: Category,
    #[serde(default)]
    pub severity: Severity,
    #[serde(default)]
    pub shown: bool,
    #[serde(default)]
    pub turn_index: usize,
    #[serde(default = "one")]
    pub count: usize,
}
fn one() -> usize {
    1
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub role: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub tokens: usize,
    /// None means the judge failed, was unavailable, or did not assess this turn.
    /// It is not evidence of error-free Spanish.
    pub error: Option<bool>,
    pub english_mixed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryShown {
    pub category: Category,
    pub turn_index: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenerUse {
    pub session_id: String,
    pub opener_id: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionState {
    pub session_id: String,
    pub scene_id: String,
    pub beat: usize,
    pub beat_turns: usize,
    pub scene_done: bool,
    pub turn_index: usize,
    pub dial: u8,
    pub window: Vec<Observation>,
    pub last_card_turn: Option<usize>,
    pub last_praise_turn: Option<usize>,
    pub shown_categories: Vec<CategoryShown>,
    pub feedback: Vec<Feedback>,
    pub turns: Vec<Turn>,
    pub previous_correction: Option<String>,
    pub last_reply: String,
    pub minimal_streak: usize,
    pub previous_turn_filler: bool,
    pub mastered_this_session: Vec<String>,
    pub opener_history: Vec<OpenerUse>,
    pub assessed_turns: usize,
    pub error_turns: usize,
}
impl SessionState {
    pub fn new(session_id: &str, scene_id: &str, level: Level) -> Self {
        Self {
            session_id: session_id.into(),
            scene_id: scene_id.into(),
            dial: level.dial(),
            ..Self::default()
        }
    }
    pub fn remember(&mut self, role: &str, text: &str) {
        self.turns.push(Turn {
            role: role.into(),
            text: text.into(),
        });
        if self.turns.len() > 8 {
            self.turns.remove(0);
        }
    }
}
