'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { ArrowLeft, Check, LoaderCircle } from 'lucide-react';
import { useNoteDraft } from '@/hooks/useNoteDraft';
import { getManualNotes, saveManualNotes, closeManualNotesWindow } from '@/services/manualNotesService';
import { getNotesWindowTarget } from '@/services/momentNotesService';
import type { NotesWindowTarget, NoteValue } from '@/types/moment-notes';
import MarkdownNoteEditor, { type MarkdownNoteEditorHandle } from './MarkdownNoteEditor';

type Flush = () => Promise<void>;
const waiting: Flush = () => Promise.reject(new Error('Notes are still opening. Retry after the editor is ready.'));
const button = 'inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-2 hover:bg-bg hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40';

function DocumentEditor({ target, flushRef, onChanged }: {
  target: NotesWindowTarget; flushRef: MutableRefObject<Flush>; onChanged: () => Promise<void>;
}) {
  const editorRef = useRef<MarkdownNoteEditorHandle>(null);
  const initialAppended = useRef(false);

  const load = useCallback(async (): Promise<NoteValue> => {
    const markdown = await getManualNotes(target.meetingId);
    return { markdown, includeInSummary: true, revision: 0 };
  }, [target.meetingId]);

  const write = useCallback(async (base: NoteValue, next: NoteValue): Promise<NoteValue> => {
    await saveManualNotes(target.meetingId, next.markdown);
    return { ...next, revision: (base.revision || 0) + 1 };
  }, [target.meetingId]);

  const draft = useNoteDraft(`meeting:${target.meetingId}`, load, write);
  const [navigationError, setNavigationError] = useState<string | null>(null);

  useEffect(() => {
    flushRef.current = draft.flush;
    return () => { if (flushRef.current === draft.flush) flushRef.current = waiting; };
  }, [draft.flush, flushRef]);

  const appendNoteText = useCallback((toAppend: string) => {
    const current = draft.value.markdown || '';
    const trimmed = current.trimEnd();
    const tagTrimmed = toAppend.trim();
    if (trimmed.endsWith(tagTrimmed)) {
      requestAnimationFrame(() => {
        editorRef.current?.focusAndScrollEnd();
      });
      return;
    }
    const nextMarkdown = !trimmed ? `${tagTrimmed}\n` : `${trimmed}\n\n${tagTrimmed}\n`;
    draft.change({ markdown: nextMarkdown });
    requestAnimationFrame(() => {
      editorRef.current?.focusAndScrollEnd();
    });
  }, [draft]);

  // Handle cold start appendText once draft is loaded
  useEffect(() => {
    if (draft.status === 'loading' || initialAppended.current) return;
    initialAppended.current = true;
    if (target.appendText) {
      appendNoteText(target.appendText);
    }
  }, [draft.status, target.appendText, appendNoteText]);

  // Listen for append events while the window is already open
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ meetingId: string; text: string }>('manual-notes:append', (event) => {
      if (event.payload.meetingId !== target.meetingId) return;
      const toAppend = event.payload.text;
      if (!toAppend) return;
      appendNoteText(toAppend);
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [target.meetingId, appendNoteText]);

  const saveNow = () => { void draft.flush().then(onChanged).catch(() => undefined); };
  const saved = draft.status === 'saved';

  return (
    <article className="mx-auto flex w-full max-w-[540px] flex-1 flex-col px-5 pb-8 pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-text">Meeting notes</span>
        <div className="flex items-center gap-1.5 text-xs text-2" role="status" aria-live="polite">
          {draft.status === 'loading' || draft.status === 'saving' ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : saved ? (
            <Check className="h-3.5 w-3.5" />
          ) : null}
          {draft.status === 'loading'
            ? 'Opening…'
            : draft.status === 'saving'
            ? 'Saving…'
            : saved
            ? 'Saved on Mac'
            : draft.status === 'dirty'
            ? 'Unsaved'
            : 'Save needed'}
        </div>
      </div>

      <p className="mb-4 text-xs leading-relaxed text-2">
        Meeting notes are saved locally. Click “+” beside any transcript turn to add a note linked to that moment.
      </p>

      {draft.storageWarning && (
        <p role="alert" className="mb-3 rounded-lg border border-warn p-2.5 text-xs text-warn">
          Local draft recovery is unavailable. Keep this window open until Saved.
        </p>
      )}
      {draft.recovered && (
        <p role="status" className="mb-3 text-xs text-2">
          Recovered an unsaved draft from this device.
        </p>
      )}
      {(draft.error || navigationError) && (
        <div role="alert" className="mb-3 flex items-start justify-between gap-2 rounded-lg border border-border p-2.5 text-xs text-danger">
          <p>{navigationError || draft.error}</p>
          <button type="button" className="shrink-0 underline" onClick={() => { setNavigationError(null); draft.retry(); }}>
            Retry
          </button>
        </div>
      )}

      <MarkdownNoteEditor
        ref={editorRef}
        value={draft.value.markdown}
        readOnly={!draft.ready}
        onChange={markdown => draft.change({ markdown })}
        onSave={saveNow}
      />
    </article>
  );
}

function NotebookWorkspace({ target, flushRef }: { target: NotesWindowTarget; flushRef: MutableRefObject<Flush> }) {
  const [windowError, setWindowError] = useState<string | null>(null);

  const close = async () => {
    try {
      await flushRef.current();
    } catch (e) {
      console.warn('Could not flush notes on close:', e);
    }
    try {
      await closeManualNotesWindow();
    } catch (error) {
      setWindowError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleChanged = async () => {
    await emit('manual-notes:saved', { meetingId: target.meetingId });
  };

  return (
    <div className="flex h-screen flex-col bg-surface font-sans text-text">
      <header data-tauri-drag-region className="flex h-12 shrink-0 items-center justify-between border-b border-border pl-[78px] pr-3">
        <span data-tauri-drag-region className="truncate text-xs font-semibold">Meeting notes</span>
        <button
          type="button"
          className={button}
          title="Close notes and return to meeting"
          aria-label="Return to meeting"
          onClick={() => void close()}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Close</span>
        </button>
      </header>
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {windowError && (
          <div role="alert" className="m-4 rounded-lg border border-border p-3 text-xs text-danger">
            {windowError}
            <button className="ml-3 underline" onClick={() => setWindowError(null)}>Dismiss</button>
          </div>
        )}
        <DocumentEditor
          key={target.meetingId}
          target={target}
          flushRef={flushRef}
          onChanged={handleChanged}
        />
      </main>
    </div>
  );
}

export default function NotesWindow() {
  const [target, setTarget] = useState<NotesWindowTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targetRef = useRef<NotesWindowTarget | null>(null);
  const flushRef = useRef<Flush>(waiting);
  const syncing = useRef<Promise<void> | null>(null);
  const alive = useRef(false);

  const sync = useCallback(() => {
    if (syncing.current) return syncing.current;
    const work = async () => {
      try {
        let requested = await getNotesWindowTarget();
        if (!requested) return;
        if (targetRef.current && requested.version === targetRef.current.version && requested.meetingId === targetRef.current.meetingId) return;
        if (targetRef.current) {
          try {
            await flushRef.current();
          } catch (e) {
            console.warn('Could not flush previous notes before switching meeting:', e);
          }
        }
        const latest = await getNotesWindowTarget();
        const next = latest || requested;
        if (alive.current) {
          targetRef.current = next;
          setTarget(next);
          setError(null);
        }
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        syncing.current = null;
      }
    };
    syncing.current = work();
    return syncing.current;
  }, []);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    const disposers: (() => void)[] = [];
    const add = (fn: () => void) => { if (disposed) fn(); else disposers.push(fn); };
    const close = async () => {
      try { await flushRef.current(); } catch (e) { console.warn('Flush before close failed:', e); }
      try { await closeManualNotesWindow(); }
      catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    };
    void (async () => {
      add(await listen('manual-notes:target-changed', () => { void sync(); }));
      add(await listen('manual-notes:request-close', () => { void close(); }));
      add(await listen<{ requestId: string }>('manual-notes:flush', async ({ payload }) => {
        let ok = false;
        try { await flushRef.current(); ok = true; } catch { /* Reply failure, never discard. */ }
        await emit('manual-notes:flushed', { requestId: payload.requestId, ok });
      }));
      if (!disposed) await sync();
    })().catch(() => { if (!disposed) setError('The notes window could not connect. Reopen it from the transcript.'); });
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') { event.preventDefault(); void close(); }
    };
    window.addEventListener('keydown', keyboard);
    return () => { disposed = true; alive.current = false; disposers.forEach(fn => fn()); window.removeEventListener('keydown', keyboard); };
  }, [sync]);

  return (
    <>
      {error && (
        <div role="alert" className="fixed bottom-5 left-1/2 z-50 w-[min(580px,90vw)] -translate-x-1/2 rounded-xl border border-warn bg-surface p-4 text-sm text-danger shadow-lg">
          {error}
          <button type="button" className="ml-3 font-medium underline" onClick={() => void sync()}>Retry opening requested note</button>
        </div>
      )}
      {target ? (
        <NotebookWorkspace key={target.meetingId} target={target} flushRef={flushRef} />
      ) : (
        <div className="flex h-screen items-center justify-center bg-surface text-sm text-2">Opening notes…</div>
      )}
    </>
  );
}
