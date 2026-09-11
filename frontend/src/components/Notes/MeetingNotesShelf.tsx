'use client';

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getManualNotes } from '@/services/manualNotesService';
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

  return (
    <section className="mx-6 mt-5 shrink-0 border-b border-border pb-5 text-text" aria-label="Personal notes linked to the meeting">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Meeting notes</h2>
      </div>
      <div className="max-h-56 space-y-2 overflow-y-auto">
        {content.trim() ? (
          <div className="rounded-lg border border-border bg-bg/40 p-4">
            <NoteMarkdown content={content} />
          </div>
        ) : (
          <p className="text-sm leading-6 text-3">
            Click “+” beside any transcript turn to take notes linked to this meeting.
          </p>
        )}
      </div>
      {localError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {localError}
        </p>
      )}
    </section>
  );
}
