'use client';

import { invoke } from '@tauri-apps/api/core';
import { CalendarDays, ChevronRight, ExternalLink, LoaderCircle, Video, X } from 'lucide-react';
import { useCalendarAwareness } from '@/contexts/CalendarAwarenessContext';
import type { CalendarEvent } from '@/services/calendarService';

function clock(value: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function relativeStart(event: CalendarEvent, now = Date.now()) {
  const minutes = Math.round((event.startAtMs - now) / 60_000);
  if (minutes <= 0 && event.endAtMs > now) return 'Happening now';
  if (minutes <= 1) return 'Starts now';
  if (minutes < 60) return `Starts in ${minutes} min`;
  return clock(event.startAtMs);
}

export default function CalendarAgendaCard({ onStart }: { onStart: (event: CalendarEvent) => void }) {
  const calendar = useCalendarAwareness();
  const status = calendar.permission?.status;
  if (!calendar.permission) {
    return <section className="mt-6 flex min-h-[66px] items-center gap-3 rounded-[16px] border border-border bg-panel px-4 py-3" aria-label="Checking calendar">
      <LoaderCircle className="h-4 w-4 animate-spin text-3 motion-reduce:animate-none" />
      <span className="text-[11px] text-3">Checking your local calendar…</span>
    </section>;
  }
  if (status === 'unsupported' || calendar.enabled === false) return null;

  if (status === 'notDetermined') {
    return <section className="mt-6 rounded-[16px] border border-border bg-panel p-4" aria-label="Calendar awareness">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-accent-soft text-accent"><CalendarDays className="h-[18px] w-[18px]" /></div>
        <div className="min-w-0 flex-1"><h2 className="text-[12.5px] font-semibold text-text">Know what meeting is next</h2><p className="mt-0.5 text-[11px] leading-5 text-2">Connect Apple Calendar so MeetOdds can surface the right meeting and title the recording automatically. Event details stay on this Mac.</p></div>
        <button type="button" disabled={calendar.isLoading} onClick={() => void calendar.requestAccess()} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] bg-text px-3 text-[11px] font-semibold text-bg disabled:opacity-50">{calendar.isLoading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <CalendarDays className="h-3.5 w-3.5" />}Connect</button>
      </div>
      {calendar.error && <p role="alert" className="mt-3 text-[11px] text-danger">{calendar.error}</p>}
    </section>;
  }

  if (status === 'denied' || status === 'restricted' || status === 'writeOnly') {
    return <section className="mt-6 flex items-center gap-3 rounded-[16px] border border-border bg-panel px-4 py-3" aria-label="Calendar awareness unavailable">
      <CalendarDays className="h-4 w-4 shrink-0 text-3" />
      <div className="min-w-0 flex-1"><p className="text-[12px] font-medium text-text">Calendar awareness is off</p><p className="mt-0.5 text-[10.5px] text-3">Grant full calendar access to get one-click meeting detection.</p></div>
      <button type="button" onClick={() => void invoke('open_system_settings', { preference_pane: 'Privacy_Calendars' })} className="inline-flex h-8 items-center gap-1 rounded-[9px] border border-border bg-panel-2 px-2.5 text-[10.5px] font-medium text-2">Settings <ChevronRight className="h-3 w-3" /></button>
    </section>;
  }

  const event = calendar.suggestedEvent ?? calendar.nextEvent;
  if (!event) return <section className="mt-6 flex items-center gap-3 rounded-[16px] border border-border bg-panel px-4 py-3" aria-label="Calendar clear">
    <div className="grid h-8 w-8 place-items-center rounded-[10px] bg-panel-2 text-3"><CalendarDays className="h-4 w-4" /></div>
    <div className="min-w-0 flex-1"><p className="text-[11.5px] font-medium text-text">Calendar is clear</p><p className="mt-0.5 text-[10.5px] text-3">No meetings in the next 24 hours.</p></div>
    <button type="button" onClick={() => void calendar.refresh()} disabled={calendar.isLoading} className="text-[10.5px] font-medium text-accent disabled:opacity-40">Refresh</button>
  </section>;

  const soon = calendar.suggestedEvent?.id === event.id;
  return <section className={`mt-6 overflow-hidden rounded-[16px] border bg-panel ${soon ? 'border-accent/40 shadow-[0_8px_24px_rgba(204,72,5,.08)]' : 'border-border'}`} aria-label="Upcoming calendar meeting">
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-[12px] ${soon ? 'bg-accent text-accent-foreground' : 'bg-panel-2 text-2'}`}>{event.conferenceUrl ? <Video className="h-[18px] w-[18px]" /> : <CalendarDays className="h-[18px] w-[18px]" />}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className={`font-mono text-[9.5px] font-semibold uppercase tracking-[.08em] ${soon ? 'text-accent' : 'text-3'}`}>{soon ? relativeStart(event) : 'Up next'}</span><span className="font-mono text-[9.5px] text-3">{clock(event.startAtMs)}–{clock(event.endAtMs)}</span></div>
        <h2 className="mt-1 truncate text-[13.5px] font-semibold tracking-[-.015em] text-text">{event.title}</h2>
        <p className="mt-0.5 truncate text-[10.5px] text-3">{event.location || event.calendarName || (event.attendeeCount ? `${event.attendeeCount} attendees` : 'Calendar event')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {event.conferenceUrl && <button type="button" onClick={() => void invoke('open_external_url', { url: event.conferenceUrl })} className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-border bg-panel-2 px-3 text-[10.5px] font-semibold text-2 hover:text-text"><ExternalLink className="h-3.5 w-3.5" />Join</button>}
        <button type="button" onClick={() => onStart(event)} className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-accent px-3.5 text-[11px] font-semibold text-accent-foreground shadow-[0_5px_14px_rgba(204,72,5,.14)]"><span className="h-1.5 w-1.5 rounded-full bg-current" />Record</button>
        <button type="button" onClick={() => calendar.dismissEvent(event.id)} className="inline-grid h-8 w-8 place-items-center rounded-[9px] text-3 hover:bg-[var(--hover)] hover:text-text" aria-label={`Dismiss ${event.title}`} title="Not this meeting"><X className="h-3.5 w-3.5" /></button>
      </div>
    </div>
    {calendar.error && <div className="border-t border-border px-4 py-2 text-[10.5px] text-warn">Calendar refresh issue: {calendar.error}</div>}
  </section>;
}
