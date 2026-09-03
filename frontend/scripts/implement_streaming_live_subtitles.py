from __future__ import annotations

import argparse
import re
from pathlib import Path
from textwrap import dedent


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old in text:
        return text.replace(old, new, 1)
    if new in text:
        return text
    raise SystemExit(f"Missing anchor for {label}: {old[:180]!r}")


def replace_n(text: str, old: str, new: str, count: int, label: str) -> str:
    present = text.count(old)
    if present >= count:
        return text.replace(old, new, count)
    if text.count(new) >= count:
        return text
    raise SystemExit(f"Expected {count} anchors for {label}, found {present}")


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count == 1:
        return updated
    if replacement in text:
        return text
    raise SystemExit(f"Missing regex anchor for {label}: {pattern[:180]!r}")


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def backend() -> None:
    # ------------------------------------------------------------------
    # VAD: non-destructive snapshots of the speech that is still active.
    # ------------------------------------------------------------------
    path = Path("frontend/src-tauri/src/audio/vad.rs")
    text = path.read_text()
    anchor = "    /// Flush any remaining audio and return final speech segments\n"
    method = dedent('''
        /// Return a non-destructive rolling snapshot of speech that is still in progress.
        ///
        /// This is deliberately separate from `speech_segments`: callers may use it for
        /// speculative subtitle decoding, but the canonical VAD state and sentence
        /// boundary remain untouched. The returned window is capped so preview ASR has
        /// predictable latency even during a long uninterrupted monologue.
        pub fn live_speech_snapshot(
            &self,
            min_duration_ms: u32,
            max_duration_ms: u32,
        ) -> Option<SpeechSegment> {
            const VAD_SAMPLE_RATE: usize = 16_000;

            if !self.in_speech || self.current_speech.is_empty() {
                return None;
            }

            let min_samples = VAD_SAMPLE_RATE * min_duration_ms as usize / 1000;
            if self.current_speech.len() < min_samples {
                return None;
            }

            let max_samples = (VAD_SAMPLE_RATE * max_duration_ms as usize / 1000)
                .max(min_samples);
            let start_offset = self.current_speech.len().saturating_sub(max_samples);
            let samples = self.current_speech[start_offset..].to_vec();
            let end_timestamp_ms = self.processed_samples as f64 / VAD_SAMPLE_RATE as f64 * 1000.0;
            let duration_ms = samples.len() as f64 / VAD_SAMPLE_RATE as f64 * 1000.0;

            Some(SpeechSegment {
                samples,
                start_timestamp_ms: (end_timestamp_ms - duration_ms).max(0.0),
                end_timestamp_ms,
                confidence: 0.75,
            })
        }

    ''')
    if "pub fn live_speech_snapshot(" not in text:
        if anchor not in text:
            raise SystemExit("VAD live snapshot insertion anchor missing")
        text = text.replace(anchor, method + anchor, 1)
    path.write_text(text)

    # ------------------------------------------------------------------
    # Pipeline: publish newest rolling snapshot through watch channel.
    # ------------------------------------------------------------------
    path = Path("frontend/src-tauri/src/audio/pipeline.rs")
    text = path.read_text()
    text = replace_once(
        text,
        "use tokio::sync::mpsc;",
        "use tokio::sync::{mpsc, watch};",
        "pipeline watch import",
    )
    text = replace_once(
        text,
        "/// VAD-driven audio processing pipeline\n/// Uses Voice Activity Detection to segment speech in real-time and send only speech to Whisper\npub struct AudioPipeline {",
        dedent('''
        const LIVE_PREVIEW_INTERVAL: std::time::Duration = std::time::Duration::from_millis(450);
        const LIVE_PREVIEW_MIN_SPEECH_MS: u32 = 700;
        const LIVE_PREVIEW_MAX_WINDOW_MS: u32 = 2_800;

        /// VAD-driven audio processing pipeline
        /// Uses Voice Activity Detection to segment canonical speech while also exposing
        /// disposable rolling snapshots for the subtitle preview lane.
        pub struct AudioPipeline {'''),
        "preview pipeline constants",
    )
    text = replace_once(
        text,
        "    // Recording sender for pre-mixed audio\n    recording_sender_for_mixed: Option<mpsc::UnboundedSender<AudioChunk>>,\n}",
        dedent('''
            // Recording sender for pre-mixed audio
            recording_sender_for_mixed: Option<mpsc::UnboundedSender<AudioChunk>>,
            // Latest-only speculative subtitle lane. `watch` intentionally drops old snapshots.
            live_preview_sender: Option<watch::Sender<Option<AudioChunk>>>,
            mic_live_preview_last_emit: Option<std::time::Instant>,
            system_live_preview_last_emit: Option<std::time::Instant>,
            live_preview_revision: u64,
        }'''),
        "pipeline preview fields",
    )
    text = replace_once(
        text,
        "            mixer,\n            recording_sender_for_mixed: None, // Will be set by manager\n        }",
        dedent('''
                    mixer,
                    recording_sender_for_mixed: None, // Will be set by manager
                    live_preview_sender: None,
                    mic_live_preview_last_emit: None,
                    system_live_preview_last_emit: None,
                    live_preview_revision: 0,
                }'''),
        "pipeline preview initialization",
    )

    old_process = dedent('''
        fn process_source_audio(&mut self, device_type: DeviceType, samples: &[f32]) -> Result<()> {
            let segments = match &device_type {
                DeviceType::Microphone => self.mic_vad_processor.process_audio(samples)?,
                DeviceType::System => self.system_vad_processor.process_audio(samples)?,
            };
            self.send_speech_segments(device_type, segments);
            Ok(())
        }
    ''')
    new_process = dedent('''
        fn process_source_audio(&mut self, device_type: DeviceType, samples: &[f32]) -> Result<()> {
            let preview_due = self.live_preview_due(&device_type);
            let (segments, live_snapshot) = match &device_type {
                DeviceType::Microphone => {
                    let segments = self.mic_vad_processor.process_audio(samples)?;
                    let preview = if preview_due {
                        self.mic_vad_processor.live_speech_snapshot(
                            LIVE_PREVIEW_MIN_SPEECH_MS,
                            LIVE_PREVIEW_MAX_WINDOW_MS,
                        )
                    } else {
                        None
                    };
                    (segments, preview)
                }
                DeviceType::System => {
                    let segments = self.system_vad_processor.process_audio(samples)?;
                    let preview = if preview_due {
                        self.system_vad_processor.live_speech_snapshot(
                            LIVE_PREVIEW_MIN_SPEECH_MS,
                            LIVE_PREVIEW_MAX_WINDOW_MS,
                        )
                    } else {
                        None
                    };
                    (segments, preview)
                }
            };

            self.send_speech_segments(device_type.clone(), segments);
            if let Some(snapshot) = live_snapshot {
                self.send_live_preview_snapshot(device_type, snapshot);
            }
            Ok(())
        }

        fn live_preview_due(&self, device_type: &DeviceType) -> bool {
            if self.live_preview_sender.is_none() {
                return false;
            }
            let last = match device_type {
                DeviceType::Microphone => self.mic_live_preview_last_emit,
                DeviceType::System => self.system_live_preview_last_emit,
            };
            last.map_or(true, |instant| instant.elapsed() >= LIVE_PREVIEW_INTERVAL)
        }

        fn send_live_preview_snapshot(&mut self, device_type: DeviceType, snapshot: SpeechSegment) {
            let Some(sender) = self.live_preview_sender.as_ref().cloned() else {
                return;
            };

            self.live_preview_revision = self.live_preview_revision.wrapping_add(1);
            let preview_chunk = AudioChunk {
                data: snapshot.samples,
                sample_rate: 16_000,
                timestamp: snapshot.start_timestamp_ms / 1000.0,
                chunk_id: self.live_preview_revision,
                device_type: device_type.clone(),
            };

            // `watch` retains exactly one value. If ASR is slower than capture, stale
            // snapshots disappear automatically instead of building subtitle backlog.
            if sender.send(Some(preview_chunk)).is_ok() {
                let now = std::time::Instant::now();
                match device_type {
                    DeviceType::Microphone => self.mic_live_preview_last_emit = Some(now),
                    DeviceType::System => self.system_live_preview_last_emit = Some(now),
                }
            }
        }
    ''')
    text = replace_once(text, old_process, new_process, "pipeline source preview")

    text = replace_once(
        text,
        "        transcription_sender: mpsc::UnboundedSender<AudioChunk>,\n        target_chunk_duration_ms: u32,",
        "        transcription_sender: mpsc::UnboundedSender<AudioChunk>,\n        live_preview_sender: Option<watch::Sender<Option<AudioChunk>>>,\n        target_chunk_duration_ms: u32,",
        "pipeline manager preview argument",
    )
    text = replace_once(
        text,
        "        // CRITICAL FIX: Connect recording sender to receive pre-mixed audio\n        // This ensures both mic AND system audio are captured in recordings\n        pipeline.recording_sender_for_mixed = recording_sender;",
        dedent('''
                // CRITICAL FIX: Connect recording sender to receive pre-mixed audio
                // This ensures both mic AND system audio are captured in recordings
                pipeline.recording_sender_for_mixed = recording_sender;
                pipeline.live_preview_sender = live_preview_sender;'''),
        "pipeline manager sender wiring",
    )
    path.write_text(text)

    # ------------------------------------------------------------------
    # Recording manager: create latest-only preview watch channel.
    # ------------------------------------------------------------------
    path = Path("frontend/src-tauri/src/audio/recording_manager.rs")
    text = path.read_text()
    text = replace_once(text, "use tokio::sync::mpsc;", "use tokio::sync::{mpsc, watch};", "recording manager watch")
    text = text.replace(
        "Result<mpsc::UnboundedReceiver<AudioChunk>>",
        "Result<(mpsc::UnboundedReceiver<AudioChunk>, watch::Receiver<Option<AudioChunk>>)>"
    )
    text = replace_once(
        text,
        "        let (transcription_sender, transcription_receiver) = mpsc::unbounded_channel::<AudioChunk>();",
        dedent('''
                let (transcription_sender, transcription_receiver) = mpsc::unbounded_channel::<AudioChunk>();
                // Preview captions are latest-only by design. A slow speculative decoder
                // must never delay or back up the canonical transcript queue.
                let (live_preview_sender, live_preview_receiver) =
                    watch::channel::<Option<AudioChunk>>(None);'''),
        "recording preview channel",
    )
    text = replace_once(
        text,
        "            transcription_sender,\n            0, // Ignored - using dynamic sizing internally",
        "            transcription_sender,\n            Some(live_preview_sender),\n            0, // Ignored - using dynamic sizing internally",
        "recording pipeline preview sender",
    )
    text = replace_once(
        text,
        "        Ok(transcription_receiver)",
        "        Ok((transcription_receiver, live_preview_receiver))",
        "recording receiver tuple",
    )
    path.write_text(text)

    # ------------------------------------------------------------------
    # Canonical worker: mark final decode busy and clear corresponding preview.
    # ------------------------------------------------------------------
    path = Path("frontend/src-tauri/src/audio/transcription/worker.rs")
    text = path.read_text()
    text = replace_once(text, "use log::{error, info, warn};", "use log::{debug, error, info, warn};", "worker debug import")
    text = replace_once(
        text,
        "static SPEECH_DETECTED_EMITTED: AtomicBool = AtomicBool::new(false);",
        dedent('''
        static SPEECH_DETECTED_EMITTED: AtomicBool = AtomicBool::new(false);
        static CANONICAL_TRANSCRIPTION_BUSY: AtomicBool = AtomicBool::new(false);

        pub(crate) fn canonical_transcription_busy() -> bool {
            CANONICAL_TRANSCRIPTION_BUSY.load(Ordering::Acquire)
        }

        struct CanonicalTranscriptionGuard;

        impl CanonicalTranscriptionGuard {
            fn new() -> Self {
                CANONICAL_TRANSCRIPTION_BUSY.store(true, Ordering::Release);
                Self
            }
        }

        impl Drop for CanonicalTranscriptionGuard {
            fn drop(&mut self) {
                CANONICAL_TRANSCRIPTION_BUSY.store(false, Ordering::Release);
            }
        }'''),
        "canonical busy guard",
    )
    old_call = dedent('''
                                // Transcribe with provider-agnostic approach
                                match transcribe_chunk_with_provider(&engine_clone, chunk, &app_clone)
                                    .await
                                {
    ''')
    new_call = dedent('''
                                // Canonical sentence decoding always has priority over speculative
                                // subtitles. The preview worker observes this flag and yields.
                                let preview_source = match &chunk.device_type {
                                    crate::audio::recording_state::DeviceType::Microphone => "microphone",
                                    crate::audio::recording_state::DeviceType::System => "system",
                                };
                                let transcription_result = {
                                    let _canonical_guard = CanonicalTranscriptionGuard::new();
                                    transcribe_chunk_with_provider(&engine_clone, chunk, &app_clone).await
                                };
                                let _ = app_clone.emit(
                                    "live-transcript-preview-clear",
                                    serde_json::json!({ "source": preview_source }),
                                );

                                match transcription_result {
    ''')
    text = replace_once(text, old_call, new_call, "canonical priority wrapping")

    # Reduce per-segment hot-path logging. Useful diagnostics remain available at debug level.
    for old, new in [
        ('info!("🔍 Worker {} transcription result:', 'debug!("🔍 Worker {} transcription result:'),
        ('info!("✅ Worker {} transcribed:', 'debug!("✅ Worker {} transcribed:'),
        ('info!("🔍 Checking speech-detected flag:', 'debug!("🔍 Checking speech-detected flag:'),
        ('info!("🔍 Speech already detected in this session, not re-emitting");', 'debug!("🔍 Speech already detected in this session, not re-emitting");'),
        ('info!(\n        "Processing speech audio chunk {} with {} samples (energy: {:.6})",', 'debug!(\n        "Processing speech audio chunk {} with {} samples (energy: {:.6})",'),
        ('info!(\n                        "Whisper transcription complete for chunk {}:', 'debug!(\n                        "Whisper transcription complete for chunk {}:'),
        ('info!(\n                        "Parakeet transcription complete for chunk {}:', 'debug!(\n                        "Parakeet transcription complete for chunk {}:'),
        ('info!(\n                        "{} transcription complete for chunk {}:', 'debug!(\n                        "{} transcription complete for chunk {}:'),
    ]:
        if old in text:
            text = text.replace(old, new)
    path.write_text(text)

    # ------------------------------------------------------------------
    # Whisper preview decode: greedy, short, low-thread speculative inference.
    # ------------------------------------------------------------------
    path = Path("frontend/src-tauri/src/whisper_engine/whisper_engine.rs")
    text = path.read_text()
    anchor = "    /// Transcribe audio with streaming support for partial results and adaptive quality\n"
    method = dedent('''
        /// Fast speculative decode for the subtitle lane.
        ///
        /// This never feeds persistence. It intentionally trades some stability for a low
        /// time-to-caption: greedy search, a short rolling audio window, single segment,
        /// and at most two decoder threads. The normal beam-search method remains the only
        /// source for the saved transcript.
        pub async fn transcribe_audio_preview(
            &self,
            audio_data: Vec<f32>,
            language: Option<String>,
        ) -> Result<String> {
            if audio_data.len() < 8_000 {
                return Ok(String::new());
            }

            let ctx_lock = self.current_context.read().await;
            let ctx = ctx_lock
                .as_ref()
                .ok_or_else(|| anyhow!("No model loaded. Please load a model first."))?;

            let hardware_profile = crate::audio::HardwareProfile::detect();
            let adaptive_config = hardware_profile.get_whisper_config();
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

            let (language_code, should_translate) = match language.as_deref() {
                Some("auto") | None => (None, false),
                Some("auto-translate") => (None, true),
                Some(lang) => (Some(lang), false),
            };
            params.set_language(language_code);
            params.set_translate(should_translate);
            params.set_no_timestamps(true);
            params.set_print_special(false);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            params.set_suppress_blank(true);
            params.set_suppress_non_speech_tokens(true);
            params.set_temperature(0.0);
            params.set_no_speech_thold(0.45);
            params.set_max_len(96);
            params.set_single_segment(true);
            params.set_n_threads(adaptive_config.max_threads.unwrap_or(2).clamp(1, 2) as i32);

            let mut state = ctx.create_state()?;
            state.full(params, &audio_data)?;
            let num_segments = state.full_n_segments()?;
            let mut result = String::new();
            for index in 0..num_segments {
                let Ok(segment) = state.full_get_segment_text_lossy(index) else {
                    continue;
                };
                let cleaned = segment.trim();
                if cleaned.is_empty() {
                    continue;
                }
                if !result.is_empty() {
                    result.push(' ');
                }
                result.push_str(cleaned);
            }

            Ok(Self::clean_repetitive_text(result.trim()))
        }

    ''')
    if "pub async fn transcribe_audio_preview(" not in text:
        if anchor not in text:
            raise SystemExit("Whisper preview insertion anchor missing")
        text = text.replace(anchor, method + anchor, 1)
    path.write_text(text)

    # ------------------------------------------------------------------
    # New latest-only preview transcription task.
    # ------------------------------------------------------------------
    live_preview = dedent('''
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
                let mut last_emitted: HashMap<String, String> = HashMap::new();

                while receiver.changed().await.is_ok() {
                    let Some(chunk) = ({ receiver.borrow_and_update().clone() }) else {
                        continue;
                    };

                    // Never start speculative work while the canonical sentence decoder is active.
                    if canonical_transcription_busy() {
                        continue;
                    }

                    let revision = chunk.chunk_id;
                    let source = match chunk.device_type {
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

                    if last_emitted.get(source).is_some_and(|previous| previous == &text) {
                        continue;
                    }
                    last_emitted.insert(source.to_string(), text.clone());

                    let (speaker, speaker_label) = match (&chunk.device_type, channel_separated) {
                        (DeviceType::Microphone, true) => ("me", "Me"),
                        (DeviceType::System, _) => ("remote-live", "Other"),
                        (DeviceType::Microphone, false) => ("room-live", "Live"),
                    };
                    let duration = chunk.data.len() as f64 / chunk.sample_rate as f64;
                    let update = LiveTranscriptPreviewUpdate {
                        text,
                        source: source.to_string(),
                        speaker: speaker.to_string(),
                        speaker_label: speaker_label.to_string(),
                        revision,
                        audio_start_time: chunk.timestamp,
                        audio_end_time: chunk.timestamp + duration,
                        latency_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    };
                    let _ = app.emit("live-transcript-preview", update);
                }
            })
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
    ''').lstrip()
    Path("frontend/src-tauri/src/audio/transcription/live_preview.rs").write_text(live_preview)

    path = Path("frontend/src-tauri/src/audio/transcription/mod.rs")
    text = path.read_text()
    text = replace_once(text, "pub mod engine;", "pub mod engine;\npub mod live_preview;", "preview module registration")
    text = replace_once(
        text,
        "pub use parakeet_provider::ParakeetProvider;",
        "pub use live_preview::{start_live_preview_task, LiveTranscriptPreviewUpdate};\npub use parakeet_provider::ParakeetProvider;",
        "preview module reexport",
    )
    path.write_text(text)

    # ------------------------------------------------------------------
    # Recording command lifecycle: start/abort disposable preview worker.
    # ------------------------------------------------------------------
    path = Path("frontend/src-tauri/src/audio/recording_commands.rs")
    text = path.read_text()
    text = replace_once(
        text,
        "static TRANSCRIPTION_TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);",
        "static TRANSCRIPTION_TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);\nstatic LIVE_PREVIEW_TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);",
        "preview task global",
    )
    text = replace_n(
        text,
        "let transcription_receiver = manager\n        .start_recording(",
        "let (transcription_receiver, live_preview_receiver) = manager\n        .start_recording(",
        2,
        "recording receiver destructure",
    )
    task_block = dedent('''
        {
            let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
            *global_task = Some(task_handle);
        }

        // CRITICAL: Listen for transcript-update events and save to recording manager
    ''')
    task_block_new = dedent('''
        {
            let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
            *global_task = Some(task_handle);
        }

        // The subtitle preview task is disposable and latest-only. It never writes to
        // transcript history and is aborted before canonical shutdown processing.
        let preview_task = transcription::start_live_preview_task(
            app.clone(),
            live_preview_receiver,
            has_separate_system_audio,
        );
        {
            let mut global_preview_task = LIVE_PREVIEW_TASK.lock().unwrap();
            *global_preview_task = Some(preview_task);
        }

        // CRITICAL: Listen for transcript-update events and save to recording manager
    ''')
    text = replace_n(text, task_block, task_block_new, 2, "preview task startup")

    stop_anchor = dedent('''
        // Step 2: Signal transcription workers to finish processing ALL queued chunks
        let _ = app.emit(
    ''')
    stop_insert = dedent('''
        // Speculative subtitles are disposable; stop them before canonical shutdown so
        // the ASR model is fully available to the final transcript queue.
        if let Some(preview_task) = LIVE_PREVIEW_TASK.lock().unwrap().take() {
            preview_task.abort();
        }
        let _ = app.emit(
            "live-transcript-preview-clear",
            serde_json::json!({ "source": null }),
        );

        // Step 2: Signal transcription workers to finish processing ALL queued chunks
        let _ = app.emit(
    ''')
    text = replace_once(text, stop_anchor, stop_insert, "preview shutdown")
    path.write_text(text)

    print("Backend subtitle lane implemented")


def frontend() -> None:
    # ------------------------------------------------------------------
    # Shared type.
    # ------------------------------------------------------------------
    path = Path("frontend/src/types/index.ts")
    text = path.read_text()
    anchor = "export interface Block {\n"
    live_type = dedent('''
        export interface LiveTranscriptPreview {
          text: string;
          source: 'microphone' | 'system';
          speaker: string;
          speakerLabel: string;
          revision: number;
          audioStartTime: number;
          audioEndTime: number;
          latencyMs: number;
        }

    ''')
    if "export interface LiveTranscriptPreview" not in text:
        if anchor not in text:
            raise SystemExit("LiveTranscriptPreview type anchor missing")
        text = text.replace(anchor, live_type + anchor, 1)
    path.write_text(text)

    # ------------------------------------------------------------------
    # Transcript context listens to ephemeral event without touching persistence.
    # ------------------------------------------------------------------
    path = Path("frontend/src/contexts/TranscriptContext.tsx")
    text = path.read_text()
    text = replace_once(
        text,
        "import { Transcript, TranscriptUpdate } from '@/types';",
        "import { LiveTranscriptPreview, Transcript, TranscriptUpdate } from '@/types';\nimport { listen } from '@tauri-apps/api/event';",
        "transcript preview imports",
    )
    text = replace_once(
        text,
        "  transcripts: Transcript[];\n  transcriptsRef: MutableRefObject<Transcript[]>",
        "  transcripts: Transcript[];\n  livePreview: LiveTranscriptPreview | null;\n  transcriptsRef: MutableRefObject<Transcript[]>",
        "transcript context preview field",
    )
    text = replace_once(
        text,
        "  const [transcripts, setTranscripts] = useState<Transcript[]>([]);",
        "  const [transcripts, setTranscripts] = useState<Transcript[]>([]);\n  const [livePreview, setLivePreview] = useState<LiveTranscriptPreview | null>(null);",
        "transcript preview state",
    )

    preview_effect_anchor = "  // Smart auto-scroll: Track user scroll position\n"
    preview_effect = dedent('''
        // Ephemeral subtitle stream. These events never enter IndexedDB/SQLite and are
        // replaced by the canonical transcript once VAD closes the sentence.
        useEffect(() => {
          let unlistenPreview: (() => void) | undefined;
          let unlistenClear: (() => void) | undefined;
          let disposed = false;

          void listen<LiveTranscriptPreview>('live-transcript-preview', (event) => {
            setLivePreview(event.payload);
          }).then((dispose) => {
            if (disposed) dispose();
            else unlistenPreview = dispose;
          });

          void listen<{ source?: 'microphone' | 'system' | null }>(
            'live-transcript-preview-clear',
            (event) => {
              setLivePreview((current) => {
                const source = event.payload?.source;
                if (!source || current?.source === source) return null;
                return current;
              });
            }
          ).then((dispose) => {
            if (disposed) dispose();
            else unlistenClear = dispose;
          });

          return () => {
            disposed = true;
            unlistenPreview?.();
            unlistenClear?.();
          };
        }, []);

    ''')
    if "live-transcript-preview'" not in text:
        if preview_effect_anchor not in text:
            raise SystemExit("preview listener effect anchor missing")
        text = text.replace(preview_effect_anchor, preview_effect + preview_effect_anchor, 1)

    # Remove the artificial 150ms UI delay for canonical transcript scrolling.
    scroll_pattern = r"  // Auto-scroll when transcripts change \(only if user is at bottom\).*?\n  // Initialize IndexedDB"
    scroll_replacement = dedent('''
        // Auto-scroll without adding another 150ms of perceived transcript latency.
        useEffect(() => {
          if (!isUserAtBottomRef.current || !transcriptContainerRef.current) return;
          const frame = requestAnimationFrame(() => {
            const container = transcriptContainerRef.current;
            if (!container) return;
            container.scrollTo({
              top: container.scrollHeight,
              behavior: recordingState.isRecording ? 'auto' : 'smooth',
            });
          });
          return () => cancelAnimationFrame(frame);
        }, [transcripts, recordingState.isRecording]);

        // Initialize IndexedDB''')
    text = regex_once(text, scroll_pattern, scroll_replacement, "transcript auto-scroll latency")

    # Clear preview on lifecycle boundaries.
    text = replace_once(
        text,
        "        unlistenRecordingStarted = await recordingService.onRecordingStarted(async () => {\n          try {",
        "        unlistenRecordingStarted = await recordingService.onRecordingStarted(async () => {\n          setLivePreview(null);\n          try {",
        "preview clear recording start",
    )
    text = replace_once(
        text,
        "        unlistenRecordingStopped = await recordingService.onRecordingStopped(async (payload) => {\n          try {",
        "        unlistenRecordingStopped = await recordingService.onRecordingStopped(async (payload) => {\n          setLivePreview(null);\n          try {",
        "preview clear recording stop",
    )

    # Serial canonical worker means the 10ms timer is unnecessary.
    text = text.replace("    let processingTimer: NodeJS.Timeout | undefined;\n", "")
    old_timer = dedent('''
              // Clear any existing timer and set a new one
              if (processingTimer) {
                clearTimeout(processingTimer);
              }

              // Process buffer with minimal delay for immediate UI updates (serial workers = sequential order)
              processingTimer = setTimeout(processBufferedTranscripts, 10);
    ''')
    new_timer = dedent('''
              // Serial backend emission is already ordered; yield only to the current JS
              // task, then render the finalized sentence immediately.
              queueMicrotask(() => processBufferedTranscripts());
    ''')
    text = replace_once(text, old_timer, new_timer, "canonical frontend buffer latency")
    cleanup_timer = dedent('''
              if (processingTimer) {
                clearTimeout(processingTimer);
                console.log('🧹 CLEANUP: Cleared processing timer');
              }
    ''')
    text = text.replace(cleanup_timer, "")

    text = replace_once(
        text,
        "  const clearTranscripts = useCallback(() => {\n    setTranscripts([]);",
        "  const clearTranscripts = useCallback(() => {\n    setTranscripts([]);\n    setLivePreview(null);",
        "clear preview with transcripts",
    )
    text = replace_once(
        text,
        "  const value: TranscriptContextType = {\n    transcripts,",
        "  const value: TranscriptContextType = {\n    transcripts,\n    livePreview,",
        "context value live preview",
    )
    path.write_text(text)

    # ------------------------------------------------------------------
    # Subtitle-style visual surface.
    # ------------------------------------------------------------------
    component = dedent('''
        'use client';

        import { LiveTranscriptPreview } from '@/types';
        import { LiveTranslationEntry, TranslationDisplayMode } from '@/lib/live-translation';

        interface LiveTranscriptSubtitleProps {
          preview: LiveTranscriptPreview | null;
          translation?: LiveTranslationEntry;
          translationEnabled: boolean;
          translationDisplayMode: TranslationDisplayMode;
          translationTargetLanguage?: string;
          isPaused?: boolean;
        }

        export function LiveTranscriptSubtitle({
          preview,
          translation,
          translationEnabled,
          translationDisplayMode,
          translationTargetLanguage,
          isPaused = false,
        }: LiveTranscriptSubtitleProps) {
          if (!preview || isPaused) return null;

          const translated = translation?.translatedText?.trim();
          const showOriginal = !translationEnabled
            || translationDisplayMode === 'bilingual'
            || !translated;

          return (
            <div className="pointer-events-none sticky bottom-4 z-30 flex justify-center px-4 pb-4">
              <div
                className="w-fit max-w-[860px] rounded-2xl border border-white/10 bg-black/85 px-5 py-3 text-white shadow-2xl backdrop-blur-md"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-white/55">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
                  <span>{preview.speakerLabel}</span>
                  <span>Live</span>
                  <span className="normal-case tracking-normal text-white/35">
                    {preview.latencyMs < 1000 ? `${preview.latencyMs} ms` : `${(preview.latencyMs / 1000).toFixed(1)} s`}
                  </span>
                </div>

                {showOriginal && (
                  <p className="line-clamp-2 text-lg font-medium leading-snug md:text-xl">
                    {preview.text}
                    <span className="ml-0.5 animate-pulse text-white/45">▍</span>
                  </p>
                )}

                {translationEnabled && translated && (
                  <p
                    lang={translationTargetLanguage}
                    dir="auto"
                    className={`${showOriginal ? 'mt-2 border-t border-white/10 pt-2' : ''} line-clamp-2 text-lg font-semibold leading-snug md:text-xl`}
                  >
                    {translated}
                    {translation?.status === 'translating' && (
                      <span className="ml-0.5 animate-pulse text-white/45">▍</span>
                    )}
                  </p>
                )}

                {translationEnabled && !translated && (
                  <div className="mt-1 text-xs text-white/40">Translating live caption…</div>
                )}
              </div>
            </div>
          );
        }
    ''').lstrip()
    Path("frontend/src/components/LiveTranscriptSubtitle.tsx").write_text(component)

    # ------------------------------------------------------------------
    # Translation hook: consume the same preview stream, latest-after-current.
    # ------------------------------------------------------------------
    path = Path("frontend/src/hooks/useLiveTranslation.ts")
    text = path.read_text()
    text = replace_once(
        text,
        "import { Transcript } from '@/types';",
        "import { LiveTranscriptPreview, Transcript } from '@/types';",
        "translation preview type import",
    )
    text = replace_once(
        text,
        "  lastFallbackReason: string | null;\n}",
        "  lastFallbackReason: string | null;\n  previewTranslation?: LiveTranslationEntry;\n}",
        "translation state preview result",
    )
    text = replace_once(
        text,
        "export function useLiveTranslation(transcripts: Transcript[]): LiveTranslationState {",
        "export function useLiveTranslation(\n  transcripts: Transcript[],\n  livePreview: LiveTranscriptPreview | null = null\n): LiveTranslationState {",
        "translation hook preview signature",
    )
    text = replace_once(
        text,
        "  const drainQueueRef = useRef<() => void>(() => undefined);",
        dedent('''
          const drainQueueRef = useRef<() => void>(() => undefined);
          const previewInFlightRef = useRef<TranslationJob | null>(null);
          const pendingPreviewRef = useRef<TranslationJob | null>(null);
          const runPreviewTranslationRef = useRef<() => void>(() => undefined);'''),
        "translation preview refs",
    )

    # Extend clearPendingWork to cancel preview-specific refs too.
    text = replace_once(
        text,
        "    activeJobsRef.current.clear();\n    latestRevisionRef.current.clear();",
        "    activeJobsRef.current.clear();\n    previewInFlightRef.current = null;\n    pendingPreviewRef.current = null;\n    latestRevisionRef.current.clear();",
        "translation preview clear",
    )

    runner_anchor = "  useEffect(() => {\n    let disposed = false;\n"
    runner = dedent('''
        const runPreviewTranslation = useCallback(() => {
          if (previewInFlightRef.current || !pendingPreviewRef.current) return;
          const job = pendingPreviewRef.current;
          pendingPreviewRef.current = null;
          if (!mountedRef.current || job.generation !== generationRef.current) return;

          latestRevisionRef.current.set(job.segmentKey, job.revision);
          previewInFlightRef.current = job;
          activeRequestIdsRef.current.set(job.segmentKey, job.requestId);
          activeJobsRef.current.set(job.requestId, job);
          setTranslations((previous) => ({
            ...previous,
            [job.segmentKey]: {
              segmentKey: job.segmentKey,
              sourceText: job.text,
              targetLanguage: job.targetLanguage,
              status: 'translating',
            },
          }));

          void (async () => {
            try {
              const key = cacheKey(job);
              const cached = resultCacheRef.current.get(key);
              const response = cached ?? await invoke<LiveTranslationResponse>('api_translate_live_text', {
                requestId: job.requestId,
                text: job.text,
                sourceLanguage: job.sourceLanguage,
                targetLanguage: job.targetLanguage,
                translationEngine: job.translationEngine,
                speedMode: job.speedMode,
                modelOverride: job.modelOverride || null,
                contextText: job.contextText || null,
                glossary: job.glossary || null,
                contextHint: job.contextHint || null,
              });
              if (!cached) {
                resultCacheRef.current.set(key, response);
                trimCache(resultCacheRef.current);
              }
              if (!isCurrentJob(job)) return;
              setTranslations((previous) => ({
                ...previous,
                [job.segmentKey]: {
                  segmentKey: job.segmentKey,
                  sourceText: job.text,
                  translatedText: response.translatedText,
                  targetLanguage: response.targetLanguage,
                  status: 'translated',
                  provider: response.provider,
                  model: response.model,
                  latencyMs: cached ? 0 : response.latencyMs,
                  firstWordLatencyMs: cached ? 0 : response.firstWordLatencyMs,
                  fallbackReason: response.fallbackReason ?? undefined,
                  cached: response.cached || Boolean(cached),
                },
              }));
            } catch (error) {
              if (!isCurrentJob(job)) return;
              const message = error instanceof Error ? error.message : String(error);
              if (!/cancelled/i.test(message)) {
                setTranslations((previous) => ({
                  ...previous,
                  [job.segmentKey]: {
                    ...(previous[job.segmentKey] ?? {}),
                    segmentKey: job.segmentKey,
                    sourceText: job.text,
                    targetLanguage: job.targetLanguage,
                    status: 'error',
                    error: message,
                  },
                }));
              }
            } finally {
              activeJobsRef.current.delete(job.requestId);
              if (activeRequestIdsRef.current.get(job.segmentKey) === job.requestId) {
                activeRequestIdsRef.current.delete(job.segmentKey);
              }
              if (previewInFlightRef.current?.requestId === job.requestId) {
                previewInFlightRef.current = null;
              }
              if (pendingPreviewRef.current) {
                queueMicrotask(() => runPreviewTranslationRef.current());
              }
            }
          })();
        }, [isCurrentJob]);

        runPreviewTranslationRef.current = runPreviewTranslation;

    ''')
    if "const runPreviewTranslation = useCallback" not in text:
        if runner_anchor not in text:
            raise SystemExit("preview translation runner anchor missing")
        text = text.replace(runner_anchor, runner + runner_anchor, 1)

    # Add preview scheduling before canonical transcript scheduling effect.
    canonical_effect_anchor = "  useEffect(() => {\n    if (!settings.enabled || transcripts.length === 0) return;\n"
    preview_effect = dedent('''
        useEffect(() => {
          const previewKey = livePreview ? `live-preview-${livePreview.source}` : null;
          if (!settings.enabled || !livePreview || !livePreview.text.trim()) {
            pendingPreviewRef.current = null;
            const inFlight = previewInFlightRef.current;
            if (inFlight) {
              cancelNativeRequest(inFlight.requestId);
              latestRevisionRef.current.delete(inFlight.segmentKey);
            }
            if (previewKey) latestRevisionRef.current.delete(previewKey);
            setTranslations((previous) => {
              const keys = Object.keys(previous).filter((key) => key.startsWith('live-preview-'));
              if (keys.length === 0) return previous;
              const next = { ...previous };
              keys.forEach((key) => delete next[key]);
              return next;
            });
            return;
          }

          const contextText = settings.contextTurns === 0
            ? ''
            : transcripts
                .slice(-settings.contextTurns)
                .map((turn) => `${speakerLabel(turn)}: ${turn.text.trim()}`)
                .filter((line) => line.trim().length > 0)
                .join('\n');
          const segmentKey = `live-preview-${livePreview.source}`;
          pendingPreviewRef.current = {
            segmentKey,
            text: livePreview.text.trim(),
            revision: [
              generationRef.current,
              livePreview.revision,
              settings.targetLanguage,
              settings.engine,
              settings.speed,
              settings.modelOverride,
              contextText,
              settings.glossary,
              settings.contextHint,
            ].join('\u0001'),
            requestId: `live-preview-translation-${Date.now()}-${requestCounterRef.current++}`,
            sourceLanguage: 'auto',
            targetLanguage: settings.targetLanguage,
            generation: generationRef.current,
            translationEngine: settings.engine,
            speedMode: settings.speed,
            modelOverride: settings.modelOverride,
            contextText,
            glossary: settings.glossary,
            contextHint: settings.contextHint,
          };

          // Do not cancel a translation every 450ms as the ASR preview revises. Finish
          // the current short request, then immediately jump to the newest caption.
          if (!previewInFlightRef.current) {
            runPreviewTranslationRef.current();
          }
        }, [
          livePreview,
          transcripts,
          settings.enabled,
          settings.targetLanguage,
          settings.engine,
          settings.speed,
          settings.modelOverride,
          settings.contextTurns,
          settings.glossary,
          settings.contextHint,
          cancelNativeRequest,
        ]);

    ''')
    if "live-preview-translation-" not in text:
        if canonical_effect_anchor not in text:
            raise SystemExit("preview translation scheduling anchor missing")
        text = text.replace(canonical_effect_anchor, preview_effect + canonical_effect_anchor, 1)

    text = replace_once(
        text,
        "  const translatedCount = useMemo(\n    () => Object.values(translations).filter((entry) => entry.status === 'translated').length,\n    [translations]\n  );",
        dedent('''
          const translatedCount = useMemo(
            () => Object.entries(translations).filter(
              ([key, entry]) => !key.startsWith('live-preview-') && entry.status === 'translated'
            ).length,
            [translations]
          );
          const previewTranslation = livePreview
            ? translations[`live-preview-${livePreview.source}`]
            : undefined;'''),
        "preview translation result",
    )
    text = replace_once(
        text,
        "    lastFallbackReason,\n  };",
        "    lastFallbackReason,\n    previewTranslation,\n  };",
        "preview translation return",
    )
    path.write_text(text)

    # ------------------------------------------------------------------
    # Transcript panel renders sticky subtitle independent of translation toggle.
    # ------------------------------------------------------------------
    path = Path("frontend/src/app/_components/TranscriptPanel.tsx")
    text = path.read_text()
    text = replace_once(
        text,
        "import { LiveTranslationControl } from '@/components/LiveTranslationControl';",
        "import { LiveTranslationControl } from '@/components/LiveTranslationControl';\nimport { LiveTranscriptSubtitle } from '@/components/LiveTranscriptSubtitle';",
        "subtitle component import",
    )
    text = replace_once(
        text,
        "  const { transcripts, transcriptContainerRef, copyTranscript } = useTranscripts();",
        "  const { transcripts, livePreview, transcriptContainerRef, copyTranscript } = useTranscripts();",
        "subtitle context destructure",
    )
    text = replace_once(
        text,
        "  const liveTranslation = useLiveTranslation(transcripts);",
        "  const liveTranslation = useLiveTranslation(transcripts, livePreview);",
        "subtitle translation hook",
    )
    text = replace_once(
        text,
        "    <div ref={transcriptContainerRef} className=\"w-full border-r border-gray-200 bg-white flex flex-col overflow-y-auto\">",
        "    <div ref={transcriptContainerRef} className=\"relative w-full border-r border-gray-200 bg-white flex flex-col overflow-y-auto\">",
        "subtitle containing block",
    )
    closing_anchor = dedent('''
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
    ''')
    closing_new = dedent('''
              </div>
            </div>
          </div>
        </div>
      </div>

      {isRecording && (
        <LiveTranscriptSubtitle
          preview={livePreview}
          translation={liveTranslation.previewTranslation}
          translationEnabled={liveTranslation.settings.enabled}
          translationDisplayMode={liveTranslation.settings.displayMode}
          translationTargetLanguage={liveTranslation.settings.targetLanguage}
          isPaused={isPaused}
        />
      )}
    </div>
  );
    ''')
    text = replace_once(text, closing_anchor, closing_new, "subtitle panel render")
    path.write_text(text)

    print("Frontend subtitle UI implemented")


def performance() -> None:
    # More logging cleanup in the frontend hot path, without removing error diagnostics.
    path = Path("frontend/src/contexts/TranscriptContext.tsx")
    text = path.read_text()
    patterns = [
        r"\n\s*console\.log\('🎯 MAIN LISTENER: Received transcript update:', \{.*?\n\s*\}\);",
        r"\n\s*console\.log\(`✅ MAIN LISTENER: Buffered transcript.*?\);",
        r"\n\s*console\.log\(`Processing transcript with sequence_id.*?\);",
        r"\n\s*console\.log\(`Adding \$\{uniqueNewTranscripts\.length\} unique transcripts.*?\);",
    ]
    for pattern in patterns:
        text = re.sub(pattern, "", text, flags=re.S)
    path.write_text(text)

    docs = dedent('''
        # Streaming live transcripts

        MeetOdds now has two deliberately separate speech-to-text paths during recording.

        ## 1. Canonical transcript

        The existing VAD boundary, speaker attribution, sentence structure, persistence, copy/export,
        summaries, and recording history are unchanged. A canonical sentence is decoded only after
        VAD closes the utterance. This remains the source of truth.

        ## 2. Speculative subtitle preview

        While VAD is still inside an utterance, the audio pipeline takes a non-destructive rolling
        snapshot of the active speech buffer roughly every 450 ms after at least 700 ms of speech.
        Only the newest snapshot is retained. A separate preview task decodes a capped ~2.8 second
        rolling window and emits `live-transcript-preview` events.

        The frontend renders those events in a subtitle-style overlay even when translation is off.
        Nothing in this lane is written to IndexedDB, SQLite, `transcripts.json`, summaries, exports,
        or the recording saver. When the canonical sentence finishes, the preview is cleared and the
        normal transcript row appears.

        ### Priority and resource protection

        - The canonical worker marks final ASR as busy; speculative decoding does not start while it is busy.
        - Preview snapshots use a `watch` channel, so stale audio is dropped rather than queued.
        - Whisper preview uses greedy search, one segment, a short output cap, and at most two decoder threads.
        - Long-running preview results more than two snapshot revisions behind are discarded.
        - The preview task is aborted before stop-recording waits for final transcript work.

        ### Translation

        Live Translation V2 receives the same preview text when enabled. It intentionally does not cancel
        an in-flight translation on every ASR revision; it finishes the current short request and then jumps
        directly to the newest preview. This prevents the 450 ms subtitle cadence from starving a translation
        provider whose first token takes longer than one preview interval.

        ## Expected experience

        The overlay is meant to feel like live TV captions: words may revise as more speech arrives. The saved
        transcript remains cleaner and sentence-oriented. This separation is intentional—the preview optimizes
        perceived latency, while the canonical transcript optimizes correctness and durable meeting notes.
    ''').lstrip()
    Path("docs/STREAMING_LIVE_TRANSCRIPTS.md").write_text(docs)

    print("Performance cleanup and docs implemented")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["backend", "frontend", "performance"])
    args = parser.parse_args()
    {"backend": backend, "frontend": frontend, "performance": performance}[args.stage]()


if __name__ == "__main__":
    main()
