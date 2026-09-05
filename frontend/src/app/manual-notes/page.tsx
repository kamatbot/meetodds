'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { X } from 'lucide-react';
import { getManualNotes, saveManualNotes } from '@/services/manualNotesService';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DELAY_MS = 400;

export default function ManualNotesPage() {
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<SaveStatus>('idle');

  const meetingIdRef = useRef<string | null>(null);
  const lastSavedRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    meetingIdRef.current = meetingId;
  }, [meetingId]);

  // Read the meeting id from the query string once, then keep it in sync with
  // the native `manual-notes:set-meeting` event fired when the window is reused.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initial = params.get('meetingId');
    if (initial) setMeetingId(initial);

    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<string>('manual-notes:set-meeting', (event) => {
      setMeetingId(event.payload);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!meetingId) return;
    let cancelled = false;
    getManualNotes(meetingId)
      .then((loaded) => {
        if (cancelled) return;
        lastSavedRef.current = loaded;
        setContent(loaded);
        setStatus('idle');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const save = useCallback((value: string) => {
    const id = meetingIdRef.current;
    if (!id || value === lastSavedRef.current) return;
    setStatus('saving');
    saveManualNotes(id, value)
      .then(() => {
        lastSavedRef.current = value;
        setStatus('saved');
      })
      .catch(() => setStatus('error'));
  }, []);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value;
      setContent(value);
      clearTimer();
      timerRef.current = setTimeout(() => save(value), AUTOSAVE_DELAY_MS);
    },
    [clearTimer, save]
  );

  const handleBlur = useCallback(() => {
    clearTimer();
    save(content);
  }, [clearTimer, content, save]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearTimer();
        save(content);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [clearTimer, content, save]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const statusText =
    status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? 'Not saved' : '';

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      <div
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border pl-[72px] pr-2 text-ui"
      >
        <span data-tauri-drag-region className="truncate font-semibold">
          Meeting notes
        </span>
        <div className="no-drag flex items-center gap-2">
          <span className="text-caption text-2">{statusText}</span>
          <button
            type="button"
            aria-label="Close meeting notes"
            onClick={() => {
              void getCurrentWindow().hide();
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded-control text-2 transition-colors hover:bg-surface hover:text-text"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
      <textarea
        className="h-full w-full flex-1 resize-none bg-bg p-3 text-text outline-none"
        style={{ fontSize: 14 }}
        placeholder="Type notes for this meeting…"
        value={content}
        onChange={handleChange}
        onBlur={handleBlur}
        autoFocus
        disabled={!meetingId}
      />
    </div>
  );
}
