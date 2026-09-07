'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { sameNoteValue, type NoteValue, type StoredNoteDraft } from '@/types/moment-notes';

type Status = 'loading' | 'dirty' | 'saving' | 'saved' | 'error';
interface Session {
  base: NoteValue | null;
  value: NoteValue | null;
  inFlight: Promise<void> | null;
  blocked: boolean;
}
const empty: NoteValue = { markdown: '', includeInSummary: true, revision: 0 };
const valid = (v: unknown): v is NoteValue => {
  if (!v || typeof v !== 'object') return false;
  const n = v as Partial<NoteValue>;
  return typeof n.markdown === 'string' && typeof n.includeInSummary === 'boolean'
    && typeof n.revision === 'number' && Number.isSafeInteger(n.revision) && n.revision >= 0;
};

/** One keyed editor owns one document. Changes are journaled before debounce;
 * writes drain serially and use native compare-and-swap revisions.
 */
export function useNoteDraft(
  documentKey: string,
  load: () => Promise<NoteValue>,
  write: (base: NoteValue, next: NoteValue) => Promise<NoteValue>,
) {
  const storageKey = `meetodds.note-draft.v1:${documentKey}`;
  const session = useRef<Session>({ base: null, value: null, inFlight: null, blocked: false });
  const alive = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [value, setValue] = useState(empty);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [conflict, setConflict] = useState<NoteValue | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  const cancelTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const journal = useCallback(() => {
    const { base, value: next } = session.current;
    if (!base || !next) return;
    try {
      if (sameNoteValue(base, next)) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify({ version: 1, base, value: next } satisfies StoredNoteDraft));
      if (alive.current) setStorageWarning(false);
    } catch { if (alive.current) setStorageWarning(true); }
  }, [storageKey]);

  const flush = useCallback((): Promise<void> => {
    cancelTimer();
    const s = session.current;
    if (!s.base || !s.value) return Promise.reject(new Error('Notes are still loading. Retry after they appear.'));
    if (s.inFlight) return s.inFlight;
    if (sameNoteValue(s.base, s.value)) return Promise.resolve();
    const work = async () => {
      if (alive.current) { setStatus('saving'); setError(null); }
      try {
        while (s.base && s.value && !sameNoteValue(s.base, s.value)) {
          const snapshot = { ...s.value };
          const saved = await write(s.base, snapshot);
          s.base = saved;
          // Do not overwrite text typed while the previous write was pending.
          s.value = { ...s.value, revision: saved.revision };
          journal();
        }
        if (alive.current) { setStatus('saved'); setRecovered(false); }
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        if (alive.current) { setError(message); setStatus('error'); }
        throw failure;
      } finally { s.inFlight = null; }
    };
    s.inFlight = work();
    return s.inFlight;
  }, [cancelTimer, journal, write]);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    setStatus('loading'); setError(null);
    void load().then(server => {
      if (disposed) return;
      let draft: StoredNoteDraft | null = null;
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const candidate: unknown = JSON.parse(raw);
          if (candidate && typeof candidate === 'object') {
            const d = candidate as Partial<StoredNoteDraft>;
            if (d.version === 1 && valid(d.base) && valid(d.value)) draft = d as StoredNoteDraft;
            else setStorageWarning(true);
          }
        }
      } catch { setStorageWarning(true); }
      const unsaved = draft && !sameNoteValue(draft.value, server) ? draft : null;
      session.current.base = server;
      session.current.value = unsaved ? { ...unsaved.value, revision: server.revision } : server;
      session.current.blocked = false;
      setValue(session.current.value);
      setConflict(null);
      setRecovered(Boolean(unsaved && unsaved.value.markdown.trim()));
      setStatus(unsaved ? 'dirty' : 'saved');
      if (unsaved) void flush().catch(() => undefined);
    }).catch(() => {
      if (!disposed) { setStatus('error'); setError('Notes could not be loaded. Retry; the existing note has not been replaced.'); }
    });
    const checkpoint = () => { journal(); void flush().catch(() => undefined); };
    const visibility = () => { if (document.hidden) checkpoint(); };
    window.addEventListener('blur', checkpoint);
    window.addEventListener('pagehide', checkpoint);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      checkpoint(); alive.current = false; cancelTimer();
      window.removeEventListener('blur', checkpoint);
      window.removeEventListener('pagehide', checkpoint);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [storageKey, load, flush, journal, cancelTimer, reloadVersion]);

  const change = useCallback((next: Partial<Pick<NoteValue, 'markdown' | 'includeInSummary'>>) => {
    const s = session.current;
    if (!s.value || s.blocked) return;
    s.value = { ...s.value, ...next };
    setValue(s.value); setStatus('dirty'); setRecovered(false);
    journal(); cancelTimer();
    timer.current = setTimeout(() => { void flush().catch(() => undefined); }, 650);
  }, [cancelTimer, flush, journal]);

  const resolveConflict = useCallback((keepDraft: boolean) => {
    if (!conflict) return;
    const s = session.current;
    s.base = conflict;
    s.value = keepDraft && s.value ? { ...s.value, revision: conflict.revision } : conflict;
    s.blocked = false;
    setValue(s.value); setConflict(null); setError(null);
    journal();
    if (keepDraft) void flush().catch(() => undefined);
    else { setStatus('saved'); setRecovered(false); }
  }, [conflict, flush, journal]);

  return { value, status, error, conflict, recovered, storageWarning, change, flush, resolveConflict,
    ready: session.current.base !== null,
    retry: () => { if (session.current.base) void flush().catch(() => undefined); else setReloadVersion(n => n + 1); },
  };
}
