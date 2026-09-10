'use client';

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useTranscriptHistory, useTranscriptPreview, useTranscriptSession } from './TranscriptContext';
import { useRecordingState } from './RecordingStateContext';
import { useLiveTranslation } from '@/hooks/useLiveTranslation';
import { loadLiveTranslationSettings } from '@/lib/live-translation';

const Context = createContext<ReturnType<typeof useLiveTranslation> | null>(null);

/** Exactly one live translation owner in the main webview, independent of routes/drawer visibility. */
export function LiveMeetingTranslationProvider({ children }: { children: ReactNode }) {
  const { transcripts } = useTranscriptHistory();
  const { livePreview } = useTranscriptPreview();
  const { captionsVisible, currentMeetingId } = useTranscriptSession();
  const { isRecording, isPaused } = useRecordingState();
  const translation = useLiveTranslation(
    transcripts,
    isRecording && !isPaused && captionsVisible ? livePreview : null,
    currentMeetingId,
  );
  const pathname = usePathname();
  const translationRef = useRef(translation);
  translationRef.current = translation;

  // Connected ChatGPT is a subscription-backed reasoning provider, not a dedicated
  // low-latency translation API. Its first token can legitimately arrive after the
  // Instant/Balanced timeout window. Once provider selection confirms ChatGPT, move
  // this live-translation session to the Accurate budget and let the hook restart the
  // latest pending preview. Fast streamed tokens still render immediately; this only
  // prevents the request from being killed before it has a chance to answer.
  useEffect(() => {
    if (
      translation.settings.enabled
      && translation.lastProvider === 'openai-codex'
      && translation.settings.speed !== 'accurate'
    ) {
      translation.updateSettings({ speed: 'accurate' });
    }
  }, [
    translation.lastProvider,
    translation.settings.enabled,
    translation.settings.speed,
    translation.updateSettings,
  ]);

  // Settings can also be edited on /settings. Reconcile on navigation without another translator.
  useEffect(() => {
    const reconcile = () => {
      const stored = loadLiveTranslationSettings();
      if (JSON.stringify(stored) !== JSON.stringify(translationRef.current.settings)) {
        translationRef.current.updateSettings(stored);
      }
    };
    reconcile();
    window.addEventListener('meetodds:live-translation-settings-updated', reconcile);
    window.addEventListener('storage', reconcile);
    return () => {
      window.removeEventListener('meetodds:live-translation-settings-updated', reconcile);
      window.removeEventListener('storage', reconcile);
    };
  }, [pathname]);

  return <Context.Provider value={translation}>{children}</Context.Provider>;
}

export function useLiveMeetingTranslation() {
  const context = useContext(Context);
  if (!context) throw new Error('Live meeting translation provider is missing');
  return context;
}
