use crate::api::TranscriptSegment;
use anyhow::Result;
use log::info;
use once_cell::sync::Lazy;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use uuid::Uuid;

static ENGINE_LIFECYCLE_LOCK: Lazy<Arc<AsyncMutex<()>>> =
    Lazy::new(|| Arc::new(AsyncMutex::new(())));

pub(crate) async fn acquire_engine_lifecycle_lock() -> OwnedMutexGuard<()> {
    ENGINE_LIFECYCLE_LOCK.clone().lock_owned().await
}

/// Transcribe 16 kHz mono samples with Apple Speech (offline preset).
/// The samples go through a private temporary WAV that is removed when this returns.
/// `progress` receives the fraction of audio covered so far (0.0-1.0).
pub(crate) async fn transcribe_16k_with_apple(
    samples: Vec<f32>,
    locale: &str,
    mut progress: impl FnMut(f64),
    cancelled: impl Fn() -> bool,
) -> Result<Vec<(String, f64, f64)>> {
    let duration = samples.len() as f64 / 16_000.0;
    let wav = tokio::task::spawn_blocking(move || -> Result<tempfile::NamedTempFile> {
        let file = tempfile::Builder::new().prefix("meetodds-asr-").suffix(".wav").tempfile()?;
        write_wav_16k_mono(file.path(), &samples)?;
        Ok(file)
    })
    .await
    .map_err(|e| anyhow::anyhow!("Audio preparation task failed: {}", e))??;
    let segments = crate::apple_speech::transcribe_file(
        wav.path(),
        locale,
        |reached| progress(if duration > 0.0 { (reached / duration).clamp(0.0, 1.0) } else { 1.0 }),
        cancelled,
    )
    .await
    .map_err(|e| anyhow::anyhow!(e))?;
    Ok(segments)
}

/// Spoken-language locale for file transcription: the explicit choice, else the configured one.
pub(crate) async fn resolve_transcription_locale<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    requested: Option<String>,
) -> Result<String> {
    use tauri::Manager;
    if let Some(locale) = requested.filter(|l| !l.trim().is_empty() && l != "auto") {
        return Ok(locale);
    }
    let config = crate::api::api::api_get_transcript_config(app.clone(), app.state(), None)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(config.map(|c| c.model).unwrap_or_else(|| "en_US".to_string()))
}

/// Minimal 16-bit PCM mono WAV writer (16 kHz) for handing audio to Apple Speech.
pub(crate) fn write_wav_16k_mono(path: &Path, samples: &[f32]) -> Result<()> {
    use std::io::Write;
    let data_len = (samples.len() * 2) as u32;
    let mut out = std::io::BufWriter::new(std::fs::File::create(path)?);
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + data_len).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16u32.to_le_bytes())?; // fmt chunk size
    out.write_all(&1u16.to_le_bytes())?; // PCM
    out.write_all(&1u16.to_le_bytes())?; // mono
    out.write_all(&16_000u32.to_le_bytes())?;
    out.write_all(&32_000u32.to_le_bytes())?; // byte rate
    out.write_all(&2u16.to_le_bytes())?; // block align
    out.write_all(&16u16.to_le_bytes())?; // bits per sample
    out.write_all(b"data")?;
    out.write_all(&data_len.to_le_bytes())?;
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.write_all(&value.to_le_bytes())?;
    }
    out.flush()?;
    Ok(())
}

/// Create transcript segments from transcription results.
/// Each tuple is (text, start_ms, end_ms) from VAD timestamps.
pub(crate) fn create_transcript_segments(
    transcripts: &[(String, f64, f64)],
) -> Vec<TranscriptSegment> {
    transcripts
        .iter()
        .map(|(text, start_ms, end_ms)| {
            let start_seconds = start_ms / 1000.0;
            let end_seconds = end_ms / 1000.0;
            let duration = end_seconds - start_seconds;

            TranscriptSegment {
                id: format!("transcript-{}", Uuid::new_v4()),
                text: text.trim().to_string(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                audio_start_time: Some(start_seconds),
                audio_end_time: Some(end_seconds),
                duration: Some(duration),
                speaker: None,
                speaker_label: None,
                speaker_source: None,
                speaker_confidence: None,
            }
        })
        .collect()
}

/// Write transcripts.json to a meeting folder (atomic write with temp file)
pub(crate) fn write_transcripts_json(folder: &Path, segments: &[TranscriptSegment]) -> Result<()> {
    let transcript_path = folder.join("transcripts.json");
    let temp_path = folder.join(".transcripts.json.tmp");

    let json = serde_json::json!({
        "version": "1.0",
        "last_updated": chrono::Utc::now().to_rfc3339(),
        "total_segments": segments.len(),
        "segments": segments.iter().enumerate().map(|(i, s)| {
            serde_json::json!({
                "id": s.id,
                "text": s.text,
                "timestamp": s.timestamp,
                "audio_start_time": s.audio_start_time,
                "audio_end_time": s.audio_end_time,
                "duration": s.duration,
                "speaker": s.speaker,
                "speaker_label": s.speaker_label,
                "speaker_source": s.speaker_source,
                "speaker_confidence": s.speaker_confidence,
                "sequence_id": i
            })
        }).collect::<Vec<_>>()
    });

    let json_string = serde_json::to_string_pretty(&json)?;
    std::fs::write(&temp_path, &json_string)?;
    std::fs::rename(&temp_path, &transcript_path)?;

    info!(
        "Wrote transcripts.json with {} segments to {}",
        segments.len(),
        transcript_path.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_engine_lifecycle_lock_serializes_acquirers() {
        let guard = acquire_engine_lifecycle_lock().await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (acquired_tx, mut acquired_rx) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(async {
            started_tx.send(()).unwrap();
            let _guard = acquire_engine_lifecycle_lock().await;
            acquired_tx.send(()).unwrap();
        });

        started_rx.await.unwrap();
        assert!(acquired_rx.try_recv().is_err());
        drop(guard);

        acquired_rx.await.unwrap();
        waiter.await.unwrap();
    }

    #[test]
    fn wav_writer_round_trips_through_decoder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.wav");
        let samples: Vec<f32> = (0..16_000).map(|i| ((i as f32) / 50.0).sin() * 0.5).collect();
        write_wav_16k_mono(&path, &samples).unwrap();
        let decoded = crate::audio::decoder::decode_audio_file(&path).unwrap();
        assert_eq!(decoded.sample_rate, 16_000);
        assert_eq!(decoded.channels, 1);
        assert_eq!(decoded.samples.len(), samples.len());
        assert!((decoded.samples[100] - samples[100]).abs() < 1e-3);
    }
}
