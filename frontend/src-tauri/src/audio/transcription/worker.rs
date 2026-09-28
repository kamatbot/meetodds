// audio/transcription/worker.rs
//
// Shared transcript event contract and per-session flags used by the live path.

use log::info;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Runtime};

// Sequence counter for transcript updates
static SEQUENCE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn next_sequence_id() -> u64 {
    SEQUENCE_COUNTER.fetch_add(1, Ordering::SeqCst)
}

pub(crate) fn emit_speech_detected<R: Runtime>(app: &AppHandle<R>) {
    if !SPEECH_DETECTED_EMITTED.swap(true, Ordering::SeqCst) {
        let _ = app.emit("speech-detected", serde_json::json!({"message": "Speech activity detected"}));
    }
}

// Speech detection flag - reset per recording session
static SPEECH_DETECTED_EMITTED: AtomicBool = AtomicBool::new(false);

/// Reset the speech detected flag for a new recording session
pub fn reset_speech_detected_flag() {
    SPEECH_DETECTED_EMITTED.store(false, Ordering::SeqCst);
    info!("Speech-detected flag reset for new recording");
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscriptUpdate {
    pub text: String,
    pub timestamp: String, // Wall-clock time for reference (e.g., "14:30:05")
    pub source: String,
    pub speaker: String,
    pub speaker_label: String,
    pub speaker_source: String,
    pub speaker_confidence: f32,
    pub sequence_id: u64,
    pub chunk_start_time: f64, // Legacy field, kept for compatibility
    pub is_partial: bool,
    pub confidence: f32,
    // Recording-relative timestamps for playback sync
    pub audio_start_time: f64, // Seconds from recording start (e.g., 125.3)
    pub audio_end_time: f64,   // Seconds from recording start (e.g., 128.6)
    pub duration: f64,         // Segment duration in seconds (e.g., 3.3)
}
