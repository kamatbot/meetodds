//! Root for `tools/spanish-core-tests`.
//!
//! The tutoring engine depends on `crate::languages` (text policies, grammar
//! taxonomy, scenes, free-talk content, prompts), so this root compiles the
//! language registry alongside it, mirroring `frontend/src-tauri/src/tutoring_core.rs`.
//! The engine is re-exported at the crate top level so the existing tests and
//! the manual `judge_golden` example keep addressing it as `spanish_core::…`.
//! Keep the module set in step with `lib.rs`.

#[path = "../../../frontend/src-tauri/src/languages/mod.rs"]
pub mod languages;

#[path = "../../../frontend/src-tauri/src/spanish/mod.rs"]
pub mod spanish;

pub use spanish::*;
