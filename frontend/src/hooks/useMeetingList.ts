'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  MeetingListItem,
  MeetingListPage,
  MeetingListRequest,
  MeetingListSort,
} from '@/types/meeting';

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 120;

interface UseMeetingListOptions {
  query: string;
  sort: MeetingListSort;
  starredOnly: boolean;
}

interface UseMeetingListResult {
  items: MeetingListItem[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  patchItem: (meetingId: string, patch: Partial<MeetingListItem>) => void;
  removeItems: (meetingIds: readonly string[]) => void;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

function mergeUniqueMeetings(
  current: MeetingListItem[],
  incoming: MeetingListItem[],
): MeetingListItem[] {
  if (current.length === 0) return incoming;
  const known = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !known.has(item.id))];
}

export function useMeetingList({
  query,
  sort,
  starredOnly,
}: UseMeetingListOptions): UseMeetingListResult {
  const [debouncedQuery, setDebouncedQuery] = useState(query.trim());
  const [items, setItems] = useState<MeetingListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const requestKeyRef = useRef('');

  useEffect(() => {
    const trimmed = query.trim();
    const timer = window.setTimeout(
      () => setDebouncedQuery(trimmed),
      trimmed ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [query]);

  const requestKey = useMemo(
    () => JSON.stringify({ query: debouncedQuery, sort, starredOnly }),
    [debouncedQuery, sort, starredOnly],
  );

  const runPageRequest = useCallback(async (
    cursor: string | undefined,
    replace: boolean,
  ) => {
    const generation = ++requestGenerationRef.current;
    const keyAtStart = requestKey;
    requestKeyRef.current = keyAtStart;

    if (replace) {
      setIsLoading(true);
      setError(null);
    } else {
      setIsLoadingMore(true);
    }

    const request: MeetingListRequest = {
      cursor,
      limit: PAGE_SIZE,
      query: debouncedQuery || undefined,
      sort,
      starredOnly: starredOnly || undefined,
    };

    try {
      const page = await invoke<MeetingListPage>('api_list_meetings', { request });
      if (
        generation !== requestGenerationRef.current ||
        keyAtStart !== requestKeyRef.current
      ) {
        return;
      }

      setItems((current) => replace ? page.items : mergeUniqueMeetings(current, page.items));
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (requestError) {
      if (
        generation !== requestGenerationRef.current ||
        keyAtStart !== requestKeyRef.current
      ) {
        return;
      }
      const message = messageFromError(requestError);
      console.error('[MeetingLibrary] Failed to load meetings:', requestError);
      setError(message);
      if (replace) {
        setItems([]);
        setNextCursor(undefined);
      }
    } finally {
      if (
        generation === requestGenerationRef.current &&
        keyAtStart === requestKeyRef.current
      ) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, [debouncedQuery, requestKey, sort, starredOnly]);

  useEffect(() => {
    requestKeyRef.current = requestKey;
    requestGenerationRef.current += 1;
    setItems([]);
    setNextCursor(undefined);
    void runPageRequest(undefined, true);
  }, [requestKey, runPageRequest]);

  const refresh = useCallback(async () => {
    await runPageRequest(undefined, true);
  }, [runPageRequest]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoading || isLoadingMore) return;
    await runPageRequest(nextCursor, false);
  }, [isLoading, isLoadingMore, nextCursor, runPageRequest]);

  const patchItem = useCallback((
    meetingId: string,
    patch: Partial<MeetingListItem>,
  ) => {
    setItems((current) => current.map((item) => (
      item.id === meetingId ? { ...item, ...patch } : item
    )));
  }, []);

  const removeItems = useCallback((meetingIds: readonly string[]) => {
    const ids = new Set(meetingIds);
    setItems((current) => current.filter((item) => !ids.has(item.id)));
  }, []);

  return {
    items,
    isLoading,
    isLoadingMore,
    error,
    hasMore: Boolean(nextCursor),
    refresh,
    loadMore,
    patchItem,
    removeItems,
  };
}
