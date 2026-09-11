import type { CalendarEvent } from '@/services/calendarService';

const MINUTE = 60_000;

/**
 * A meeting becomes a one-click suggestion shortly before it starts and remains
 * suggested through the active meeting. We intentionally do not auto-record:
 * recording consent is still an explicit user action.
 */
export function selectSuggestedCalendarEvent(
  events: CalendarEvent[],
  dismissedIds: ReadonlySet<string>,
  nowMs: number,
): CalendarEvent | null {
  const relevant = events
    .filter(event => !dismissedIds.has(event.id) && !event.allDay && event.endAtMs > nowMs - 15 * MINUTE)
    .sort((a, b) => a.startAtMs - b.startAtMs);

  const active = relevant.find(event => nowMs >= event.startAtMs - 5 * MINUTE && nowMs <= event.endAtMs + 10 * MINUTE);
  if (active) return active;

  const next = relevant.find(event => event.startAtMs >= nowMs);
  return next && next.startAtMs - nowMs <= 15 * MINUTE ? next : null;
}

export function selectNextCalendarEvent(
  events: CalendarEvent[],
  dismissedIds: ReadonlySet<string>,
  nowMs: number,
): CalendarEvent | null {
  return events
    .filter(event => !dismissedIds.has(event.id) && !event.allDay && event.endAtMs > nowMs)
    .sort((a, b) => a.startAtMs - b.startAtMs)[0] ?? null;
}

export function shouldNotifyForCalendarEvent(event: CalendarEvent, nowMs: number): boolean {
  const untilStart = event.startAtMs - nowMs;
  return event.endAtMs > nowMs && untilStart <= 2 * MINUTE && untilStart >= -10 * MINUTE;
}
