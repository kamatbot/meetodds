// audio/transcription/live_preview.rs
//
// Event payload for provisional captions (`live-transcript-preview`). Apple Speech
// partial results are emitted with this contract; final text uses `transcript-update`.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranscriptPreviewUpdate {
    pub text: String,
    pub source: String,
    pub speaker: String,
    pub speaker_label: String,
    pub revision: u64,
    pub audio_start_time: f64,
    pub audio_end_time: f64,
    pub latency_ms: u64,
}
