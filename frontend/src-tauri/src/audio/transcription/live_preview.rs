use super::engine::{get_or_init_transcription_engine, TranscriptionEngine};
use super::worker::canonical_transcription_busy;
use crate::audio::recording_state::{AudioChunk, DeviceType};
use log::{debug, warn};
use serde::Serialize;
use std::collections::HashMap;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::watch;

const MAX_STALE_REVISIONS: u64 = 2;

#[derive(Debug)]
struct LastEmittedPreview {
    text: String,
    audio_end_time: f64,
}

fn should_emit_preview(
    last_emitted: &HashMap<String, LastEmittedPreview>,
    source: &str,
    text: &str,
    audio_start_time: f64,
) -> bool {
    match last_emitted.get(source) {
        Some(previous) => previous.text != text || audio_start_time > previous.audio_end_time,
        None => true,
    }
}

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

pub fn start_live_preview_task<R: Runtime>(
    app: AppHandle<R>,
    mut receiver: watch::Receiver<Option<AudioChunk>>,
    channel_separated: bool,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let engine = match get_or_init_transcription_engine(&app).await {
            Ok(engine) => engine,
            Err(error) => {
                warn!("Live subtitle preview unavailable: {}", error);
                return;
            }
        };
        let mut last_emitted: HashMap<String, LastEmittedPreview> = HashMap::new();

        while receiver.changed().await.is_ok() {
            let Some(chunk) = ({ receiver.borrow_and_update().clone() }) else {
                continue;
            };

            // Never start speculative work while the canonical sentence decoder is active.
            if canonical_transcription_busy() {
                continue;
            }

            let revision = chunk.chunk_id;
            let source = match &chunk.device_type {
                DeviceType::Microphone => "microphone",
                DeviceType::System => "system",
            };
            let started = Instant::now();
            let text = match decode_preview(&engine, &chunk).await {
                Ok(text) => text.trim().to_string(),
                Err(error) => {
                    debug!("Speculative subtitle decode skipped: {}", error);
                    continue;
                }
            };
            if text.is_empty() || canonical_transcription_busy() {
                continue;
            }

            // If capture moved several snapshots ahead while inference was running, this
            // result is no longer a useful subtitle. A one/two-revision lag is still shown
            // because slightly-old text is preferable to a blank subtitle.
            let latest_revision = receiver
                .borrow()
                .as_ref()
                .map(|latest| latest.chunk_id)
                .unwrap_or(revision);
            if latest_revision.saturating_sub(revision) > MAX_STALE_REVISIONS {
                continue;
            }

            let duration = chunk.data.len() as f64 / chunk.sample_rate as f64;
            let audio_end_time = chunk.timestamp + duration;
            if !should_emit_preview(&last_emitted, source, &text, chunk.timestamp) {
                continue;
            }
            last_emitted.insert(
                source.to_string(),
                LastEmittedPreview {
                    text: text.clone(),
                    audio_end_time,
                },
            );

            let (speaker, speaker_label) = match (&chunk.device_type, channel_separated) {
                (DeviceType::Microphone, true) => ("me", "Me"),
                (DeviceType::System, _) => ("remote-live", "Other"),
                (DeviceType::Microphone, false) => ("room-live", "Live"),
            };
            let update = LiveTranscriptPreviewUpdate {
                text,
                source: source.to_string(),
                speaker: speaker.to_string(),
                speaker_label: speaker_label.to_string(),
                revision,
                audio_start_time: chunk.timestamp,
                audio_end_time,
                latency_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            };
            let _ = app.emit("live-transcript-preview", update);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn re_emits_a_repeated_caption_for_a_new_utterance() {
        let mut last_emitted = HashMap::new();
        last_emitted.insert(
            "microphone".to_string(),
            LastEmittedPreview {
                text: "Yes".to_string(),
                audio_end_time: 10.0,
            },
        );

        assert!(!should_emit_preview(
            &last_emitted,
            "microphone",
            "Yes",
            9.5
        ));
        assert!(should_emit_preview(
            &last_emitted,
            "microphone",
            "Yes",
            10.1
        ));
    }
}

async fn decode_preview(
    engine: &TranscriptionEngine,
    chunk: &AudioChunk,
) -> Result<String, String> {
    let language = crate::get_language_preference_internal();
    match engine {
        TranscriptionEngine::Whisper(engine) => engine
            .transcribe_audio_preview(chunk.data.clone(), language)
            .await
            .map_err(|error| error.to_string()),
        TranscriptionEngine::Parakeet(engine) => engine
            .transcribe_audio(chunk.data.clone())
            .await
            .map_err(|error| error.to_string()),
        TranscriptionEngine::Provider(provider) => provider
            .transcribe(chunk.data.clone(), language)
            .await
            .map(|result| result.text)
            .map_err(|error| error.to_string()),
    }
}
