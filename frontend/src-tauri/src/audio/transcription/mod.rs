// audio/transcription/mod.rs
//
// Transcription module: Apple Speech live sessions and the shared event contracts.

pub mod apple;
pub mod preview_control;
pub mod live_preview;
pub mod worker;

// Re-export commonly used types
pub use live_preview::LiveTranscriptPreviewUpdate;
pub use worker::{reset_speech_detected_flag, TranscriptUpdate};
