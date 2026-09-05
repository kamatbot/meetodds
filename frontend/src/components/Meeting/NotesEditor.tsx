'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import {
  clearAcknowledgedDraft, createNotesSaveQueue, discardNotesDraft,
  readNotesDraft, writeNotesDraft,
} from '@/lib/notes-autosave';

interface MeetingNotesResponse { meetingId: string; notesMarkdown: string }
interface NotesEditorProps { meetingId: string }
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
const AUTOSAVE_DELAY_MS = 650;

// Shared across editor mounts: leaving and reopening a tab cannot create racing writes.
const saves = createNotesSaveQueue(async (meetingId, notesMarkdown) => {
  await invoke<void>('api_save_meeting_notes', { meetingId, notesMarkdown });
  try { clearAcknowledgedDraft(window.localStorage, meetingId, notesMarkdown); } catch { /* Keep native success. */ }
});

function Editor({ meetingId }: NotesEditorProps) {
  const [value, setValue] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [recoveryWarning, setRecoveryWarning] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [conflict, setConflict] = useState<{ saved: string; draft: string } | null>(null);
  const latest = useRef('');
  const acknowledged = useRef('');
  const ready = useRef(false);
  const blocked = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const persist = useCallback(async () => {
    clearTimer();
    if (!ready.current || blocked.current || latest.current === acknowledged.current) return;
    const snapshot = latest.current;
    if (mounted.current) setSaveState('saving');
    try {
      const result = await saves.save(meetingId, snapshot);
      if (result === 'saved') {
        acknowledged.current = snapshot;
        if (mounted.current && latest.current === snapshot) setSaveState('saved');
      }
    } catch {
      if (mounted.current && latest.current === snapshot) setSaveState('error');
    }
  }, [clearTimer, meetingId]);

  const load = useCallback(async () => {
    const request = ++generation.current;
    ready.current = false;
    setIsLoading(true);
    setLoadError(null);
    try {
      await saves.idle(meetingId);
      const response = await invoke<MeetingNotesResponse>('api_get_meeting_notes', { meetingId });
      if (!mounted.current || generation.current !== request) return;
      let draft = null;
      try { draft = readNotesDraft(window.localStorage, meetingId); }
      catch { setRecoveryWarning(true); }
      const stored = response.notesMarkdown;
      acknowledged.current = stored;
      const needsRecovery = draft !== null && draft.value !== stored;
      const hasConflict = needsRecovery && draft!.base !== stored;
      latest.current = needsRecovery ? draft!.value : stored;
      setValue(latest.current);
      blocked.current = hasConflict;
      setConflict(hasConflict ? { saved: stored, draft: draft!.value } : null);
      setRecovered(needsRecovery);
      ready.current = true;
      setIsLoading(false);
      setSaveState(needsRecovery ? 'dirty' : 'saved');
      if (needsRecovery && !hasConflict) void persist();
      if (!needsRecovery) {
        try { clearAcknowledgedDraft(window.localStorage, meetingId, stored); } catch { /* Native copy is safe. */ }
      }
    } catch {
      if (!mounted.current || generation.current !== request) return;
      setLoadError('Your existing notes could not be read. Retry before editing so they are not overwritten.');
      setIsLoading(false);
    }
  }, [meetingId, persist]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const onPageHide = () => { void persist(); };
    const onVisibility = () => { if (document.hidden) void persist(); };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      // Queue the last revision before unmount; do not invalidate a write scoped to this meeting.
      void persist();
      mounted.current = false;
      generation.current += 1;
      clearTimer();
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [clearTimer, load, persist]);

  const change = (next: string) => {
    latest.current = next;
    setValue(next);
    setSaveState('dirty');
    setRecovered(false);
    try {
      writeNotesDraft(window.localStorage, { version: 1, meetingId, base: acknowledged.current, value: next });
      setRecoveryWarning(false);
    } catch { setRecoveryWarning(true); }
    clearTimer();
    timer.current = setTimeout(() => { void persist(); }, AUTOSAVE_DELAY_MS);
  };

  const resolveConflict = (useDraft: boolean) => {
    if (!conflict) return;
    const chosen = useDraft ? conflict.draft : conflict.saved;
    blocked.current = false;
    setConflict(null);
    if (useDraft) { change(chosen); void persist(); }
    else {
      latest.current = chosen;
      setValue(chosen);
      setSaveState('saved');
      setRecovered(false);
      try { discardNotesDraft(window.localStorage, meetingId); } catch { setRecoveryWarning(true); }
    }
    textarea.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col px-6 py-6">
        <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
          <p id="meeting-notes-help" className="text-caption text-3">Private Markdown notes · stored on this device</p>
          <div className="flex items-center gap-1.5 text-caption text-3" role="status" aria-live="polite" aria-atomic="true">
            {isLoading ? <><LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> Loading…</>
              : saveState === 'saving' ? <><LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> Saving…</>
              : saveState === 'saved' ? <><Check aria-hidden="true" className="h-3.5 w-3.5 text-success" /> Saved</>
              : saveState === 'error' ? <button type="button" onClick={() => void persist()} className="rounded-control px-2 py-1 text-danger underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Save failed · Retry</button>
              : saveState === 'dirty' ? 'Unsaved changes' : null}
          </div>
        </div>
        {recoveryWarning && <p role="alert" className="mb-3 text-caption text-warn">Local recovery storage is unavailable. Keep this window open until notes show Saved.</p>}
        {recovered && !conflict && <p role="status" className="mb-3 text-caption text-2">Recovered your last unsaved draft.</p>}
        {conflict && (
          <div role="alert" className="mb-3 rounded-card border border-warn bg-surface p-4 text-ui text-text">
            <p className="font-semibold">A recovered draft and saved notes differ</p>
            <p className="mt-1 text-caption text-2">The recovered draft is shown below. Choose which version to keep; nothing has been overwritten.</p>
            <details className="mt-2"><summary className="cursor-pointer">Review saved notes</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-caption">{conflict.saved || '(Empty)'}</pre></details>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" onClick={() => resolveConflict(true)} className="rounded-control border border-border px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Keep recovered draft</button>
              <button type="button" onClick={() => resolveConflict(false)} className="rounded-control border border-border px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Keep saved notes</button>
            </div>
          </div>
        )}
        {loadError ? (
          <div className="flex flex-1 items-center justify-center" role="alert">
            <div className="max-w-sm rounded-card border border-border bg-surface p-5 text-center">
              <TriangleAlert aria-hidden="true" className="mx-auto h-5 w-5 text-warn" />
              <p className="mt-2 text-ui font-semibold text-text">Notes could not be loaded</p>
              <p className="mt-1 text-caption text-3">{loadError}</p>
              <button type="button" onClick={() => void load()} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-bg px-3 text-ui font-medium text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><RefreshCw aria-hidden="true" className="h-3.5 w-3.5" /> Retry</button>
            </div>
          </div>
        ) : (
          <textarea ref={textarea} value={value} readOnly={isLoading || Boolean(conflict)} aria-label="Meeting notes" aria-describedby="meeting-notes-help" aria-busy={isLoading}
            placeholder={isLoading ? 'Loading notes…' : 'What matters in this meeting? Write a thought, question, or decision…'}
            onChange={(event) => change(event.target.value)} onBlur={() => void persist()}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void persist(); } }}
            className="min-h-[260px] flex-1 resize-none rounded-card border border-border bg-surface px-5 py-4 text-body leading-7 text-text outline-none transition-colors duration-150 placeholder:text-3 focus:border-accent focus:ring-2 focus:ring-accent/20 read-only:cursor-default" />
        )}
      </div>
    </div>
  );
}

// A new meeting gets its own refs and cleanup; old writes retain their original meeting id.
export default function NotesEditor(props: NotesEditorProps) { return <Editor key={props.meetingId} {...props} />; }
