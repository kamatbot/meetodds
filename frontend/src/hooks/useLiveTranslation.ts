'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Transcript } from '@/types';
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
const MAX_QUEUED_TRANSLATIONS = 48;
const BACKFILL_SEGMENT_LIMIT = 24;
const PARTIAL_TRANSLATION_DEBOUNCE_MS = 220;
const MIN_PARTIAL_CHARACTERS = 12;
const RESULT_CACHE_LIMIT = 300;

interface TranslationJob {
  segmentKey: string;
  text: string;
  revision: string;
  requestId: string;
  sourceLanguage: 'auto';
  targetLanguage: string;
  generation: number;
  isPartial: boolean;
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
}

function translationCacheKey(
  sourceLanguage: string,
  targetLanguage: string,
  text: string
): string {
  return `${sourceLanguage}\u0000${targetLanguage}\u0000${text}`;
}

function trimResultCache(cache: Map<string, LiveTranslationResponse>): void {
  while (cache.size > RESULT_CACHE_LIMIT) {
    const firstKey = cache.keys().next().value as string | undefined;
    if (!firstKey) return;
    cache.delete(firstKey);
  }
}

export function useLiveTranslation(transcripts: Transcript[]): LiveTranslationState {
  const [settings, setSettings] = useState<LiveTranslationSettings>(() =>
    typeof window === 'undefined'
      ? DEFAULT_LIVE_TRANSLATION_SETTINGS
      : loadLiveTranslationSettings()
  );
  const [translations, setTranslations] = useState<Record<string, LiveTranslationEntry>>({});
  const [queuedCount, setQueuedCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [lastModel, setLastModel] = useState<string | null>(null);
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);

  const mountedRef = useRef(true);
  const queueRef = useRef<TranslationJob[]>([]);
  const activeCountRef = useRef(0);
  const generationRef = useRef(0);
  const requestCounterRef = useRef(0);
  const latestRevisionRef = useRef(new Map<string, string>());
  const partialTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const activeRequestIdsRef = useRef(new Map<string, string>());
  const resultCacheRef = useRef(new Map<string, LiveTranslationResponse>());
  const drainQueueRef = useRef<() => void>(() => undefined);

  const updateCounts = useCallback(() => {
    if (!mountedRef.current) return;
    setQueuedCount(queueRef.current.length);
    setActiveCount(activeCountRef.current);
  }, []);

  const isCurrentJob = useCallback((job: TranslationJob): boolean => {
    return (
      mountedRef.current &&
      job.generation === generationRef.current &&
      latestRevisionRef.current.get(job.segmentKey) === job.revision
    );
  }, []);

  const cancelNativeRequest = useCallback((requestId: string | undefined) => {
    if (!requestId) return;
    void invoke<boolean>('api_cancel_live_translation', { requestId }).catch(() => undefined);
  }, []);

  const drainQueue = useCallback(() => {
    while (
      activeCountRef.current < MAX_CONCURRENT_TRANSLATIONS &&
      queueRef.current.length > 0
    ) {
      const job = queueRef.current.shift()!;
      if (!isCurrentJob(job)) continue;

      activeCountRef.current += 1;
      activeRequestIdsRef.current.set(job.segmentKey, job.requestId);
      updateCounts();

      setTranslations((previous) => {
        const previousEntry = previous[job.segmentKey];
        const sourceMatches =
          previousEntry?.sourceText === job.text &&
          previousEntry?.targetLanguage === job.targetLanguage;

        return {
          ...previous,
          [job.segmentKey]: {
            segmentKey: job.segmentKey,
            sourceText: job.text,
            targetLanguage: job.targetLanguage,
            status: 'translating',
            translatedText: sourceMatches ? previousEntry?.translatedText : undefined,
            provider: sourceMatches ? previousEntry?.provider : undefined,
            model: sourceMatches ? previousEntry?.model : undefined,
            latencyMs: sourceMatches ? previousEntry?.latencyMs : undefined,
            cached: sourceMatches ? previousEntry?.cached : undefined,
          },
        };
      });

      void (async () => {
        try {
          const cacheKey = translationCacheKey(
            job.sourceLanguage,
            job.targetLanguage,
            job.text
          );
          const cached = resultCacheRef.current.get(cacheKey);
          const response = cached ?? await invoke<LiveTranslationResponse>(
            'api_translate_live_text',
            {
              requestId: job.requestId,
              text: job.text,
              sourceLanguage: job.sourceLanguage,
              targetLanguage: job.targetLanguage,
            }
          );

          if (!cached) {
            resultCacheRef.current.set(cacheKey, response);
            trimResultCache(resultCacheRef.current);
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
              latencyMs: response.latencyMs,
              cached: response.cached || Boolean(cached),
            },
          }));
          setLastError(null);
          setLastProvider(response.provider);
          setLastModel(response.model);
          setLastLatencyMs(response.latencyMs);
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

    queueRef.current = queueRef.current.filter(
      (queued) => queued.segmentKey !== job.segmentKey
    );

    if (queueRef.current.length >= MAX_QUEUED_TRANSLATIONS) {
      const oldestPartialIndex = queueRef.current.findIndex((queued) => queued.isPartial);
      if (oldestPartialIndex >= 0) {
        queueRef.current.splice(oldestPartialIndex, 1);
      } else {
        queueRef.current.shift();
      }
    }

    if (job.isPartial) {
      queueRef.current.push(job);
    } else {
      const firstPartialIndex = queueRef.current.findIndex((queued) => queued.isPartial);
      if (firstPartialIndex >= 0) {
        queueRef.current.splice(firstPartialIndex, 0, job);
      } else {
        queueRef.current.push(job);
      }
    }

    updateCounts();
    drainQueueRef.current();
  }, [isCurrentJob, updateCounts]);

  const clearPendingWork = useCallback(() => {
    generationRef.current += 1;

    for (const timer of partialTimersRef.current.values()) {
      clearTimeout(timer);
    }
    partialTimersRef.current.clear();
    queueRef.current = [];

    for (const requestId of activeRequestIdsRef.current.values()) {
      cancelNativeRequest(requestId);
    }
    activeRequestIdsRef.current.clear();
    latestRevisionRef.current.clear();
    updateCounts();
  }, [cancelNativeRequest, updateCounts]);

  const clearTranslations = useCallback(() => {
    clearPendingWork();
    setTranslations({});
    setLastError(null);
    setLastLatencyMs(null);
  }, [clearPendingWork]);

  const updateSettings = useCallback((update: Partial<LiveTranslationSettings>) => {
    setSettings((previous) => {
      const next: LiveTranslationSettings = {
        ...previous,
        ...update,
        sourceLanguage: 'auto',
      };
      saveLiveTranslationSettings(next);
      return next;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPendingWork();
    };
  }, [clearPendingWork]);

  useEffect(() => {
    clearPendingWork();
    setTranslations({});
    setLastError(null);
  }, [settings.enabled, settings.sourceLanguage, settings.targetLanguage, clearPendingWork]);

  useEffect(() => {
    if (!settings.enabled || transcripts.length === 0) return;

    const candidates = transcripts.slice(-BACKFILL_SEGMENT_LIMIT);

    for (const transcript of candidates) {
      const text = transcript.text.trim();
      if (!text) continue;

      const isPartial = transcript.is_partial === true;
      if (isPartial && text.length < MIN_PARTIAL_CHARACTERS) continue;

      const segmentKey = liveTranslationSegmentKey(transcript);
      const revision = [
        generationRef.current,
        settings.sourceLanguage,
        settings.targetLanguage,
        isPartial ? 'partial' : 'final',
        text,
      ].join('\u0001');

      if (latestRevisionRef.current.get(segmentKey) === revision) continue;
      latestRevisionRef.current.set(segmentKey, revision);

      const existingTimer = partialTimersRef.current.get(segmentKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
        partialTimersRef.current.delete(segmentKey);
      }

      const activeRequestId = activeRequestIdsRef.current.get(segmentKey);
      if (activeRequestId) {
        cancelNativeRequest(activeRequestId);
      }

      queueRef.current = queueRef.current.filter(
        (queued) => queued.segmentKey !== segmentKey
      );

      const job: TranslationJob = {
        segmentKey,
        text,
        revision,
        requestId: `live-${Date.now()}-${requestCounterRef.current++}`,
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage,
        generation: generationRef.current,
        isPartial,
      };

      setTranslations((previous) => {
        const previousEntry = previous[segmentKey];
        const sourceMatches =
          previousEntry?.sourceText === text &&
          previousEntry?.targetLanguage === settings.targetLanguage;

        return {
          ...previous,
          [segmentKey]: {
            segmentKey,
            sourceText: text,
            targetLanguage: settings.targetLanguage,
            status: 'queued',
            translatedText: sourceMatches ? previousEntry?.translatedText : undefined,
            provider: sourceMatches ? previousEntry?.provider : undefined,
            model: sourceMatches ? previousEntry?.model : undefined,
            latencyMs: sourceMatches ? previousEntry?.latencyMs : undefined,
            cached: sourceMatches ? previousEntry?.cached : undefined,
          },
        };
      });

      if (isPartial) {
        const timer = setTimeout(() => {
          partialTimersRef.current.delete(segmentKey);
          enqueueJob(job);
        }, PARTIAL_TRANSLATION_DEBOUNCE_MS);
        partialTimersRef.current.set(segmentKey, timer);
      } else {
        enqueueJob(job);
      }
    }
  }, [
    transcripts,
    settings.enabled,
    settings.sourceLanguage,
    settings.targetLanguage,
    cancelNativeRequest,
    enqueueJob,
  ]);

  const translatedCount = useMemo(
    () => Object.values(translations).filter((entry) => entry.status === 'translated').length,
    [translations]
  );

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
  };
}
