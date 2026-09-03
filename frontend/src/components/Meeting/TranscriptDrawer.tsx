'use client';

import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Copy, Globe2 } from 'lucide-react';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useLiveTranslation } from '@/hooks/useLiveTranslation';
import { liveTranslationSegmentKey } from '@/lib/live-translation';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { LiveTranslationControl } from '@/components/LiveTranslationControl';
import type { ModalType } from '@/hooks/useModalState';

const DRAWER_VISIBLE_KEY = 'meetodds.meeting.transcriptDrawer.visible';
const DRAWER_WIDTH_KEY = 'meetodds.meeting.transcriptDrawer.width';
const DEFAULT_DRAWER_WIDTH = 360;
const MIN_DRAWER_WIDTH = 280;
const MAX_DRAWER_WIDTH = 520;

interface TranscriptDrawerProps {
  isProcessingStop: boolean;
  isStopping: boolean;
  showModal: (name: ModalType, message?: string) => void;
}

function clampWidth(value: number): number {
  return Math.max(MIN_DRAWER_WIDTH, Math.min(MAX_DRAWER_WIDTH, value));
}

export default function TranscriptDrawer({
  isProcessingStop,
  isStopping,
  showModal,
}: TranscriptDrawerProps) {
  const { transcripts, copyTranscript } = useTranscripts();
  const { transcriptModelConfig } = useConfig();
  const { isRecording, isPaused } = useRecordingState();
  const liveTranslation = useLiveTranslation(transcripts);
  const [visible, setVisible] = useState(true);
  const [width, setWidth] = useState(DEFAULT_DRAWER_WIDTH);
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    try {
      const storedVisible = window.localStorage.getItem(DRAWER_VISIBLE_KEY);
      const storedWidth = Number(window.localStorage.getItem(DRAWER_WIDTH_KEY));
      if (storedVisible !== null) setVisible(storedVisible !== 'false');
      if (Number.isFinite(storedWidth) && storedWidth > 0) setWidth(clampWidth(storedWidth));
    } catch (error) {
      console.warn('[TranscriptDrawer] Unable to restore drawer preferences:', error);
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(DRAWER_VISIBLE_KEY, String(visible));
      window.localStorage.setItem(DRAWER_WIDTH_KEY, String(width));
    } catch (error) {
      console.warn('[TranscriptDrawer] Unable to persist drawer preferences:', error);
    }
  }, [storageReady, visible, width]);

  useEffect(() => {
    const toggleFromCommandPalette = () => setVisible((current) => !current);
    window.addEventListener('meetodds:toggle-transcript-drawer', toggleFromCommandPalette);
    return () => window.removeEventListener('meetodds:toggle-transcript-drawer', toggleFromCommandPalette);
  }, []);

  const segments = useMemo(() => transcripts.map((transcript) => {
    const translation = liveTranslation.translations[liveTranslationSegmentKey(transcript)];
    return {
      id: transcript.id,
      timestamp: transcript.audio_start_time ?? 0,
      endTime: transcript.audio_end_time,
      text: transcript.text,
      confidence: transcript.confidence,
      speaker: transcript.speaker,
      speaker_label: transcript.speaker_label,
      speaker_source: transcript.speaker_source,
      speaker_confidence: transcript.speaker_confidence,
      translated_text: translation?.translatedText,
      translation_status: translation?.status,
      translation_error: translation?.error,
      translation_latency_ms: translation?.latencyMs,
    };
  }), [liveTranslation.translations, transcripts]);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMove = (moveEvent: PointerEvent) => {
      setWidth(clampWidth(startWidth + startX - moveEvent.clientX));
    };

    const stop = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }, [width]);

  if (!visible) {
    return (
      <button
        type="button"
        onClick={() => setVisible(true)}
        className="absolute right-3 top-3 z-20 inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-ui font-medium text-text shadow-popover hover:bg-bg"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={1.75} /> Transcript
      </button>
    );
  }

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-surface"
      style={{ width }}
      aria-label="Live transcript"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize transcript drawer"
        onPointerDown={beginResize}
        className="absolute inset-y-0 left-[-2px] z-20 w-1 cursor-col-resize hover:bg-accent/30"
      />

      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-ui font-semibold text-text">Live transcript</span>
        {transcripts.length > 0 && (
          <button
            type="button"
            onClick={copyTranscript}
            className="inline-grid h-7 w-7 place-items-center rounded-control text-2 hover:bg-bg hover:text-text"
            aria-label="Copy transcript"
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        )}
        {transcriptModelConfig.provider === 'localWhisper' && (
          <button
            type="button"
            onClick={() => showModal('languageSettings')}
            className="inline-grid h-7 w-7 place-items-center rounded-control text-2 hover:bg-bg hover:text-text"
            aria-label="Transcription language"
          >
            <Globe2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="inline-grid h-7 w-7 place-items-center rounded-control text-2 hover:bg-bg hover:text-text"
          aria-label="Hide transcript drawer"
        >
          <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="shrink-0 border-b border-border px-3 py-2">
        <LiveTranslationControl
          settings={liveTranslation.settings}
          updateSettings={liveTranslation.updateSettings}
          clearTranslations={liveTranslation.clearTranslations}
          queuedCount={liveTranslation.queuedCount}
          activeCount={liveTranslation.activeCount}
          translatedCount={liveTranslation.translatedCount}
          lastError={liveTranslation.lastError}
          lastProvider={liveTranslation.lastProvider}
          lastModel={liveTranslation.lastModel}
          lastLatencyMs={liveTranslation.lastLatencyMs}
          lastFirstWordLatencyMs={liveTranslation.lastFirstWordLatencyMs}
          lastFallbackReason={liveTranslation.lastFallbackReason}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {segments.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-ui text-3">
            Original transcript text will appear here as speech is recognised.
          </div>
        ) : (
          <VirtualizedTranscriptView
            segments={segments}
            isRecording={isRecording}
            isPaused={isPaused}
            isProcessing={isProcessingStop}
            isStopping={isStopping}
            enableStreaming={isRecording}
            showConfidence={true}
            translationEnabled={liveTranslation.settings.enabled}
            translationDisplayMode={liveTranslation.settings.displayMode}
            translationTargetLanguage={liveTranslation.settings.targetLanguage}
          />
        )}
      </div>
    </aside>
  );
}
