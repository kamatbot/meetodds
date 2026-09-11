'use client';

import { useCallback, useEffect, useRef } from 'react';
import { emit } from '@tauri-apps/api/event';
import { Check, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useNoteDraft } from '@/hooks/useNoteDraft';
import {
  closeManualNotesWindow,
  getManualNotes,
  saveManualNotes,
} from '@/services/manualNotesService';
import type { NoteValue } from '@/types/moment-notes';
import MarkdownNoteEditor, {
  type MarkdownNoteEditorHandle,
} from '@/components/Notes/MarkdownNoteEditor';

export const LIVE_NOTE_REQUEST_EVENT = 'meetodds:live-note-request';

interface LiveNoteRequest {
  meetingId: string;
  appendText?: string | null;
}

/**
 * The in-meeting notebook uses the same manual-notes document as the optional
 * pop-out window. It intentionally does not use api_get_meeting_notes: that
 * saved-meeting document can lag the active recording lifecycle.
 */
export default function LiveMeetingNotes({ meetingId }: { meetingId: string }) {
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
      const marker = appendText.trim();
      const current = draft.value.markdown || '';
      // A timestamp marker identifies one transcript moment. Repeated clicks
      // focus the existing notebook instead of creating duplicate anchors.
      if (!current.includes(marker)) {
        const trimmed = current.trimEnd();
        draft.change({
          markdown: trimmed ? `${trimmed}\n\n${marker}\n` : `${marker}\n`,
        });
      }
    }
    focusEditor();
  }, [draft, focusEditor]);

  // The embedded editor is now the default live-notes surface. Close a legacy
  // notes window left open when this recording workspace first mounts. A later
  // explicit "Pop out" action can reopen it and is never auto-closed.
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

  const saveNow = () => {
    void draft.flush().catch(() => undefined);
  };

  const status = draft.status === 'loading' ? 'Opening…'
    : draft.status === 'saving' ? 'Saving…'
    : draft.status === 'saved' ? 'Saved on Mac'
    : draft.status === 'dirty' ? 'Unsaved' : 'Save needed';

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg" aria-label="Meeting notes">
      <header className="flex min-h-[48px] shrink-0 items-center justify-between gap-4 border-b border-border px-8">
        <span className="horizon-eyebrow">Private markdown notes · stored on this device</span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-3" role="status" aria-live="polite">
          {draft.status === 'loading' || draft.status === 'saving' ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : draft.status === 'saved' ? (
            <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          ) : null}
          {status}
        </span>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col overflow-y-auto px-8 pb-8 pt-5 custom-scrollbar">
        {draft.storageWarning && (
          <p role="alert" className="mb-3 rounded-xl border border-warn/30 bg-surface p-3 text-xs text-warn">
            Local draft recovery is unavailable. Keep MeetOdds open until this note shows Saved.
          </p>
        )}
        {draft.recovered && (
          <p role="status" className="mb-3 text-xs text-2">Recovered your unsaved live-meeting draft.</p>
        )}
        {draft.error && (
          <div role="alert" className="mb-4 flex items-start gap-3 rounded-xl border border-danger/25 bg-surface p-4 text-xs text-danger">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p>{draft.error}</p>
              <button type="button" className="mt-2 font-semibold underline underline-offset-2" onClick={draft.retry}>Retry</button>
            </div>
          </div>
        )}

        <MarkdownNoteEditor
          ref={editorRef}
          value={draft.value.markdown}
          readOnly={!draft.ready}
          onChange={markdown => draft.change({ markdown })}
          onSave={saveNow}
        />
      </div>
    </section>
  );
}
