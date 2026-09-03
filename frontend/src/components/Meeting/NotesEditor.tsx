'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

interface MeetingNotesResponse {
  meetingId: string;
  notesMarkdown: string;
}

interface NotesEditorProps {
  meetingId: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DELAY_MS = 2_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default function NotesEditor({ meetingId }: NotesEditorProps) {
  const [value, setValue] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const revisionRef = useRef(0);
  const lastSavedRevisionRef = useRef(0);
  const lastSavedValueRef = useRef('');
  const mountedRef = useRef(true);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const loadGenerationRef = useRef(0);
  const activeMeetingIdRef = useRef(meetingId);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  const saveRevision = useCallback((revision: number, notesMarkdown: string) => {
    const meetingIdAtSave = meetingId;

    // Serialize native writes. A save that is already in flight may not be abortable,
    // but the next revision will always execute after it so an older write can never
    // finish last and overwrite newer notes.
    const queued = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (activeMeetingIdRef.current !== meetingIdAtSave) return;
        if (revision !== revisionRef.current) return;
        if (revision <= lastSavedRevisionRef.current && notesMarkdown === lastSavedValueRef.current) {
          return;
        }

        if (mountedRef.current) setSaveState('saving');
        try {
          await invoke<void>('api_save_meeting_notes', {
            meetingId: meetingIdAtSave,
            notesMarkdown,
          });

          // A meeting switch can happen while the native write is in flight. The
          // old write is still scoped to its old meeting id, but its completion must
          // never mutate the newly opened editor's state.
          if (activeMeetingIdRef.current !== meetingIdAtSave) return;
          if (revision !== revisionRef.current) return;
          lastSavedRevisionRef.current = revision;
          lastSavedValueRef.current = notesMarkdown;
          if (mountedRef.current) setSaveState('saved');
        } catch (error) {
          if (activeMeetingIdRef.current !== meetingIdAtSave) return;
          if (revision !== revisionRef.current) return;
          console.error('[NotesEditor] Failed to save meeting notes:', error);
          if (mountedRef.current) {
            setSaveState('error');
            toast.error('Could not save notes', {
              description: errorMessage(error),
            });
          }
        }
      });

    saveQueueRef.current = queued;
    return queued;
  }, [meetingId]);

  const loadNotes = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    clearAutosaveTimer();
    setIsLoading(true);
    setLoadError(null);
    setSaveState('idle');
    revisionRef.current = 0;
    lastSavedRevisionRef.current = 0;

    try {
      const response = await invoke<MeetingNotesResponse>('api_get_meeting_notes', { meetingId });
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      if (activeMeetingIdRef.current !== meetingId) return;
      setValue(response.notesMarkdown);
      lastSavedValueRef.current = response.notesMarkdown;
      setIsLoading(false);
    } catch (error) {
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      if (activeMeetingIdRef.current !== meetingId) return;
      console.error('[NotesEditor] Failed to load meeting notes:', error);
      setLoadError(errorMessage(error));
      setIsLoading(false);
    }
  }, [clearAutosaveTimer, meetingId]);

  useEffect(() => {
    mountedRef.current = true;
    activeMeetingIdRef.current = meetingId;
    void loadNotes();
    return () => {
      mountedRef.current = false;
      if (activeMeetingIdRef.current === meetingId) {
        activeMeetingIdRef.current = '';
      }
      loadGenerationRef.current += 1;
      clearAutosaveTimer();
    };
  }, [clearAutosaveTimer, loadNotes, meetingId]);

  const scheduleAutosave = useCallback((revision: number, notesMarkdown: string) => {
    clearAutosaveTimer();
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void saveRevision(revision, notesMarkdown);
    }, AUTOSAVE_DELAY_MS);
  }, [clearAutosaveTimer, saveRevision]);

  const handleChange = (notesMarkdown: string) => {
    const revision = revisionRef.current + 1;
    revisionRef.current = revision;
    setValue(notesMarkdown);
    setSaveState('idle');
    scheduleAutosave(revision, notesMarkdown);
  };

  const handleBlur = () => {
    if (isLoading || loadError) return;
    clearAutosaveTimer();
    if (value === lastSavedValueRef.current) return;
    void saveRevision(revisionRef.current, value);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col px-6 py-6">
        <div className="mb-3 flex h-6 shrink-0 items-center justify-between gap-3">
          <p className="text-caption text-3">Markdown notes · saved locally with this meeting</p>
          <div className="flex items-center gap-1.5 text-caption text-3" aria-live="polite">
            {isLoading ? (
              <><LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> Loading…</>
            ) : saveState === 'saving' ? (
              <><LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> Saving…</>
            ) : saveState === 'saved' ? (
              <><Check className="h-3.5 w-3.5 text-success" strokeWidth={1.75} /> Saved</>
            ) : saveState === 'error' ? (
              <span className="text-danger">Save failed</span>
            ) : null}
          </div>
        </div>

        {loadError ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="max-w-sm rounded-card border border-border bg-surface p-5 text-center">
              <TriangleAlert className="mx-auto h-5 w-5 text-warn" strokeWidth={1.75} />
              <p className="mt-2 text-ui font-semibold text-text">Notes could not be loaded</p>
              <p className="mt-1 text-caption text-3">{loadError}</p>
              <button
                type="button"
                onClick={() => void loadNotes()}
                className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-bg px-3 text-ui font-medium text-text hover:bg-surface"
              >
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} /> Retry
              </button>
            </div>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={value}
            readOnly={isLoading}
            aria-label="Meeting notes"
            aria-busy={isLoading}
            placeholder={isLoading ? 'Loading notes…' : 'Write notes here…'}
            onChange={(event) => handleChange(event.target.value)}
            onBlur={handleBlur}
            className="min-h-[260px] flex-1 resize-none rounded-card border border-border bg-surface px-5 py-4 font-mono text-body leading-7 text-text outline-none transition-colors duration-150 placeholder:text-3 focus:border-accent focus:ring-2 focus:ring-accent/20 read-only:cursor-progress"
          />
        )}
      </div>
    </div>
  );
}
