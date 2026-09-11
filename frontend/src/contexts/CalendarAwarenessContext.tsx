'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isPermissionGranted, sendNotification } from '@tauri-apps/plugin-notification';
import { calendarService, type CalendarEvent, type CalendarPermissionStatus } from '@/services/calendarService';

const ENABLED_KEY = 'meetodds.calendar-awareness.enabled.v1';
const DISMISSED_KEY = 'meetodds.calendar-awareness.dismissed.v1';
const NOTIFIED_KEY = 'meetodds.calendar-awareness.notified.v1';

interface CalendarAwarenessValue {
  permission: CalendarPermissionStatus | null;
  enabled: boolean;
  events: CalendarEvent[];
  suggestedEvent: CalendarEvent | null;
  nextEvent: CalendarEvent | null;
  recordingEvent: CalendarEvent | null;
  isLoading: boolean;
  error: string | null;
  requestAccess: () => Promise<void>;
  refresh: () => Promise<void>;
  setEnabled: (enabled: boolean) => void;
  dismissEvent: (eventId: string) => void;
  setRecordingEvent: (event: CalendarEvent | null) => void;
}

const CalendarAwarenessContext = createContext<CalendarAwarenessValue | null>(null);

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch { return fallback; }
}

function readStringSet(key: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch { return new Set(); }
}

function persistStringSet(key: string, values: Set<string>) {
  try { sessionStorage.setItem(key, JSON.stringify([...values])); } catch { /* Session preference only. */ }
}

function selectSuggested(events: CalendarEvent[], dismissed: Set<string>, nowMs: number): CalendarEvent | null {
  const relevant = events.filter(event => !dismissed.has(event.id) && !event.allDay && event.endAtMs > nowMs - 15 * 60_000);
  const live = relevant.find(event => nowMs >= event.startAtMs - 5 * 60_000 && nowMs <= event.endAtMs + 10 * 60_000);
  if (live) return live;
  const next = relevant.find(event => event.startAtMs >= nowMs);
  return next && next.startAtMs - nowMs <= 15 * 60_000 ? next : null;
}

export function CalendarAwarenessProvider({ children }: { children: ReactNode }) {
  const [permission, setPermission] = useState<CalendarPermissionStatus | null>(null);
  const [enabled, setEnabledState] = useState(true);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [recordingEvent, setRecordingEvent] = useState<CalendarEvent | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const refreshing = useRef<Promise<void> | null>(null);

  useEffect(() => {
    alive.current = true;
    setEnabledState(readBoolean(ENABLED_KEY, true));
    setDismissed(readStringSet(DISMISSED_KEY));
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (refreshing.current) return refreshing.current;
    const work = async () => {
      try {
        const status = await calendarService.permissionStatus();
        if (!alive.current) return;
        setPermission(status);
        if (!enabled || status.status !== 'authorized') {
          setEvents([]);
          setError(null);
          return;
        }
        setIsLoading(true);
        const now = Date.now();
        const values = await calendarService.listEvents(new Date(now - 30 * 60_000), new Date(now + 24 * 60 * 60_000));
        if (!alive.current) return;
        setEvents(values.filter(event => !event.allDay && event.endAtMs > event.startAtMs));
        setError(null);
      } catch (failure) {
        if (!alive.current) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (alive.current) setIsLoading(false);
        refreshing.current = null;
      }
    };
    refreshing.current = work();
    return refreshing.current;
  }, [enabled]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    const focus = () => void refresh();
    const visibility = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [refresh]);

  const requestAccess = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const status = await calendarService.requestAccess();
      if (!alive.current) return;
      setPermission(status);
      setEnabledState(true);
      try { localStorage.setItem(ENABLED_KEY, 'true'); } catch {}
      await refresh();
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setIsLoading(false);
    }
  }, [refresh]);

  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value);
    try { localStorage.setItem(ENABLED_KEY, String(value)); } catch {}
    if (!value) setEvents([]);
  }, []);

  const dismissEvent = useCallback((eventId: string) => {
    setDismissed(previous => {
      const next = new Set(previous);
      next.add(eventId);
      persistStringSet(DISMISSED_KEY, next);
      return next;
    });
  }, []);

  const nowMs = Date.now();
  const nextEvent = useMemo(() => events.find(event => !dismissed.has(event.id) && event.endAtMs > nowMs) ?? null, [events, dismissed, nowMs]);
  const suggestedEvent = useMemo(() => selectSuggested(events, dismissed, nowMs), [events, dismissed, nowMs]);

  useEffect(() => {
    if (!suggestedEvent || suggestedEvent.startAtMs - Date.now() > 2 * 60_000) return;
    const notified = readStringSet(NOTIFIED_KEY);
    if (notified.has(suggestedEvent.id)) return;
    notified.add(suggestedEvent.id);
    persistStringSet(NOTIFIED_KEY, notified);
    void isPermissionGranted().then(granted => {
      if (!granted) return;
      sendNotification({
        title: suggestedEvent.startAtMs <= Date.now() ? 'Meeting starting now' : 'Meeting starts soon',
        body: `${suggestedEvent.title} · MeetOdds is ready to record.`,
      });
    }).catch(() => undefined);
  }, [suggestedEvent]);

  const value = useMemo<CalendarAwarenessValue>(() => ({
    permission, enabled, events, suggestedEvent, nextEvent, recordingEvent,
    isLoading, error, requestAccess, refresh, setEnabled, dismissEvent, setRecordingEvent,
  }), [permission, enabled, events, suggestedEvent, nextEvent, recordingEvent, isLoading, error, requestAccess, refresh, setEnabled, dismissEvent]);

  return <CalendarAwarenessContext.Provider value={value}>{children}</CalendarAwarenessContext.Provider>;
}

export function useCalendarAwareness() {
  const value = useContext(CalendarAwarenessContext);
  if (!value) throw new Error('Calendar awareness provider is missing');
  return value;
}
