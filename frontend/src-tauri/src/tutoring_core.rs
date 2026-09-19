//! Standalone root that compiles the tutoring core — the language registry and
//! the tutoring engine — as one dependency-free lib.
//!
//! NOT declared by `lib.rs`: the real Tauri crate reaches both trees through its
//! own `pub mod languages;` / `pub mod spanish;`. This root exists only so
//! `tools/tutoring-core-tests` can build the two together, which is what lets
//! the engine reference `crate::languages::…` while staying testable without
//! Tauri, audio, GPU or a model.
//!
//! Keep the module set here in step with `lib.rs`.

#[path = "languages/mod.rs"]
pub mod languages;

#[path = "spanish/mod.rs"]
pub mod spanish;
