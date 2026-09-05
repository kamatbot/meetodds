'use client';

import { NotebookPen, Pause, Play, Square } from 'lucide-react';
interface LiveMeetingBarProps {
  isPaused: boolean;
  isBusy: boolean;
  onPauseResume: () => void;
  onStop: () => void;
  onOpenNotes: () => void;
}

export default function LiveMeetingBar({
  isPaused,
  isBusy,
  onPauseResume,
  onStop,
  onOpenNotes,
}: LiveMeetingBarProps) {
  const status = isPaused
    ? 'Recording paused'
    : 'Recording in progress';

  return (
    <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-white/10 bg-slate-950 px-5 py-2 text-white shadow-sm">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${isPaused ? 'bg-amber-400' : 'bg-record animate-pulse'}`} aria-hidden="true" />
      <span className="shrink-0 text-ui font-semibold text-white">
        {isPaused ? 'Paused' : 'Recording'}
      </span>
      <span className="min-w-0 flex-1 truncate text-ui text-slate-100" aria-live="polite">
        {status}
      </span>
      <button
        type="button"
        onClick={onOpenNotes}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-white/20 bg-white/10 px-2.5 text-caption font-semibold text-white transition-colors hover:bg-white/20 disabled:opacity-40"
        aria-label="Open meeting notes"
      >
        <NotebookPen className="h-3.5 w-3.5" strokeWidth={1.75} />
        Notes
      </button>
      <button
        type="button"
        onClick={onPauseResume}
        disabled={isBusy}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-white/20 bg-white/10 px-2.5 text-caption font-semibold text-white transition-colors hover:bg-white/20 disabled:opacity-40"
        aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
      >
        {isPaused ? <Play className="h-3.5 w-3.5" fill="currentColor" strokeWidth={1.75} /> : <Pause className="h-3.5 w-3.5" fill="currentColor" strokeWidth={1.75} />}
        {isPaused ? 'Resume' : 'Pause'}
      </button>
      <button
        type="button"
        onClick={onStop}
        disabled={isBusy}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control bg-record px-2.5 text-caption font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        aria-label="Stop recording"
      >
        <Square className="h-3 w-3" fill="currentColor" strokeWidth={1.75} /> Stop
      </button>
    </div>
  );
}
