'use client';

import { LoaderCircle } from 'lucide-react';
interface StopProgressStripProps { isProcessing: boolean; isSaving: boolean }

export default function StopProgressStrip({ isProcessing, isSaving }: StopProgressStripProps) {
  if (!isProcessing && !isSaving) return null;
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="shrink-0 border-b border-border bg-surface px-4 py-3">
      <div className="flex items-start gap-3">
        <LoaderCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <p className="text-ui font-semibold text-text">{isSaving ? 'Saving the meeting to your library…' : 'Finishing the transcript…'}</p>
          <p className="mt-0.5 break-words text-caption text-2">{isSaving
            ? 'Keep MeetOdds open until saving is confirmed. Summary generation is a separate step.'
            : 'Capture has stopped. Remaining speech is being transcribed; local saving is confirmed separately.'}</p>
        </div>
      </div>
    </div>
  );
}
