'use client';

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ArrowUpRight } from 'lucide-react';
import { getManualNotes, openManualNotesWindow } from '@/services/manualNotesService';
import { NoteMarkdown } from './MarkdownNoteEditor';

export default function MeetingNotesShelf({ meetingId }: { meetingId: string }) {
  const [content, setContent] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlistenSaved: (() => void) | undefined;
    let unlistenChanged: (() => void) | undefined;

    const load = () => {
      void getManualNotes(meetingId)
        .then(value => { if (!disposed) setContent(value); })
        .catch(() => { if (!disposed) setLocalError('Meeting notes could not be read.'); });
    };
    setContent('');
    setLocalError(null);
    load();

    void listen('manual-notes:saved', load).then(fn => { unlistenSaved = fn; }).catch(() => undefined);
    void listen('manual-notes:changed', load).then(fn => { unlistenChanged = fn; }).catch(() => undefined);

    return () => {
      disposed = true;
      unlistenSaved?.();
      unlistenChanged?.();
    };
  }, [meetingId]);

  const open = () => {
    void openManualNotesWindow(meetingId).catch(() => setLocalError('Could not open meeting notes. Retry.'));
  };

  return (
    <section className="mx-6 mt-5 shrink-0 border-b border-border pb-5 text-text" aria-label="Personal notes linked to the meeting">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Meeting notes</h2>
        <button
          type="button"
          onClick={() => open()}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-accent hover:bg-accent-soft"
        >
          Open notes window <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-56 space-y-2 overflow-y-auto">
        {content.trim() ? (
          <div className="rounded-lg border border-border bg-bg/40 p-4">
            <NoteMarkdown content={content} />
          </div>
        ) : (
          <p className="text-sm leading-6 text-3">
            Click “+” beside any transcript turn or click “Open notes window” to take notes for this meeting.
          </p>
        )}
      </div>
      {localError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {localError}
          <button type="button" onClick={() => { setLocalError(null); open(); }} className="ml-2 underline">
            Retry
          </button>
        </p>
      )}
    </section>
  );
}
