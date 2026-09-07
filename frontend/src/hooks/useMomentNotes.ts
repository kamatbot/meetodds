'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { listMomentNotes, NOTES_CHANGED } from '@/services/momentNotesService';
import type { Notebook } from '@/types/moment-notes';

export function useMomentNotes(meetingId: string | null | undefined) {
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!meetingId) return;
    const version = ++sequence.current;
    try {
      const next = await listMomentNotes(meetingId);
      if (version === sequence.current) { setNotebook(next); setError(null); }
    } catch {
      if (version === sequence.current) setError('Personal notes could not be loaded. Retry before adding another.');
    } finally { if (version === sequence.current) setLoading(false); }
  }, [meetingId]);
  useEffect(() => {
    setNotebook(null); setError(null); setLoading(Boolean(meetingId));
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void listen(NOTES_CHANGED, () => { void refresh(); }).then(fn => {
      if (stopped) fn(); else { unlisten = fn; void refresh(); }
    }).catch(() => { if (!stopped) void refresh(); });
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { stopped = true; sequence.current += 1; unlisten?.(); window.removeEventListener('focus', onFocus); };
  }, [meetingId, refresh]);
  return { notebook, error, loading, refresh };
}
