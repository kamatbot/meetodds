'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { toast } from 'sonner';
import { useTranscriptHistory, useTranscriptPreview, useTranscriptSession } from '@/contexts/TranscriptContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useLiveMeetingTranslation } from '@/contexts/LiveMeetingTranslationContext';
import { ensureCaptionWindow } from '@/services/captionWindowService';
import { liveTranslationSegmentKey } from '@/lib/live-translation';
import {
  CAPTION_WINDOW_LABEL, CAPTION_FRAME_EVENT, CAPTION_READY_EVENT, CAPTION_DISMISS_EVENT, CAPTION_RETRY_EVENT,
  resolveCaptionContent, type CaptionFrame,
} from '@/lib/live-captions';
import type { LiveTranscriptPreview } from '@/types';

/** Main-webview controller. The floating webview only paints these display frames; it never runs AI. */
export default function LiveCaptionBridge() {
  const { livePreview } = useTranscriptPreview();
  const { transcripts } = useTranscriptHistory();
  const { currentMeetingId, captionsVisible, setCaptionsVisible } = useTranscriptSession();
  const { isRecording, isPaused } = useRecordingState();
  const { settings, translations, previewTranslation, retryPreviewTranslation, lastError } = useLiveMeetingTranslation();
  const [recentFinal, setRecentFinal] = useState(false);
  const final = transcripts[transcripts.length - 1];
  const finalTranslation = final ? translations[liveTranslationSegmentKey(final)] : undefined;

  // A finalized turn remains readable briefly after VAD clears the speculative caption.
  useEffect(() => {
    setRecentFinal(Boolean(final));
    const timer = setTimeout(() => setRecentFinal(false), 6000);
    return () => clearTimeout(timer);
  }, [final?.id, finalTranslation?.translatedText, currentMeetingId]);

  const content = useMemo(() => {
    const candidate: LiveTranscriptPreview | null = livePreview ?? (recentFinal && final ? {
      text: final.text, speaker: final.speaker || 'speaker', speakerLabel: final.speaker_label || 'Speaker',
      source: final.speaker_source === 'system' ? 'system' : 'microphone',
      revision: final.sequence_id || 0, audioStartTime: final.audio_start_time || 0,
      audioEndTime: final.audio_end_time || 0, latencyMs: 0,
    } : null);
    const activeTranslation = livePreview ? previewTranslation : finalTranslation;
    const resolved = resolveCaptionContent({
      preview: candidate, translation: activeTranslation,
      translationEnabled: settings.enabled, targetLanguage: settings.targetLanguage, isPaused,
    });
    if (resolved.phase === 'error' && !resolved.error && lastError) {
      return { ...resolved, error: lastError };
    }
    return resolved;
  }, [livePreview, recentFinal, final, previewTranslation, finalTranslation, settings.enabled, settings.targetLanguage, isPaused, lastError]);

  const enabled = isRecording && captionsVisible;
  const latest = useRef({ ...content, enabled, sessionId: currentMeetingId || '' });
  latest.current = { ...content, enabled, sessionId: currentMeetingId || '' };
  const epoch = useRef('');
  const sequence = useRef(0);
  const overlay = useRef<WebviewWindow | null>(null);
  const disposed = useRef(false);

  const publish = useCallback(async () => {
    if (disposed.current || !overlay.current) return;
    if (!epoch.current) epoch.current = crypto.randomUUID();
    const frame: CaptionFrame = { ...latest.current, epoch: epoch.current, sequence: ++sequence.current };
    try { await emitTo(CAPTION_WINDOW_LABEL, CAPTION_FRAME_EVENT, frame); }
    catch { /* Closed webview; an explicit toggle recreates it. Never interrupt recording. */ }
  }, []);

  useEffect(() => {
    disposed.current = false;
    const unsubscribers: Array<() => void> = [];
    let gone = false;
    const add = (fn: () => void) => gone ? fn() : unsubscribers.push(fn);
    void listen(CAPTION_READY_EVENT, () => { void publish(); }).then(add).catch(() => {});
    void listen(CAPTION_DISMISS_EVENT, () => setCaptionsVisible(false)).then(add).catch(() => {});
    void listen(CAPTION_RETRY_EVENT, () => retryPreviewTranslation()).then(add).catch(() => {});
    // Handshake retry/heartbeat recovers a caption reload and a lost initial event.
    const interval = setInterval(() => { if (latest.current.enabled) void publish(); }, 2000);
    return () => {
      gone = true;
      disposed.current = true;
      clearInterval(interval);
      unsubscribers.forEach(fn => fn());
      void overlay.current?.hide().catch(() => {});
    };
  }, [publish, retryPreviewTranslation, setCaptionsVisible]);

  useEffect(() => {
    let cancelled = false;
    if (enabled) {
      void ensureCaptionWindow().then(async window => {
        if (cancelled || !latest.current.enabled) {
          // A later enable effect owns this singleton now; do not hide its window.
          if (!latest.current.enabled) await window.hide();
          return;
        }
        overlay.current = window;
        await publish();
      }).catch(() => {
        if (cancelled) return;
        setCaptionsVisible(false);
        toast.error('Live captions could not open', { description: 'Recording continues. Turn captions on again to retry.' });
      });
    } else {
      void publish();
      void (async () => {
        const window = overlay.current ?? await WebviewWindow.getByLabel(CAPTION_WINDOW_LABEL);
        if (!cancelled && !latest.current.enabled) await window?.hide();
      })().catch(() => {});
    }
    return () => { cancelled = true; };
  }, [enabled, publish, setCaptionsVisible]);

  useEffect(() => { void publish(); }, [content, currentMeetingId, enabled, publish]);
  return null;
}
