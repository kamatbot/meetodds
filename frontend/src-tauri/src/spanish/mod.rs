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
pub mod tutor;
pub use tutor::{Mode, TutorEngine, TutorReplyEvent, TutorRequest, TutorResponse};

use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
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
    EnglishMixed,
    Other,
}
impl Default for Category {
    fn default() -> Self {
        Self::Other
    }
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Blocking,
    #[default]
    Core,
    Polish,
}
/// Optional judge metadata disambiguates present conjugation from subjunctive, etc.
/// Missing metadata is treated conservatively, not assumed to be present tense.
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanishProfile {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub level: Level,
    #[serde(default)]
    pub variety: String,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub practicing: Vec<PracticingPhrase>,
}
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
