#!/usr/bin/env python3
"""Apply the speaker-attribution milestone in two reviewable phases.

This is a one-shot repository migration helper used by the implementation CI.
It is removed after the branch has been patched and validated.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def path(relative: str) -> Path:
    return ROOT / relative


def read(relative: str) -> str:
    return path(relative).read_text()


def write(relative: str, text: str) -> None:
    path(relative).write_text(text)


def replace_once(relative: str, old: str, new: str) -> None:
    text = read(relative)
    if old not in text:
        if new in text:
            return
        raise SystemExit(f"Missing patch anchor in {relative}: {old[:180]!r}")
    write(relative, text.replace(old, new, 1))


def replace_all(relative: str, old: str, new: str, expected: int | None = None) -> None:
    text = read(relative)
    count = text.count(old)
    if expected is not None and count != expected:
        if count == 0 and new in text:
            return
        raise SystemExit(
            f"Expected {expected} anchors in {relative}, found {count}: {old[:160]!r}"
        )
    if count == 0:
        if new in text:
            return
        raise SystemExit(f"Missing patch anchor in {relative}: {old[:160]!r}")
    write(relative, text.replace(old, new))


def regex_once(relative: str, pattern: str, replacement: str) -> None:
    text = read(relative)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        if replacement in text:
            return
        raise SystemExit(f"Regex patch failed in {relative}: {pattern[:180]!r}")
    write(relative, updated)


def apply_rust_phase() -> None:
    replace_once(
        "frontend/src-tauri/src/audio/transcription/mod.rs",
        "pub mod engine;\npub mod worker;\n",
        "pub mod engine;\npub mod speaker_detection;\npub mod worker;\n",
    )

    pipeline = "frontend/src-tauri/src/audio/pipeline.rs"
    replace_once(
        pipeline,
        "use super::vad::{ContinuousVadProcessor};",
        "use super::vad::{ContinuousVadProcessor, SpeechSegment};",
    )
    replace_once(
        pipeline,
        "    vad_processor: ContinuousVadProcessor,\n",
        "    mic_vad_processor: ContinuousVadProcessor,\n"
        "    system_vad_processor: ContinuousVadProcessor,\n",
    )
    regex_once(
        pipeline,
        r"        let vad_processor = match ContinuousVadProcessor::new\(sample_rate, redemption_time\) \{.*?\n        \};\n\n        // Initialize professional audio mixing components",
        '''        let create_vad_processor = |source: &str| {
            match ContinuousVadProcessor::new(sample_rate, redemption_time) {
                Ok(processor) => {
                    info!(
                        "VAD-driven pipeline: {} segments retain their source channel",
                        source
                    );
                    processor
                }
                Err(e) => {
                    error!("Failed to create {} VAD processor: {}", source, e);
                    panic!("{} VAD processor creation failed: {}", source, e);
                }
            }
        };
        let mic_vad_processor = create_vad_processor("microphone");
        let system_vad_processor = create_vad_processor("system audio");

        // Initialize professional audio mixing components''',
    )
    replace_once(
        pipeline,
        "            vad_processor,\n",
        "            mic_vad_processor,\n            system_vad_processor,\n",
    )
    replace_once(
        pipeline,
        "                    // STEP 1: Add raw audio to ring buffer for mixing\n",
        '''                    // STEP 1: Transcribe each source independently so speaker
                    // attribution survives VAD and speech recognition.
                    if let Err(e) = self.process_source_audio(
                        chunk.device_type.clone(),
                        &chunk.data,
                    ) {
                        warn!(
                            "Failed to process {:?} audio for transcription: {}",
                            chunk.device_type, e
                        );
                    }

                    // STEP 2: Add raw audio to the ring buffer for the mixed recording.
''',
    )
    regex_once(
        pipeline,
        r"\n                            // STEP 3: Send mixed audio for transcription \(VAD \+ Whisper\).*?\n                            // STEP 4: Send mixed audio for recording \(WAV file\)",
        "\n                            // STEP 3: Send mixed audio for recording (WAV file)",
    )
    regex_once(
        pipeline,
        r"    fn flush_remaining_audio\(&mut self\) -> Result<\(\)> \{.*?\n    \}\n\n\}\n\n/// Simple audio pipeline manager",
        '''    fn process_source_audio(
        &mut self,
        device_type: DeviceType,
        samples: &[f32],
    ) -> Result<()> {
        let segments = match device_type {
            DeviceType::Microphone => self.mic_vad_processor.process_audio(samples)?,
            DeviceType::System => self.system_vad_processor.process_audio(samples)?,
        };
        self.send_speech_segments(device_type, segments);
        Ok(())
    }

    fn send_speech_segments(
        &mut self,
        device_type: DeviceType,
        segments: Vec<SpeechSegment>,
    ) {
        let source_name = match device_type {
            DeviceType::Microphone => "microphone",
            DeviceType::System => "system audio",
        };

        for segment in segments {
            let duration_ms = segment.end_timestamp_ms - segment.start_timestamp_ms;
            if segment.samples.len() < 800 {
                debug!(
                    "Dropping short {} VAD segment: {:.1}ms ({} samples)",
                    source_name,
                    duration_ms,
                    segment.samples.len()
                );
                continue;
            }

            let transcription_chunk = AudioChunk {
                data: segment.samples,
                sample_rate: 16_000,
                timestamp: segment.start_timestamp_ms / 1000.0,
                chunk_id: self.chunk_id_counter,
                device_type: device_type.clone(),
            };

            if let Err(e) = self.transcription_sender.send(transcription_chunk) {
                warn!("Failed to send {} VAD segment: {}", source_name, e);
            } else {
                self.chunk_id_counter += 1;
            }
        }
    }

    fn flush_remaining_audio(&mut self) -> Result<()> {
        info!(
            "Flushing source-separated VAD processors after {} input chunks",
            self.processed_chunks
        );

        match self.mic_vad_processor.flush() {
            Ok(segments) => self.send_speech_segments(DeviceType::Microphone, segments),
            Err(e) => warn!("Failed to flush microphone VAD processor: {}", e),
        }
        match self.system_vad_processor.flush() {
            Ok(segments) => self.send_speech_segments(DeviceType::System, segments),
            Err(e) => warn!("Failed to flush system-audio VAD processor: {}", e),
        }

        Ok(())
    }

}

/// Simple audio pipeline manager''',
    )

    worker = "frontend/src-tauri/src/audio/transcription/worker.rs"
    replace_once(
        worker,
        "use super::provider::TranscriptionError;\n",
        "use super::provider::TranscriptionError;\n"
        "use super::speaker_detection::SpeakerAttributor;\n",
    )
    replace_once(
        worker,
        "    pub source: String,\n",
        '''    pub source: String,
    pub speaker: String,
    pub speaker_label: String,
    pub speaker_source: String,
    pub speaker_confidence: f32,
''',
    )
    replace_once(
        worker,
        "    transcription_receiver: tokio::sync::mpsc::UnboundedReceiver<AudioChunk>,\n",
        "    transcription_receiver: tokio::sync::mpsc::UnboundedReceiver<AudioChunk>,\n"
        "    channel_separated: bool,\n",
    )
    replace_once(
        worker,
        "        // Create parallel workers for faster processing while preserving ALL chunks\n",
        '''        let speaker_attributor = Arc::new(tokio::sync::Mutex::new(
            SpeakerAttributor::new(channel_separated),
        ));

        // Create parallel workers for faster processing while preserving ALL chunks
''',
    )
    replace_once(
        worker,
        "            let chunks_queued_clone = chunks_queued.clone();\n",
        "            let chunks_queued_clone = chunks_queued.clone();\n"
        "            let speaker_attributor_clone = speaker_attributor.clone();\n",
    )
    replace_once(
        worker,
        "                            let chunk_duration = chunk.data.len() as f64 / chunk.sample_rate as f64;\n\n"
        "                            // Transcribe with provider-agnostic approach\n",
        '''                            let chunk_duration = chunk.data.len() as f64 / chunk.sample_rate as f64;
                            let speaker_assignment = {
                                let mut attributor = speaker_attributor_clone.lock().await;
                                attributor.assign(
                                    &chunk.device_type,
                                    &chunk.data,
                                    chunk.sample_rate,
                                    chunk_timestamp,
                                )
                            };

                            // Transcribe with provider-agnostic approach
''',
    )
    replace_once(
        worker,
        '                                            source: "Audio".to_string(),\n',
        '''                                            source: speaker_assignment.speaker_source.clone(),
                                            speaker: speaker_assignment.speaker_id,
                                            speaker_label: speaker_assignment.speaker_label,
                                            speaker_source: speaker_assignment.speaker_source,
                                            speaker_confidence: speaker_assignment.confidence,
''',
    )

    commands = "frontend/src-tauri/src/audio/recording_commands.rs"
    replace_once(
        commands,
        "    // Always ensure a meeting name is set so incremental saver initializes\n",
        "    let has_separate_system_audio = system_device.is_some();\n\n"
        "    // Always ensure a meeting name is set so incremental saver initializes\n",
    )
    replace_once(
        commands,
        "    // Async-first approach for custom devices - no more blocking operations!\n",
        "    let has_separate_system_audio = system_device.is_some();\n\n"
        "    // Async-first approach for custom devices - no more blocking operations!\n",
    )
    replace_all(
        commands,
        "transcription::start_transcription_task(app.clone(), transcription_receiver)",
        '''transcription::start_transcription_task(
        app.clone(),
        transcription_receiver,
        has_separate_system_audio,
    )''',
        expected=2,
    )
    replace_all(
        commands,
        "                    sequence_id: update.sequence_id,\n",
        '''                    sequence_id: update.sequence_id,
                    speaker: Some(update.speaker.clone()),
                    speaker_label: Some(update.speaker_label.clone()),
                    speaker_source: Some(update.speaker_source.clone()),
                    speaker_confidence: Some(update.speaker_confidence),
''',
        expected=2,
    )

    saver = "frontend/src-tauri/src/audio/recording_saver.rs"
    replace_once(
        saver,
        "    pub sequence_id: u64,\n",
        '''    pub sequence_id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_confidence: Option<f32>,
''',
    )
    replace_once(
        saver,
        "            sequence_id: 0,\n",
        '''            sequence_id: 0,
            speaker: None,
            speaker_label: None,
            speaker_source: None,
            speaker_confidence: None,
''',
    )

    models = "frontend/src-tauri/src/database/models.rs"
    replace_once(
        models,
        "    #[sqlx(default)]\n    pub duration: Option<f64>,\n}\n",
        '''    #[sqlx(default)]
    pub duration: Option<f64>,
    #[sqlx(default)]
    pub speaker: Option<String>,
    #[sqlx(default)]
    pub speaker_label: Option<String>,
    #[sqlx(default)]
    pub speaker_source: Option<String>,
    #[sqlx(default)]
    pub speaker_confidence: Option<f64>,
}
''',
    )

    api = "frontend/src-tauri/src/api/api.rs"
    speaker_api_fields = '''    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_confidence: Option<f64>,
'''
    api_text = read(api)
    api_anchor = (
        '    #[serde(skip_serializing_if = "Option::is_none")]\n'
        "    pub duration: Option<f64>,\n}"
    )
    if api_text.count(api_anchor) != 2:
        if "pub speaker_confidence: Option<f64>" not in api_text:
            raise SystemExit(
                f"Expected two API transcript anchors, found {api_text.count(api_anchor)}"
            )
    else:
        api_text = api_text.replace(
            api_anchor,
            '    #[serde(skip_serializing_if = "Option::is_none")]\n'
            "    pub duration: Option<f64>,\n"
            + speaker_api_fields
            + "}",
        )
    api_text = api_text.replace(
        "                    duration: t.duration,\n",
        '''                    duration: t.duration,
                    speaker: t.speaker,
                    speaker_label: t.speaker_label,
                    speaker_source: t.speaker_source,
                    speaker_confidence: t.speaker_confidence,
''',
    )
    write(api, api_text)

    replace_all(
        "frontend/src-tauri/src/database/repositories/meeting.rs",
        "                    duration: t.duration,\n",
        '''                    duration: t.duration,
                    speaker: t.speaker,
                    speaker_label: t.speaker_label,
                    speaker_source: t.speaker_source,
                    speaker_confidence: t.speaker_confidence,
''',
        expected=1,
    )

    transcript_repo = "frontend/src-tauri/src/database/repositories/transcript.rs"
    replace_once(
        transcript_repo,
        '''                let result = sqlx::query(
                    "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration) VALUES (?, ?, ?, ?, ?, ?, ?)",
                )
''',
        '''                let result = sqlx::query(
                    "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker, speaker_label, speaker_source, speaker_confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
''',
    )
    replace_once(
        transcript_repo,
        "                .bind(segment.duration)\n                .execute(&mut *transaction)\n",
        '''                .bind(segment.duration)
                .bind(&segment.speaker)
                .bind(&segment.speaker_label)
                .bind(&segment.speaker_source)
                .bind(segment.speaker_confidence)
                .execute(&mut *transaction)
''',
    )

    common = "frontend/src-tauri/src/audio/common.rs"
    replace_once(
        common,
        "                duration: Some(duration),\n",
        '''                duration: Some(duration),
                speaker: None,
                speaker_label: None,
                speaker_source: None,
                speaker_confidence: None,
''',
    )
    replace_once(
        common,
        '                "duration": s.duration,\n                "sequence_id": i\n',
        '''                "duration": s.duration,
                "speaker": s.speaker,
                "speaker_label": s.speaker_label,
                "speaker_source": s.speaker_source,
                "speaker_confidence": s.speaker_confidence,
                "sequence_id": i
''',
    )


def apply_frontend_phase() -> None:
    types = "frontend/src/types/index.ts"
    replace_once(
        types,
        "  confidence?: number;\n  // NEW: Recording-relative timestamps for playback sync\n",
        '''  confidence?: number;
  speaker?: string;
  speaker_label?: string;
  speaker_source?: string;
  speaker_confidence?: number;
  // NEW: Recording-relative timestamps for playback sync
''',
    )
    replace_once(
        types,
        "  confidence: number;\n  // NEW: Recording-relative timestamps for playback sync\n",
        '''  confidence: number;
  speaker?: string;
  speaker_label?: string;
  speaker_source?: string;
  speaker_confidence?: number;
  // NEW: Recording-relative timestamps for playback sync
''',
    )
    replace_once(
        types,
        "  confidence?: number;\n}\n",
        '''  confidence?: number;
  speaker?: string;
  speaker_label?: string;
  speaker_source?: string;
  speaker_confidence?: number;
}
''',
    )

    replace_once(
        "frontend/src/services/indexedDBService.ts",
        "  duration?: number;          // Duration in seconds\n",
        '''  duration?: number;          // Duration in seconds
  speaker?: string;
  speaker_label?: string;
  speaker_source?: string;
  speaker_confidence?: number;
''',
    )

    context = "frontend/src/contexts/TranscriptContext.tsx"
    replace_once(
        context,
        "import { recordingService } from '@/services/recordingService';\n",
        "import { recordingService } from '@/services/recordingService';\n"
        "import { withSpeakerPrefix } from '@/lib/speaker-labels';\n",
    )
    replace_once(
        context,
        "            confidence: update.confidence,\n",
        '''            confidence: update.confidence,
            speaker: update.speaker,
            speaker_label: update.speaker_label,
            speaker_source: update.speaker_source,
            speaker_confidence: update.speaker_confidence,
''',
    )
    replace_once(
        context,
        "            confidence: segment.confidence,\n",
        '''            confidence: segment.confidence,
            speaker: segment.speaker,
            speaker_label: segment.speaker_label,
            speaker_source: segment.speaker_source,
            speaker_confidence: segment.speaker_confidence,
''',
    )
    replace_once(
        context,
        "      confidence: update.confidence,\n",
        '''      confidence: update.confidence,
      speaker: update.speaker,
      speaker_label: update.speaker_label,
      speaker_source: update.speaker_source,
      speaker_confidence: update.speaker_confidence,
''',
    )
    replace_once(
        context,
        ".map(t => `${formatTime(t.audio_start_time)} ${t.text}`)\n",
        ".map(t => `${formatTime(t.audio_start_time)} ${withSpeakerPrefix(t, t.text)}`)\n",
    )

    replace_once(
        "frontend/src/hooks/useTranscriptRecovery.ts",
        "        duration: (t as any).duration,\n",
        '''        duration: (t as any).duration,
        speaker: (t as any).speaker,
        speaker_label: (t as any).speaker_label,
        speaker_source: (t as any).speaker_source,
        speaker_confidence: (t as any).speaker_confidence,
''',
    )

    segment_fields = '''      speaker: t.speaker,
      speaker_label: t.speaker_label,
      speaker_source: t.speaker_source,
      speaker_confidence: t.speaker_confidence,
'''
    replace_once(
        "frontend/src/app/_components/TranscriptPanel.tsx",
        "      confidence: t.confidence,\n",
        "      confidence: t.confidence,\n" + segment_fields,
    )
    replace_once(
        "frontend/src/components/MeetingDetails/TranscriptPanel.tsx",
        "      confidence: t.confidence,\n",
        "      confidence: t.confidence,\n" + segment_fields,
    )
    replace_once(
        "frontend/src/hooks/usePaginatedTranscripts.ts",
        "        confidence: t.confidence,\n",
        "        confidence: t.confidence,\n" + segment_fields.replace("      ", "        "),
    )

    view = "frontend/src/components/VirtualizedTranscriptView.tsx"
    replace_once(
        view,
        'import { TranscriptSegmentData } from "@/types";\n',
        '''import { TranscriptSegmentData } from "@/types";
import {
    describeSpeakerSource,
    getSpeakerPresentation,
} from "@/lib/speaker-labels";
''',
    )
    regex_once(
        view,
        r"// Memoized transcript segment component\nconst TranscriptSegment = memo\(function TranscriptSegment\(\{.*?\n\}\);\n\nexport const VirtualizedTranscriptView",
        '''// Memoized transcript segment component
const TranscriptSegment = memo(function TranscriptSegment({
    id,
    timestamp,
    text,
    confidence,
    speaker: speakerId,
    speakerLabel,
    speakerSource,
    speakerConfidence,
    isStreaming,
    showConfidence,
}: {
    id: string;
    timestamp: number;
    text: string;
    confidence?: number;
    speaker?: string;
    speakerLabel?: string;
    speakerSource?: string;
    speakerConfidence?: number;
    isStreaming: boolean;
    showConfidence: boolean;
}) {
    const displayText = cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);
    const speaker = getSpeakerPresentation({
        speaker: speakerId,
        speaker_label: speakerLabel,
        speaker_source: speakerSource,
        speaker_confidence: speakerConfidence,
    });
    const sourceDescription = speaker ? describeSpeakerSource(speaker.source) : null;

    return (
        <div
            id={`segment-${id}`}
            className="mb-3"
            aria-label={speaker ? `${speaker.label}: ${displayText}` : displayText}
        >
            <div className="flex items-start gap-2">
                <Tooltip>
                    <TooltipTrigger>
                        <span className="text-xs text-gray-400 mt-1 flex-shrink-0 min-w-[50px]">
                            {formatRecordingTime(timestamp)}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent className="space-y-1">
                        {confidence !== undefined && showConfidence && (
                            <ConfidenceIndicator confidence={confidence} showIndicator={showConfidence} />
                        )}
                        {speaker && sourceDescription && (
                            <div className="text-xs">
                                <div>{sourceDescription}</div>
                                {speaker.confidence !== null && (
                                    <div>Speaker confidence: {Math.round(speaker.confidence * 100)}%</div>
                                )}
                            </div>
                        )}
                    </TooltipContent>
                </Tooltip>
                <div
                    className={`flex-1 border-l-2 pl-3 ${speaker?.accentClassName ?? 'border-l-transparent'}`}
                >
                    {speaker && (
                        <div className="mb-1 flex items-center gap-2">
                            <span
                                className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${speaker.badgeClassName}`}
                            >
                                {speaker.label}
                            </span>
                            {speaker.isEstimate && (
                                <span className="text-[11px] text-gray-400">best estimate</span>
                            )}
                        </div>
                    )}
                    {isStreaming ? (
                        <div className="bg-gray-100 border border-gray-200 rounded-lg px-3 py-2">
                            <p className="text-base text-gray-800 leading-relaxed">{displayText}</p>
                        </div>
                    ) : (
                        <p className="text-base text-gray-800 leading-relaxed">{displayText}</p>
                    )}
                </div>
            </div>
        </div>
    );
});

export const VirtualizedTranscriptView''',
    )
    replace_once(
        view,
        "        estimateSize: () => 60, // Estimated height per segment\n",
        "        estimateSize: () => 88, // Speaker badge plus transcript text\n",
    )
    replace_all(
        view,
        "                                        confidence={segment.confidence}\n",
        '''                                        confidence={segment.confidence}
                                        speaker={segment.speaker}
                                        speakerLabel={segment.speaker_label}
                                        speakerSource={segment.speaker_source}
                                        speakerConfidence={segment.speaker_confidence}
''',
        expected=2,
    )

    summary = "frontend/src/hooks/meeting-details/useSummaryGeneration.ts"
    replace_once(
        summary,
        "import { BuiltInModelInfo } from '@/lib/builtin-ai';\n",
        "import { BuiltInModelInfo } from '@/lib/builtin-ai';\n"
        "import { withSpeakerPrefix } from '@/lib/speaker-labels';\n",
    )
    replace_once(
        summary,
        ".map(t => `${formatTime(t.audio_start_time, t.timestamp)} ${t.text}`)\n",
        ".map(t => `${formatTime(t.audio_start_time, t.timestamp)} ${withSpeakerPrefix(t, t.text)}`)\n",
    )

    copy = "frontend/src/hooks/meeting-details/useCopyOperations.ts"
    replace_once(
        copy,
        "import { invoke as invokeTauri } from '@tauri-apps/api/core';\n",
        "import { invoke as invokeTauri } from '@tauri-apps/api/core';\n"
        "import { withSpeakerPrefix } from '@/lib/speaker-labels';\n",
    )
    replace_once(
        copy,
        ".map(t => `${formatTime(t.audio_start_time, t.timestamp)} ${t.text}  `)\n",
        ".map(t => `${formatTime(t.audio_start_time, t.timestamp)} ${withSpeakerPrefix(t, t.text)}  `)\n",
    )

    docs = """# Speaker detection

Notes attaches a speaker label to each live transcript turn without uploading or retaining biometric voiceprints.

## Reliable channel attribution

When both microphone and system audio are active, the transcription pipeline keeps the streams separate:

- microphone turns are labelled **Me**;
- system-audio turns are labelled **Speaker 1**, **Speaker 2**, and so on;
- only the saved audio recording is mixed.

The previous pipeline mixed both streams before VAD and then labelled every generated chunk as microphone audio. Source separation now happens before VAD, so the minimum `Me` versus remote distinction is based on the capture channel rather than a voice guess.

## Multiple speakers

Remote or room turns are clustered locally using a compact acoustic signature built from MFCC-like spectral features, pitch, spectral shape, and zero-crossing behavior. Clusters are scoped to one recording and capped at six speakers. Labels are intentionally generic because this is diarization, not identity recognition.

Acoustic labels carry a confidence score and low-confidence labels appear as **best estimate**. New clusters require a sufficiently long and strongly dissimilar turn, which favors avoiding false speaker proliferation over detecting every very short interruption.

## Important boundaries

- With system audio enabled, **Me** is deterministic from the microphone channel. Headphones reduce duplicate remote speech leaking into the microphone.
- In a microphone-only room recording, the app cannot know which voice belongs to the device owner. It uses `Speaker 1`, `Speaker 2`, and so on instead of falsely labelling every person as **Me**.
- Imported or retranscribed mixed recordings do not contain the original channel identity, so existing turns remain unlabelled unless a later model-backed offline diarization pass is run.
- Simultaneous speakers on different capture channels can produce overlapping timestamped turns. Separating overlapping people within one mono channel requires a dedicated segmentation and speaker-embedding model.

## Data model

Each transcript may contain:

- `speaker`: stable session-local id such as `me` or `remote-2`;
- `speaker_label`: display label;
- `speaker_source`: `microphone-channel`, `system-acoustic`, or `microphone-acoustic`;
- `speaker_confidence`: value from 0 to 1.

Speaker labels flow through live rendering, crash recovery, SQLite persistence, transcript copy, pagination, and summary generation. This lets meeting templates attribute decisions, commitments, and dissent to the correct turn.
"""
    write("docs/SPEAKER_DETECTION.md", docs)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("rust", "frontend"))
    args = parser.parse_args()

    if args.phase == "rust":
        apply_rust_phase()
    else:
        apply_frontend_phase()


if __name__ == "__main__":
    main()
