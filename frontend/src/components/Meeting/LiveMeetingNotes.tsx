'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import {
  Bookmark, CalendarDays, Check, CheckCircle2, CircleHelp, Clock3, ExternalLink,
  ListChecks, LoaderCircle, MapPin, TriangleAlert, UsersRound,
} from 'lucide-react';
import { useNoteDraft } from '@/hooks/useNoteDraft';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useTranscriptSession } from '@/contexts/TranscriptContext';
import {
  closeManualNotesWindow,
  getManualNotes,
  saveManualNotes,
} from '@/services/manualNotesService';
import type { CalendarEvent } from '@/services/calendarService';
import { formatTimestampLabel, type NoteValue } from '@/types/moment-notes';
import MarkdownNoteEditor, {
  type MarkdownNoteEditorHandle,
} from '@/components/Notes/MarkdownNoteEditor';

export const LIVE_NOTE_REQUEST_EVENT = 'meetodds:live-note-request';

interface LiveNoteRequest {
  meetingId: string;
  appendText?: string | null;
}

type CaptureKind = 'point' | 'decision' | 'question' | 'followup';
const CAPTURE_OPTIONS: Array<{ kind: CaptureKind; label: string; Icon: typeof Bookmark; shortcut: string }> = [
  { kind: 'point', label: 'Key point', Icon: Bookmark, shortcut: '⌘⇧1' },
  { kind: 'decision', label: 'Decision', Icon: CheckCircle2, shortcut: '⌘⇧2' },
  { kind: 'question', label: 'Question', Icon: CircleHelp, shortcut: '⌘⇧3' },
  { kind: 'followup', label: 'Follow-up', Icon: ListChecks, shortcut: '⌘⇧4' },
];

function eventTime(event: CalendarEvent) {
  const formatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${formatter.format(new Date(event.startAtMs))}–${formatter.format(new Date(event.endAtMs))}`;
}

/**
 * Human-first meeting notebook. The transcript is evidence at the side; this is
 * the place to capture what the user thinks matters. It uses the same local
 * manual-notes document as post-meeting Notes and never creates AI actions live.
 */
export default function LiveMeetingNotes({ meetingId, calendarEvent }: { meetingId: string; calendarEvent?: CalendarEvent | null }) {
  const editorRef = useRef<MarkdownNoteEditorHandle>(null);
  const pendingAppend = useRef<string | null | undefined>(undefined);
  const { activeDuration, isPaused } = useRecordingState();
  const { meetingTitle } = useTranscriptSession();

  const load = useCallback(async (): Promise<NoteValue> => ({
    markdown: await getManualNotes(meetingId),
    includeInSummary: true,
    revision: 0,
  }), [meetingId]);

  const write = useCallback(async (base: NoteValue, next: NoteValue): Promise<NoteValue> => {
    // Compare against the text we loaded so an explicitly popped-out editor can
    // never be silently overwritten by an older embedded draft.
    await saveManualNotes(meetingId, next.markdown, base.markdown);
    await emit('manual-notes:saved', { meetingId }).catch(() => undefined);
    return { ...next, revision: base.revision + 1 };
  }, [meetingId]);

  const draft = useNoteDraft(`meeting:${meetingId}`, load, write);

  const focusEditor = useCallback(() => {
    requestAnimationFrame(() => editorRef.current?.focusAndScrollEnd());
  }, []);

  const appendAndFocus = useCallback((appendText?: string | null) => {
    if (!draft.ready) {
      pendingAppend.current = appendText ?? null;
      return;
    }

    if (appendText?.trim()) {
      const block = appendText.trimEnd();
      const current = draft.value.markdown || '';
      const marker = block.match(/<!--\s*\[([0-9:]+)\]\s*-->/)?.[0];
      // A timestamp marker identifies one transcript moment. Repeated clicks focus
      // the existing moment instead of producing duplicate anchors.
      if (!marker || !current.includes(marker)) {
        const trimmed = current.trimEnd();
        draft.change({ markdown: trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n` });
      }
    }
    focusEditor();
  }, [draft, focusEditor]);

  const capture = useCallback((kind: CaptureKind) => {
    if (!draft.ready) return;
    const seconds = Math.max(0, activeDuration || 0);
    const timestamp = formatTimestampLabel(seconds) || '00:00';
    const marker = `<!-- [${timestamp}] -->`;
    const current = draft.value.markdown || '';
    const prefix = current.includes(marker) ? '' : `${marker}\n`;
    const visible = kind === 'point'
      ? `**Key point · ${timestamp}** — `
      : kind === 'decision'
        ? `**Decision · ${timestamp}** — `
        : kind === 'question'
          ? `**Question · ${timestamp}** — `
          : `- [ ] **Follow-up · ${timestamp}** — `;
    const block = `${prefix}${visible}`;
    const trimmed = current.trimEnd();
    draft.change({ markdown: trimmed ? `${trimmed}\n\n${block}` : block });
    focusEditor();
  }, [activeDuration, draft, focusEditor]);

  // The embedded editor is the sole default live-notes surface. Close any legacy
  // notes window left open when this recording workspace mounts.
  useEffect(() => {
    void closeManualNotesWindow().catch(() => undefined);
  }, [meetingId]);

  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<LiveNoteRequest>).detail;
      if (!detail || detail.meetingId !== meetingId) return;
      appendAndFocus(detail.appendText);
    };
    window.addEventListener(LIVE_NOTE_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(LIVE_NOTE_REQUEST_EVENT, onRequest);
  }, [appendAndFocus, meetingId]);

  useEffect(() => {
    if (!draft.ready || pendingAppend.current === undefined) return;
    const value = pendingAppend.current;
    pendingAppend.current = undefined;
    appendAndFocus(value);
  }, [appendAndFocus, draft.ready]);

  // Fast capture should work even while the textarea has focus. These are manual
  // annotations only; they never create action-inbox records before AI summary.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.isComposing) return;
      const mapping: Record<string, CaptureKind> = { '1': 'point', '2': 'decision', '3': 'question', '4': 'followup' };
      const kind = mapping[event.key];
      if (!kind) return;
      event.preventDefault();
      capture(kind);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [capture]);

  const saveNow = () => { void draft.flush().catch(() => undefined); };
  const linkedMoments = useMemo(() => new Set([...draft.value.markdown.matchAll(/<!--\s*\[([0-9:]+)\]\s*-->/g)].map(match => match[1])).size, [draft.value.markdown]);

  const status = draft.status === 'loading' ? 'Opening…'
    : draft.status === 'saving' ? 'Saving…'
    : draft.status === 'saved' ? 'Saved on Mac'
    : draft.status === 'dirty' ? 'Unsaved' : 'Save needed';
  const title = calendarEvent?.title || (meetingTitle === '+ New Call' ? 'Live meeting notes' : meetingTitle);

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg" aria-label="Meeting notes">
      <header className="shrink-0 border-b border-border px-7 pb-4 pt-5">
        <div className="mx-auto flex w-full max-w-[800px] items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><span className="horizon-eyebrow">Live notebook</span><span className="rounded-full bg-panel-2 px-2 py-0.5 font-mono text-[9px] text-3">LOCAL</span></div>
            <h1 className="mt-2 truncate text-[22px] font-semibold tracking-[-.035em] text-text">{title}</h1>
            <p className="mt-1 text-[11px] text-3">Write what matters. The transcript stays linked at the side.</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <span className="inline-flex items-center gap-1.5 text-[10.5px] text-3" role="status" aria-live="polite">
              {draft.status === 'loading' || draft.status === 'saving' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : draft.status === 'saved' ? <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : null}
              {status}
            </span>
            {linkedMoments > 0 && <span className="font-mono text-[9px] text-3">{linkedMoments} linked {linkedMoments === 1 ? 'moment' : 'moments'}</span>}
          </div>
        </div>

        {calendarEvent && <div className="mx-auto mt-4 flex w-full max-w-[800px] flex-wrap items-center gap-x-4 gap-y-2 rounded-[12px] border border-border bg-panel px-3.5 py-2.5 text-[10.5px] text-2">
          <span className="inline-flex items-center gap-1.5 font-medium text-text"><CalendarDays className="h-3.5 w-3.5 text-accent" />Calendar</span>
          <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5 text-3" />{eventTime(calendarEvent)}</span>
          {calendarEvent.attendeeCount > 0 && <span className="inline-flex items-center gap-1.5"><UsersRound className="h-3.5 w-3.5 text-3" />{calendarEvent.attendeeCount} attendees</span>}
          {calendarEvent.location && <span className="inline-flex min-w-0 items-center gap-1.5"><MapPin className="h-3.5 w-3.5 shrink-0 text-3" /><span className="max-w-[220px] truncate">{calendarEvent.location}</span></span>}
          {calendarEvent.conferenceUrl && <button type="button" className="ml-auto inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 font-semibold text-accent hover:bg-accent-soft" onClick={() => void invoke('open_external_url', { url: calendarEvent.conferenceUrl })}><ExternalLink className="h-3 w-3" />Open call</button>}
        </div>}
      </header>

      <div className="shrink-0 border-b border-border bg-panel/50 px-7 py-2.5">
        <div className="mx-auto flex w-full max-w-[800px] items-center gap-2 overflow-x-auto">
          <span className="mr-1 shrink-0 font-mono text-[9px] uppercase tracking-[.08em] text-3">Capture</span>
          {CAPTURE_OPTIONS.map(({ kind, label, Icon, shortcut }) => <button key={kind} type="button" disabled={!draft.ready || isPaused} onClick={() => capture(kind)} title={`${label} · ${shortcut}`} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border border-border bg-panel px-2.5 text-[10.5px] font-medium text-2 transition-colors hover:border-accent/35 hover:bg-accent-soft hover:text-accent disabled:opacity-35"><Icon className="h-3.5 w-3.5" />{label}<span className="ml-0.5 hidden font-mono text-[8.5px] text-3 xl:inline">{shortcut}</span></button>)}
          <span className="ml-auto hidden shrink-0 text-[9.5px] text-3 2xl:inline">Manual annotations only · AI actions are created after the meeting</span>
        </div>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-[800px] flex-1 flex-col overflow-y-auto px-7 pb-8 pt-4 custom-scrollbar">
        {draft.storageWarning && <p role="alert" className="mb-3 rounded-xl border border-warn/30 bg-panel p-3 text-xs text-warn">Local draft recovery is unavailable. Keep MeetOdds open until this note shows Saved.</p>}
        {draft.recovered && <p role="status" className="mb-3 text-xs text-2">Recovered your unsaved live-meeting draft.</p>}
        {draft.error && <div role="alert" className="mb-4 flex items-start gap-3 rounded-xl border border-danger/25 bg-panel p-4 text-xs text-danger"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><div className="min-w-0 flex-1"><p>{draft.error}</p><button type="button" className="mt-2 font-semibold underline underline-offset-2" onClick={draft.retry}>Retry</button></div></div>}

        <MarkdownNoteEditor
          ref={editorRef}
          value={draft.value.markdown}
          readOnly={!draft.ready}
          onChange={markdown => draft.change({ markdown })}
          onSave={saveNow}
          variant="live"
          placeholder="Capture the thought you don't want to lose…"
        />
      </div>
    </section>
  );
}
