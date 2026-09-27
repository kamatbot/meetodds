'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { Check, ExternalLink, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useNoteDraft } from '@/hooks/useNoteDraft';
import {
  closeManualNotesWindow,
  getManualNotes,
  saveManualNotes,
} from '@/services/manualNotesService';
import type { CalendarEvent } from '@/services/calendarService';
import type { NoteValue } from '@/types/moment-notes';
import MarkdownNoteEditor, {
  type MarkdownNoteEditorHandle,
} from '@/components/Notes/MarkdownNoteEditor';

export const LIVE_NOTE_REQUEST_EVENT = 'meetodds:live-note-request';

interface LiveNoteRequest {
  meetingId: string;
  appendText?: string | null;
}

/** One optional, autosaving note document beside the live transcript. */
export default function LiveMeetingNotes({ meetingId, calendarEvent }: { meetingId: string; calendarEvent?: CalendarEvent | null }) {
  const editorRef = useRef<MarkdownNoteEditorHandle>(null);
  const pendingAppend = useRef<string | null | undefined>(undefined);

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

  const saveNow = () => { void draft.flush().catch(() => undefined); };
  const linkedMoments = useMemo(() => new Set([...draft.value.markdown.matchAll(/<!--\s*\[([0-9:]+)\]\s*-->/g)].map(match => match[1])).size, [draft.value.markdown]);
  const status = draft.status === 'loading' ? 'Opening…'
    : draft.status === 'saving' ? 'Saving…'
    : draft.status === 'saved' ? 'Saved on Mac'
    : draft.status === 'dirty' ? 'Unsaved' : 'Needs attention';

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg" aria-label="Meeting notes">
      <header className="shrink-0 border-b border-border px-6 pb-4 pt-5">
        <div className="mx-auto flex w-full max-w-[800px] items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[12px] font-semibold text-text">Your notes</h1>
            <p className="mt-1 text-[11px] leading-4 text-3">Optional context for your summary · Original transcript unchanged</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] text-3" role="status" aria-live="polite">
              {draft.status === 'loading' || draft.status === 'saving' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : draft.status === 'saved' ? <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : null}
              {status}
            </span>
            {linkedMoments > 0 && <span className="text-[11px] text-3">{linkedMoments} linked {linkedMoments === 1 ? 'moment' : 'moments'}</span>}
          </div>
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-[800px] flex-1 flex-col overflow-y-auto px-6 pb-8 pt-4 custom-scrollbar">
        {draft.storageWarning && <p role="alert" className="mb-3 rounded-xl border border-warn/30 bg-panel p-3 text-xs text-warn">Local draft recovery is unavailable. Keep MeetOdds open until this note shows Saved.</p>}
        {draft.recovered && <p role="status" className="mb-3 text-xs text-2">Recovered your unsaved live-meeting draft.</p>}
        {draft.error && <div role="alert" className="mb-4 flex items-start gap-3 rounded-xl border border-danger/25 bg-panel p-4 text-xs text-danger"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><div className="min-w-0 flex-1"><p>{draft.error}</p><button type="button" className="mt-2 font-semibold underline underline-offset-2" onClick={draft.retry}>Retry</button></div></div>}
        {calendarEvent?.conferenceUrl && <button type="button" aria-label="Open meeting call" title="Open meeting call" onClick={() => void invoke('open_external_url', { url: calendarEvent.conferenceUrl }).catch(() => undefined)} className="mb-3 inline-flex h-7 w-fit items-center gap-1 rounded-md px-2 text-[11px] font-medium text-2 hover:bg-panel-2 hover:text-text"><ExternalLink className="h-3 w-3" />Open call</button>}

        <MarkdownNoteEditor
          ref={editorRef}
          value={draft.value.markdown}
          readOnly={!draft.ready}
          onChange={markdown => draft.change({ markdown })}
          onSave={saveNow}
          variant="live"
          placeholder="Add a note for yourself…"
        />
      </div>
    </section>
  );
}
