'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { ArrowLeft, ArrowUpRight, Check, Clock3, Expand, FileText, LoaderCircle, PanelLeft, ShieldCheck } from 'lucide-react';
import { useMomentNotes } from '@/hooks/useMomentNotes';
import { useNoteDraft } from '@/hooks/useNoteDraft';
import { getManualNotes, saveManualNotes, openManualNotesWindow, closeManualNotesWindow } from '@/services/manualNotesService';
import { getNotesWindowTarget, listMomentNotes, saveMomentNote } from '@/services/momentNotesService';
import { momentLabel, noteTitle, type MomentNote, type NotesWindowTarget, type NoteValue } from '@/types/moment-notes';
import MarkdownNoteEditor, { NoteMarkdown } from './MarkdownNoteEditor';

type Flush = () => Promise<void>;
const waiting: Flush = () => Promise.reject(new Error('Notes are still opening. Retry after the editor is ready.'));
const button = 'inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-2 hover:bg-bg hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40';

function DocumentEditor({ target, note, flushRef, onChanged }: {
  target: NotesWindowTarget; note: MomentNote | null; flushRef: MutableRefObject<Flush>; onChanged: () => Promise<void>;
}) {
  const load = useCallback(async (): Promise<NoteValue> => {
    if (!target.noteId) return { markdown: await getManualNotes(target.meetingId), includeInSummary: true, revision: 0 };
    const book = await listMomentNotes(target.meetingId);
    const row = book.notes.find(n => n.id === target.noteId);
    if (!row) throw new Error('This note is no longer available.');
    return { markdown: row.markdown, includeInSummary: row.includeInSummary, revision: row.revision };
  }, [target.meetingId, target.noteId]);
  const write = useCallback(async (base: NoteValue, next: NoteValue): Promise<NoteValue> => {
    if (!target.noteId) {
      await saveManualNotes(target.meetingId, next.markdown, base.markdown);
      return { ...next, revision: 0 };
    }
    const saved = await saveMomentNote(target.noteId, base, next);
    return { markdown: saved.markdown, includeInSummary: saved.includeInSummary, revision: saved.revision };
  }, [target.meetingId, target.noteId]);
  const draft = useNoteDraft(target.noteId || `legacy:${target.meetingId}`, load, write);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  useEffect(() => {
    flushRef.current = draft.flush;
    return () => { if (flushRef.current === draft.flush) flushRef.current = waiting; };
  }, [draft.flush, flushRef]);

  const saveNow = () => { void draft.flush().then(onChanged).catch(() => undefined); };
  const jump = async () => {
    if (!target.noteId) return;
    setNavigationError(null);
    try {
      await draft.flush();
      await invoke('open_moment_note_source', { noteId: target.noteId });
      await closeManualNotesWindow();
    } catch (error) { setNavigationError(error instanceof Error ? error.message : String(error)); }
  };
  const saved = draft.status === 'saved';
  const title = target.noteId ? noteTitle(draft.value.markdown) : 'Meeting notes';
  return <article className="mx-auto flex w-full max-w-[820px] flex-1 flex-col px-8 pb-12 pt-10 lg:px-12 lg:pt-14">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-accent"><Clock3 className="h-4 w-4" />
        {note?.segmentId ? (note.audioStartTime == null ? 'Transcript note' : `At ${momentLabel(note.audioStartTime)}`) : 'Personal notebook'}
      </div>
      <div className="flex items-center gap-1.5 text-xs text-2" role="status" aria-live="polite">
        {draft.status === 'loading' || draft.status === 'saving' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5" /> : null}
        {draft.status === 'loading' ? 'Opening…' : draft.status === 'saving' ? 'Saving…' : saved ? 'Saved on this Mac' : draft.status === 'dirty' ? 'Unsaved changes' : 'Save needs attention'}
      </div>
    </div>
    <h1 className="mb-8 break-words font-serif text-[34px] font-medium leading-tight tracking-[-0.025em] text-text">{title}</h1>
    {note?.sourceText && <section className="mb-8 border-l-2 border-accent/40 pl-5" aria-label="Transcript moment linked to this note">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-[0.09em] text-2">What was being said{note.sourceSpeaker ? ` · ${note.sourceSpeaker}` : ''}</span>
        <button type="button" onClick={() => void jump()} className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline">View transcript <ArrowUpRight className="h-3.5 w-3.5" /></button>
      </div>
      <details open><summary className="cursor-pointer text-xs text-3">Original transcript context</summary>
        <blockquote className="mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap text-[16px] leading-7 text-2">{note.sourceText}</blockquote>
      </details>
      {note.anchorState === 'changed' && <p className="mt-2 text-xs text-warn">The transcript has changed since this note was created. The original context is preserved above.</p>}
      {note.anchorState === 'unresolved' && <p className="mt-2 text-xs text-3">Linked to the captured moment. A saved transcript segment has not yet been matched.</p>}
    </section>}
    {!target.noteId && <p className="mb-6 text-sm leading-6 text-2">Your existing meeting notes are kept here. Use a “+” beside any transcript turn to add a note linked to that moment.</p>}
    {draft.storageWarning && <p role="alert" className="mb-4 rounded-lg border border-warn p-3 text-sm text-warn">Local draft recovery is unavailable. Keep this window open until the note shows Saved.</p>}
    {draft.recovered && <p role="status" className="mb-4 text-sm text-2">Recovered an unsaved draft from this device.</p>}
    {draft.conflict && <div role="alert" className="mb-5 rounded-xl border border-warn p-4 text-sm">
      <p className="font-semibold text-text">Two versions of this note differ</p>
      <p className="mt-1 text-2">Your draft is preserved. Choose deliberately before replacing the saved note.</p>
      <details className="mt-3"><summary className="cursor-pointer">Review saved version</summary><div className="mt-3 max-h-52 overflow-y-auto"><NoteMarkdown content={draft.conflict.markdown || '(Empty note)'} /></div></details>
      <div className="mt-3 flex gap-2"><button type="button" className={button} onClick={() => draft.resolveConflict(true)}>Keep my draft</button><button type="button" className={button} onClick={() => draft.resolveConflict(false)}>Use saved version</button></div>
    </div>}
    {(draft.error || navigationError) && <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-border p-3 text-sm text-danger">
      <p>{navigationError || draft.error}</p><button type="button" className="shrink-0 underline" onClick={() => { setNavigationError(null); draft.retry(); }}>Retry</button>
    </div>}
    {target.noteId && <label className="mb-6 flex cursor-pointer items-start gap-3 text-sm text-2">
      <input type="checkbox" checked={draft.value.includeInSummary} disabled={!draft.ready} onChange={e => draft.change({ includeInSummary: e.target.checked })} className="mt-1 accent-accent" />
      <span><span className="font-medium text-text">Use this note in AI summaries</span><span className="mt-0.5 block text-xs leading-5 text-3">Selected notes are included in the summary input review. Personal observations are kept separate from what participants actually said.</span></span>
    </label>}
    {!draft.ready && draft.status === 'error' && !draft.conflict && <button type="button" className="mb-4 self-start text-sm text-2 underline" onClick={() => void closeManualNotesWindow()}>Close without changing saved notes or recovery drafts</button>}
    <MarkdownNoteEditor value={draft.value.markdown} readOnly={!draft.ready} onChange={markdown => draft.change({ markdown })} onSave={saveNow} />
  </article>;
}

function NotebookWorkspace({ target, flushRef }: { target: NotesWindowTarget; flushRef: MutableRefObject<Flush> }) {
  const { notebook, error, loading, refresh } = useMomentNotes(target.meetingId);
  const [sidebar, setSidebar] = useState(true);
  const [windowError, setWindowError] = useState<string | null>(null);
  const open = async (id: string | null) => {
    try { await flushRef.current(); await openManualNotesWindow(target.meetingId, id); }
    catch (error) { setWindowError(error instanceof Error ? error.message : String(error)); }
  };
  const close = async () => {
    try { await flushRef.current(); await closeManualNotesWindow(); }
    catch (error) { setWindowError(error instanceof Error ? error.message : String(error)); }
  };
  const selected = notebook?.notes.find(n => n.id === target.noteId) ?? null;
  const validSelection = !target.noteId || Boolean(selected);
  return <div className="flex h-screen flex-col bg-surface font-sans text-text">
    <header data-tauri-drag-region className="flex h-14 shrink-0 items-center gap-2 border-b border-border pl-[92px] pr-5">
      <button type="button" aria-label="Toggle notebook sidebar" aria-expanded={sidebar} className={button} onClick={() => setSidebar(v => !v)}><PanelLeft className="h-[17px] w-[17px]" /></button>
      <span data-tauri-drag-region className="min-w-0 flex-1 truncate text-sm font-medium">{notebook?.title || 'Meeting notebook'}</span>
      <button type="button" className={button} title="Toggle full screen" aria-label="Toggle notes full screen" onClick={() => {
        void invoke('toggle_manual_notes_fullscreen').catch(() => setWindowError('Could not change full screen mode. Use the macOS window controls.'));
      }}><Expand className="h-[17px] w-[17px]" /></button>
      <button type="button" className={button} onClick={() => void close()}><ArrowLeft className="h-4 w-4" /> Return to meeting</button>
    </header>
    <div className="flex min-h-0 flex-1">
      {sidebar && <aside className="flex w-[230px] shrink-0 flex-col border-r border-border bg-bg/60 px-3 py-6" aria-label="Meeting notebook">
        <p className="px-3 pb-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-3">Notebook</p>
        <button type="button" onClick={() => void open(null)} aria-current={!target.noteId ? 'page' : undefined} className={`flex items-center gap-2 rounded-lg px-3 py-3 text-left text-sm ${!target.noteId ? 'bg-accent-soft font-semibold text-accent' : 'text-2 hover:bg-bg'}`}><FileText className="h-4 w-4" /> Meeting notes</button>
        <p className="px-3 pb-2 pt-7 text-[11px] font-semibold uppercase tracking-[0.12em] text-3">Transcript moments</p>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {notebook?.notes.map(n => <button type="button" key={n.id} onClick={() => void open(n.id)} aria-current={target.noteId === n.id ? 'page' : undefined}
            className={`w-full rounded-lg px-3 py-3 text-left ${target.noteId === n.id ? 'bg-accent-soft text-accent' : 'text-text hover:bg-bg'}`}>
            <span className="mb-1 flex items-center gap-1.5 text-xs text-3"><Clock3 className="h-3 w-3" />{n.segmentId ? momentLabel(n.audioStartTime) : 'General note'}{!n.includeInSummary && <span className="ml-auto" title="Excluded from AI summaries">Private</span>}</span>
            <span className="block line-clamp-2 text-sm font-medium leading-5">{noteTitle(n.markdown)}</span>
          </button>)}
          {!loading && notebook?.notes.length === 0 && <p className="px-3 py-4 text-sm leading-6 text-3">Click “+” beside a transcript turn. Your notes will appear here, linked to the conversation.</p>}
        </div>
        <p className="flex items-center gap-1.5 px-3 pt-6 text-xs text-3"><ShieldCheck className="h-3.5 w-3.5" /> Saved locally</p>
      </aside>}
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {windowError && <div role="alert" className="m-5 rounded-lg border border-border p-3 text-sm text-danger">{windowError}<button className="ml-3 underline" onClick={() => setWindowError(null)}>Dismiss</button></div>}
        {error && <div role="alert" className="m-5 text-sm text-danger">{error}<button type="button" className="ml-3 underline" onClick={() => void refresh()}>Retry</button></div>}
        {validSelection ? <DocumentEditor key={`${target.version}:${target.meetingId}:${target.noteId || 'general'}`} target={target} note={selected} flushRef={flushRef} onChanged={refresh} />
          : loading ? <p role="status" className="m-auto flex gap-2 text-sm text-2"><LoaderCircle className="h-4 w-4 animate-spin" /> Opening your note…</p>
          : <div role="alert" className="m-8 text-sm text-danger"><p>This note could not be found. Your other notes remain available in the notebook.</p><button type="button" className="mt-3 underline" onClick={() => void closeManualNotesWindow()}>Close without changing notes</button></div>}
      </main>
    </div>
  </div>;
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
        if (!requested || requested.version === targetRef.current?.version) return;
        if (targetRef.current) await flushRef.current();
        // Another + may have been clicked while SQLite saved. Use the latest intent.
        requested = await getNotesWindowTarget();
        if (requested && alive.current) {
          targetRef.current = requested; setTarget(requested); setError(null);
        }
      } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
      finally { syncing.current = null; }
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
      try { await flushRef.current(); await closeManualNotesWindow(); }
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
  return <>{error && <div role="alert" className="fixed bottom-5 left-1/2 z-50 w-[min(580px,90vw)] -translate-x-1/2 rounded-xl border border-warn bg-surface p-4 text-sm text-danger shadow-lg">
    {error}<button type="button" className="ml-3 font-medium underline" onClick={() => void sync()}>Retry opening requested note</button>
  </div>}{target ? <NotebookWorkspace key={target.meetingId} target={target} flushRef={flushRef} /> : <div className="flex h-screen items-center justify-center bg-surface text-sm text-2">Opening notebook…</div>}</>;
}
