// audio/transcription/mod.rs
//
// Transcription module: Provider abstraction, engine management, and worker pool.

pub mod engine;
pub mod live_preview;
pub mod parakeet_provider;
pub mod provider;
pub mod speaker_detection;
pub mod whisper_provider;
pub mod worker;

// Re-export commonly used types
pub use engine::{
    get_or_init_transcription_engine, get_or_init_whisper, validate_transcription_model_ready,
    TranscriptionEngine,
};
pub use live_preview::{start_live_preview_task, LiveTranscriptPreviewUpdate};
pub use parakeet_provider::ParakeetProvider;
pub use provider::{TranscriptResult, TranscriptionError, TranscriptionProvider};
pub use whisper_provider::WhisperProvider;
pub use worker::{reset_speech_detected_flag, start_transcription_task, TranscriptUpdate};
