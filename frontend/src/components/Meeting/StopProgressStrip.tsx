'use client';

import { CheckCircle2, LoaderCircle } from 'lucide-react';

interface StopProgressStripProps {
  isProcessing: boolean;
  isSaving: boolean;
}

export default function StopProgressStrip({
  isProcessing,
  isSaving,
}: StopProgressStripProps) {
  if (!isProcessing && !isSaving) return null;

  const label = isSaving ? 'Saving meeting…' : 'Finalizing transcript…';
  const detail = isSaving
    ? 'The meeting is ready to leave open; MeetOdds is writing the final local record.'
    : 'Audio is stopped and safe. Remaining transcript work continues in the background.';

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-x-3 top-3 z-40 overflow-hidden rounded-card border border-border bg-surface shadow-popover"
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        {isSaving ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" strokeWidth={1.75} />
        ) : (
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-accent" strokeWidth={1.75} />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-ui font-semibold text-text">{label}</div>
          <div className="truncate text-caption text-3">{detail}</div>
        </div>
      </div>
      <div className="h-0.5 overflow-hidden bg-border/60">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
      </div>
    </div>
  );
}
