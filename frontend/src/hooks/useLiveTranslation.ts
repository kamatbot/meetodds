'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { LiveTranscriptPreview, Transcript } from '@/types';
import {
  DEFAULT_LIVE_TRANSLATION_SETTINGS,
  LiveTranslationEntry,
  LiveTranslationResponse,
  LiveTranslationSettings,
  liveTranslationSegmentKey,
  loadLiveTranslationSettings,
  saveLiveTranslationSettings,
} from '@/lib/live-translation';

const MAX_CONCURRENT_TRANSLATIONS = 2;
const MAX_QUEUED_TRANSLATIONS = 24;
const BACKFILL_SEGMENT_LIMIT = 3;
const RESULT_CACHE_LIMIT = 200;

interface TranslationJob {
  segmentKey: string;
  text: string;
  revision: string;
  requestId: string;
  sourceLanguage: 'auto';
  targetLanguage: string;
  generation: number;
  translationEngine: LiveTranslationSettings['engine'];
  speedMode: LiveTranslationSettings['speed'];
  modelOverride: string;
  contextText: string;
  glossary: string;
  contextHint: string;
}

interface LiveTranslationState {
  settings: LiveTranslationSettings;
  translations: Record<string, LiveTranslationEntry>;
  updateSettings: (update: Partial<LiveTranslationSettings>) => void;
  clearTranslations: () => void;
  queuedCount: number;
  activeCount: number;
  translatedCount: number;
  lastError: string | null;
  lastProvider: string | null;
  lastModel: string | null;
  lastLatencyMs: number | null;
  lastFirstWordLatencyMs: number | null;
  lastFallbackReason: string | null;
  previewTranslation?: LiveTranslationEntry;
}

function cacheKey(job: TranslationJob): string {
  return [
    job.sourceLanguage,
    job.targetLanguage,
    job.translationEngine,
    job.modelOverride,
    job.contextText,
    job.glossary,
    job.contextHint,
    job.text,
  ].join('\u0000');
}

function trimCache(cache: Map<string, LiveTranslationResponse>): void {
  while (cache.size > RESULT_CACHE_LIMIT) {
    const firstKey = cache.keys().next().value as string | undefined;
    if (!firstKey) return;
    cache.delete(firstKey);
  }
}

function speakerLabel(transcript: Transcript): string {
  return transcript.speaker_label || transcript.speaker || 'Speaker';
}

function contextForTurn(transcripts: Transcript[], index: number, turns: 0 | 2 | 4): string {
  if (turns === 0 || index <= 0) return '';
  return transcripts
    .slice(Math.max(0, index - turns), index)
    .map((turn) => `${speakerLabel(turn)}: ${turn.text.trim()}`)
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

export function useLiveTranslation(
  transcripts: Transcript[],
  livePreview: LiveTranscriptPreview | null = null
): LiveTranslationState {
  const [settings, setSettings] = useState<LiveTranslationSettings>(DEFAULT_LIVE_TRANSLATION_SETTINGS);
  const [translations, setTranslations] = useState<Record<string, LiveTranslationEntry>>({});
  const [queuedCount, setQueuedCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [lastModel, setLastModel] = useState<string | null>(null);
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const [lastFirstWordLatencyMs, setLastFirstWordLatencyMs] = useState<number | null>(null);
  const [lastFallbackReason, setLastFallbackReason] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const queueRef = useRef<TranslationJob[]>([]);
  const activeCountRef = useRef(0);
  const generationRef = useRef(0);
  const requestCounterRef = useRef(0);
  const latestRevisionRef = useRef(new Map<string, string>());
  const activeRequestIdsRef = useRef(new Map<string, string>());
  const activeJobsRef = useRef(new Map<string, TranslationJob>());
  const resultCacheRef = useRef(new Map<string, LiveTranslationResponse>());

const drainQueueRef = useRef<() => void>(() => undefined);
const previewInFlightRef = useRef<TranslationJob | null>(null);
const pendingPreviewRef = useRef<TranslationJob | null>(null);
const runPreviewTranslationRef = useRef<() => void>(() => undefined);

  const updateCounts = useCallback(() => {
    if (!mountedRef.current) return;
    setQueuedCount(queueRef.current.length);
    setActiveCount(activeCountRef.current);
  }, []);

  const isCurrentJob = useCallback((job: TranslationJob): boolean => (
    mountedRef.current
    && job.generation === generationRef.current
    && latestRevisionRef.current.get(job.segmentKey) === job.revision
  ), []);

  const cancelNativeRequest = useCallback((requestId: string | undefined) => {
    if (!requestId) return;
    void invoke<boolean>('api_cancel_live_translation', { requestId }).catch(() => undefined);
  }, []);

  const drainQueue = useCallback(() => {
    while (activeCountRef.current < MAX_CONCURRENT_TRANSLATIONS && queueRef.current.length > 0) {
      const job = queueRef.current.shift()!;
      if (!isCurrentJob(job)) continue;
      activeCountRef.current += 1;
      activeRequestIdsRef.current.set(job.segmentKey, job.requestId);
      activeJobsRef.current.set(job.requestId, job);
      updateCounts();
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
          const totalLatency = cached ? 0 : response.latencyMs;
          const firstWordLatency = cached ? 0 : response.firstWordLatencyMs;
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
              latencyMs: totalLatency,
              firstWordLatencyMs: firstWordLatency,
              fallbackReason: response.fallbackReason ?? undefined,
              cached: response.cached || Boolean(cached),
            },
          }));
          setLastError(null);
          setLastProvider(response.provider);
          setLastModel(response.model);
          setLastLatencyMs(totalLatency);
          setLastFirstWordLatencyMs(firstWordLatency);
          setLastFallbackReason(response.fallbackReason ?? null);
        } catch (error) {
          if (!isCurrentJob(job)) return;
          const message = error instanceof Error ? error.message : String(error);
          if (/cancelled/i.test(message)) return;
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
          setLastError(message);
        } finally {
          activeJobsRef.current.delete(job.requestId);
          if (activeRequestIdsRef.current.get(job.segmentKey) === job.requestId) {
            activeRequestIdsRef.current.delete(job.segmentKey);
          }
          activeCountRef.current = Math.max(0, activeCountRef.current - 1);
          updateCounts();
          queueMicrotask(() => drainQueueRef.current());
        }
      })();
    }
    updateCounts();
  }, [isCurrentJob, updateCounts]);

  drainQueueRef.current = drainQueue;

  const enqueueJob = useCallback((job: TranslationJob) => {
    if (!isCurrentJob(job)) return;
    queueRef.current = queueRef.current.filter((queued) => queued.segmentKey !== job.segmentKey);
    if (queueRef.current.length >= MAX_QUEUED_TRANSLATIONS) queueRef.current.pop();
    queueRef.current.unshift(job);
    updateCounts();
    queueMicrotask(() => drainQueueRef.current());
  }, [isCurrentJob, updateCounts]);

  const clearPendingWork = useCallback(() => {
    generationRef.current += 1;
    queueRef.current = [];
    for (const requestId of activeRequestIdsRef.current.values()) cancelNativeRequest(requestId);
    activeRequestIdsRef.current.clear();
    activeJobsRef.current.clear();
    previewInFlightRef.current = null;
    pendingPreviewRef.current = null;
    latestRevisionRef.current.clear();
    updateCounts();
  }, [cancelNativeRequest, updateCounts]);

  const clearTranslations = useCallback(() => {
    clearPendingWork();
    setTranslations({});
    setLastError(null);
    setLastLatencyMs(null);
    setLastFirstWordLatencyMs(null);
    setLastFallbackReason(null);
  }, [clearPendingWork]);

  const updateSettings = useCallback((update: Partial<LiveTranslationSettings>) => {
    setSettings((previous) => {
      const next = { ...previous, ...update, sourceLanguage: 'auto' as const };
      saveLiveTranslationSettings(next);
      return next;
    });
  }, []);


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

  useEffect(() => {
    let disposed = false;
    let disposeDelta: (() => void) | undefined;
    let disposeStatus: (() => void) | undefined;
    void listen<{ requestId: string; text: string; provider?: string; model?: string; firstWordLatencyMs?: number }>(
      'live-translation-delta',
      (event) => {
        const job = activeJobsRef.current.get(event.payload.requestId);
        if (!job || !isCurrentJob(job)) return;
        setTranslations((previous) => ({
          ...previous,
          [job.segmentKey]: {
            ...(previous[job.segmentKey] ?? {}),
            segmentKey: job.segmentKey,
            sourceText: job.text,
            targetLanguage: job.targetLanguage,
            status: 'translating',
            translatedText: event.payload.text,
            provider: event.payload.provider,
            model: event.payload.model,
            firstWordLatencyMs: event.payload.firstWordLatencyMs,
          },
        }));
        if (event.payload.provider) setLastProvider(event.payload.provider);
        if (event.payload.model) setLastModel(event.payload.model);
        if (event.payload.firstWordLatencyMs !== undefined) setLastFirstWordLatencyMs(event.payload.firstWordLatencyMs);
      }
    ).then((dispose) => disposed ? dispose() : (disposeDelta = dispose));

    void listen<{
      requestId: string;
      event: 'started' | 'fallback';
      provider?: string;
      model?: string;
      reason?: string;
      nextProvider?: string;
      nextModel?: string;
    }>('live-translation-status', (event) => {
      const job = activeJobsRef.current.get(event.payload.requestId);
      if (!job || !isCurrentJob(job)) return;
      if (event.payload.event === 'started') {
        if (event.payload.provider) setLastProvider(event.payload.provider);
        if (event.payload.model) setLastModel(event.payload.model);
        return;
      }
      const reason = event.payload.reason ?? 'Provider was too slow or unavailable';
      setLastFallbackReason(reason);
      setTranslations((previous) => ({
        ...previous,
        [job.segmentKey]: {
          ...(previous[job.segmentKey] ?? {}),
          segmentKey: job.segmentKey,
          sourceText: job.text,
          targetLanguage: job.targetLanguage,
          status: 'translating',
          translatedText: undefined,
          fallbackReason: reason,
          provider: event.payload.nextProvider,
          model: event.payload.nextModel,
        },
      }));
    }).then((dispose) => disposed ? dispose() : (disposeStatus = dispose));

    return () => {
      disposed = true;
      disposeDelta?.();
      disposeStatus?.();
    };
  }, [isCurrentJob]);

  useEffect(() => {
    mountedRef.current = true;
    setSettings(loadLiveTranslationSettings());
    return () => {
      mountedRef.current = false;
      clearPendingWork();
    };
  }, [clearPendingWork]);

  useEffect(() => {
    clearPendingWork();
    setTranslations({});
    setLastError(null);
    if (settings.enabled) {
      void invoke('api_prepare_live_translation', {
        translationEngine: settings.engine,
        speedMode: settings.speed,
        modelOverride: settings.modelOverride || null,
      }).catch(() => undefined);
    }
  }, [
    settings.enabled,
    settings.sourceLanguage,
    settings.targetLanguage,
    settings.engine,
    settings.speed,
    settings.modelOverride,
    settings.contextTurns,
    settings.glossary,
    settings.contextHint,
    clearPendingWork,
  ]);


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
                .join('
');
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
            ].join(''),
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

  useEffect(() => {
    if (!settings.enabled || transcripts.length === 0) return;
    const start = Math.max(0, transcripts.length - BACKFILL_SEGMENT_LIMIT);
    const candidates = transcripts.slice(start);
    candidates.forEach((transcript, offset) => {
      const text = transcript.text.trim();
      if (!text) return;
      const index = start + offset;
      const segmentKey = liveTranslationSegmentKey(transcript);
      const contextText = contextForTurn(transcripts, index, settings.contextTurns);
      const revision = [
        generationRef.current,
        settings.targetLanguage,
        settings.engine,
        settings.speed,
        settings.modelOverride,
        settings.contextTurns,
        settings.glossary,
        settings.contextHint,
        contextText,
        text,
      ].join('\u0001');
      if (latestRevisionRef.current.get(segmentKey) === revision) return;
      latestRevisionRef.current.set(segmentKey, revision);
      const activeRequestId = activeRequestIdsRef.current.get(segmentKey);
      if (activeRequestId) cancelNativeRequest(activeRequestId);
      enqueueJob({
        segmentKey,
        text,
        revision,
        requestId: `live-v2-${Date.now()}-${requestCounterRef.current++}`,
        sourceLanguage: 'auto',
        targetLanguage: settings.targetLanguage,
        generation: generationRef.current,
        translationEngine: settings.engine,
        speedMode: settings.speed,
        modelOverride: settings.modelOverride,
        contextText,
        glossary: settings.glossary,
        contextHint: settings.contextHint,
      });
    });
  }, [transcripts, settings, cancelNativeRequest, enqueueJob]);


const translatedCount = useMemo(
  () => Object.entries(translations).filter(
    ([key, entry]) => !key.startsWith('live-preview-') && entry.status === 'translated'
  ).length,
  [translations]
);
const previewTranslation = livePreview
  ? translations[`live-preview-${livePreview.source}`]
  : undefined;

  return {
    settings,
    translations,
    updateSettings,
    clearTranslations,
    queuedCount,
    activeCount,
    translatedCount,
    lastError,
    lastProvider,
    lastModel,
    lastLatencyMs,
    lastFirstWordLatencyMs,
    lastFallbackReason,
    previewTranslation,
  };
}
