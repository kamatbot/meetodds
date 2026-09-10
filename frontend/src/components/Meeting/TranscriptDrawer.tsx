'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { emitTo } from '@tauri-apps/api/event';
import { Captions, ChevronLeft, ChevronRight, Copy, Globe2, Maximize2, MessageSquareText, Rows3, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useTranscriptHistory, useTranscriptSession } from '@/contexts/TranscriptContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useLiveMeetingTranslation } from '@/contexts/LiveMeetingTranslationContext';
import { getLiveTranslationLanguage, liveTranslationSegmentKey } from '@/lib/live-translation';
import { CAPTION_WINDOW_LABEL, CAPTION_RESET_EVENT } from '@/lib/live-captions';
import NotedTranscriptView from '@/components/Notes/NotedTranscriptView';
import { LiveTranslationControl } from '@/components/LiveTranslationControl';
import type { ModalType } from '@/hooks/useModalState';
import './live-meeting.css';

const DRAWER_VISIBLE_KEY = 'meetodds.meeting.transcriptDrawer.visible';
const DRAWER_WIDTH_KEY = 'meetodds.meeting.transcriptDrawer.width';
const DENSITY_KEY = 'meetodds.meeting.transcriptDensity';
const clampWidth = (value: number) => Math.max(280, Math.min(520, value));
interface TranscriptDrawerProps {
  isProcessingStop: boolean;
  isStopping: boolean;
  showModal: (name: ModalType, message?: string) => void;
  presentation?: 'drawer' | 'workspace';
}

export default function TranscriptDrawer({ isProcessingStop, isStopping, showModal, presentation = 'drawer' }: TranscriptDrawerProps) {
  const { transcripts, copyTranscript } = useTranscriptHistory();
  const { currentMeetingId, captionsVisible } = useTranscriptSession();
  const { transcriptModelConfig } = useConfig();
  const { isRecording, isPaused } = useRecordingState();
  const liveTranslation = useLiveMeetingTranslation();
  const [visible, setVisible] = useState(true);
  const [width, setWidth] = useState(360);
  const [compact, setCompact] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const stopResizeRef = useRef<(() => void) | null>(null);
  const isWorkspace = presentation === 'workspace';

  useEffect(() => {
    try {
      const storedVisible = localStorage.getItem(DRAWER_VISIBLE_KEY);
      const storedWidth = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
      if (storedVisible !== null) setVisible(storedVisible !== 'false');
      if (Number.isFinite(storedWidth) && storedWidth > 0) setWidth(clampWidth(storedWidth));
      setCompact(localStorage.getItem(DENSITY_KEY) === 'compact');
    } catch { /* Preferences do not block a recording. */ }
    setStorageReady(true);
    return () => stopResizeRef.current?.();
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try { localStorage.setItem(DRAWER_VISIBLE_KEY, String(visible)); localStorage.setItem(DENSITY_KEY, compact ? 'compact' : 'comfortable'); }
    catch { /* Preferences only. */ }
  }, [visible, compact, storageReady]);

  useEffect(() => {
    const toggle = () => setVisible(value => !value);
    window.addEventListener('meetodds:toggle-transcript-drawer', toggle);
    return () => window.removeEventListener('meetodds:toggle-transcript-drawer', toggle);
  }, []);

  const segments = useMemo(() => transcripts.map(transcript => {
    const translation = liveTranslation.translations[liveTranslationSegmentKey(transcript)];
    return {
      id: transcript.id, timestamp: transcript.audio_start_time ?? 0, endTime: transcript.audio_end_time,
      text: transcript.text, confidence: transcript.confidence, speaker: transcript.speaker,
      speaker_label: transcript.speaker_label, speaker_source: transcript.speaker_source, speaker_confidence: transcript.speaker_confidence,
      translated_text: translation?.translatedText, translation_status: translation?.status,
      translation_error: translation?.error, translation_latency_ms: translation?.latencyMs,
    };
  }), [transcripts, liveTranslation.translations]);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault(); stopResizeRef.current?.();
    const startX = event.clientX;
    const startWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    let raf: number | null = null;
    let latestWidth = width;
    const move = (e: PointerEvent) => {
      latestWidth = clampWidth(startWidth + startX - e.clientX);
      if (raf === null) raf = requestAnimationFrame(() => { setWidth(latestWidth); raf = null; });
    };
    const stop = () => {
      if (raf !== null) cancelAnimationFrame(raf);
      setWidth(latestWidth);
      document.body.style.cursor = previousCursor; document.body.style.userSelect = previousSelect;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop);
      try { localStorage.setItem(DRAWER_WIDTH_KEY, String(latestWidth)); } catch { /* Preferences only. */ }
      stopResizeRef.current = null;
    };
    stopResizeRef.current = stop;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
  }, [width]);

  if (!visible && !isWorkspace) return (
    <button type="button" onClick={() => setVisible(true)} className="absolute right-3 top-3 z-20 inline-flex h-9 items-center gap-1.5 rounded-control border border-border bg-surface px-3 text-ui text-text shadow-popover">
      <ChevronLeft className="h-4 w-4" /> Transcript
    </button>
  );

  const language = getLiveTranslationLanguage(liveTranslation.settings.targetLanguage)?.name || liveTranslation.settings.targetLanguage;
  return (
    <section className={`meetodds-live-workspace ${isWorkspace ? 'is-workspace' : 'is-drawer'}`} style={isWorkspace ? undefined : { width }} aria-label="Live meeting conversation">
      {!isWorkspace && <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize transcript drawer" aria-valuemin={280} aria-valuemax={520} aria-valuenow={width}
        onPointerDown={beginResize} onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const next = clampWidth(width + (e.key === 'ArrowLeft' ? 20 : -20)); setWidth(next); try { localStorage.setItem(DRAWER_WIDTH_KEY, String(next)); } catch {} } }} className="meeting-drawer-resize" />}
      <header className="meeting-document-header">
        <div className="meeting-document-heading">
          <span className="meeting-eyebrow">THE CONVERSATION</span>
          <h1>{isPaused ? 'Room to think.' : isStopping || isProcessingStop ? 'Finishing the last words.' : 'Stay in the moment.'}</h1>
          <p>{isPaused ? 'Recording is paused. Your conversation stays right here.' : 'Every thought, with room for yours.'}</p>
        </div>
        <div className="meeting-document-tools">
          <button type="button" onClick={() => setCompact(v => !v)} className="meeting-icon-button" aria-label={compact ? 'Use comfortable transcript spacing' : 'Use compact transcript spacing'} aria-pressed={compact} title={compact ? 'Comfortable spacing' : 'Compact spacing'}><Rows3 size={17} /></button>
          <button type="button" onClick={copyTranscript} disabled={!transcripts.length} className="meeting-icon-button" aria-label="Copy original transcript" title="Copy original transcript"><Copy size={16} /></button>
          {transcriptModelConfig.provider === 'localWhisper' && <button type="button" className="meeting-icon-button" onClick={() => showModal('languageSettings')} aria-label="Spoken language" title="Spoken language"><Globe2 size={17} /></button>}
          {!isWorkspace && <button type="button" className="meeting-icon-button" onClick={() => setVisible(false)} aria-label="Hide transcript drawer"><ChevronRight size={17} /></button>}
        </div>
      </header>
      <div className="meeting-language-toolbar">
        <span className="meeting-local-label"><ShieldCheck size={14} aria-hidden="true" /> On-device transcription</span>
        <LiveTranslationControl {...liveTranslation} />
      </div>
      {captionsVisible && isRecording && <div className="meeting-caption-notice">
        <span><Captions size={14} aria-hidden="true" /> Floating captions · {liveTranslation.settings.enabled ? language : 'Original language'}</span>
        <button type="button" onClick={() => { void emitTo(CAPTION_WINDOW_LABEL, CAPTION_RESET_EVENT).catch(() => toast.error('Turn captions off and on to reopen the window.')); }}><Maximize2 size={12} /> Reset position</button>
      </div>}
      <div className="meeting-document-card" data-density={compact ? 'compact' : 'comfortable'}>
        {!segments.length ? <div className="meeting-listening-empty">
          <div className="meeting-listening-mark" aria-hidden="true"><MessageSquareText size={27} strokeWidth={1.4} /></div>
          <h2>{isPaused ? 'Take your time.' : 'Ready for the first words.'}</h2>
          <p>{isPaused ? 'Resume when you are ready to continue.' : 'Speak naturally. Your transcript will appear here, and the + beside a turn opens a linked note.'}</p>
          <span className="meeting-listening-status"><i aria-hidden="true" />{isPaused ? 'Recording paused' : 'Waiting for speech'}</span>
        </div> : <NotedTranscriptView
          meetingId={currentMeetingId} noteTranscripts={transcripts} liveNotes segments={segments}
          isRecording={isRecording} isPaused={isPaused} isProcessing={isProcessingStop} isStopping={isStopping}
          enableStreaming={false} showConfidence={false}
          translationEnabled={liveTranslation.settings.enabled}
          translationDisplayMode={liveTranslation.settings.displayMode}
          translationTargetLanguage={liveTranslation.settings.targetLanguage}
        />}
      </div>
      <footer className="meeting-document-footer"><span>Original transcript preserved</span><span>Notes stay linked to their moments</span></footer>
    </section>
  );
}
