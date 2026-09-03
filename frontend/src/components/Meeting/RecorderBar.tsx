'use client';

import { LoaderCircle, Pause, Play, Square } from 'lucide-react';

interface RecorderBarProps {
  isPaused: boolean;
  isStopping: boolean;
  isPausing: boolean;
  isResuming: boolean;
  isProcessing: boolean;
  recordingDuration: number | null;
  speechDetected: boolean;
  audioLevel?: number | null;
  onPauseResume: () => void;
  onStop: () => void;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '0:00';
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function LevelMeter({ level, paused }: { level: number | null | undefined; paused: boolean }) {
  const normalized = level == null || !Number.isFinite(level)
    ? null
    : Math.max(0, Math.min(1, level));

  if (normalized === null) {
    return (
      <div className="flex h-6 w-[72px] items-center gap-1" aria-label="Audio level unavailable">
        {[0, 1, 2, 3, 4].map((index) => (
          <span key={index} className="h-1 w-1 rounded-full bg-border" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-6 w-[72px] items-center justify-center gap-1" aria-label={`Audio level ${Math.round(normalized * 100)} percent`}>
      {[0.18, 0.36, 0.58, 0.78, 0.94].map((threshold, index) => {
        const active = !paused && normalized >= threshold;
        const height = 6 + index * 3;
        return (
          <span
            key={threshold}
            className={`w-1 rounded-full transition-[height,opacity] duration-100 ${active ? 'bg-record' : 'bg-border'}`}
            style={{ height, opacity: active ? 1 : 0.75 }}
          />
        );
      })}
    </div>
  );
}

export default function RecorderBar({
  isPaused,
  isStopping,
  isPausing,
  isResuming,
  isProcessing,
  recordingDuration,
  speechDetected,
  audioLevel = null,
  onPauseResume,
  onStop,
}: RecorderBarProps) {
  const controlsBusy = isStopping || isPausing || isResuming;

  return (
    <div className="flex min-w-[390px] items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-2 shadow-popover">
      <span
        className={`ml-1 h-2.5 w-2.5 rounded-full ${isPaused ? 'bg-warn' : 'bg-record'}`}
        aria-hidden="true"
      />
      <span className="min-w-[68px] font-mono text-caption tabular-nums text-text">
        {formatDuration(recordingDuration)}
      </span>

      <LevelMeter level={audioLevel} paused={isPaused} />

      <span className="min-w-0 flex-1 truncate text-caption text-3">
        {isProcessing
          ? 'Processing recording…'
          : isStopping
            ? 'Stopping…'
            : isPausing
              ? 'Pausing…'
              : isResuming
                ? 'Resuming…'
                : isPaused
                  ? 'Paused'
                  : speechDetected
                    ? 'Speech detected'
                    : 'Recording'}
      </span>

      <button
        type="button"
        onClick={onPauseResume}
        disabled={controlsBusy || isProcessing}
        className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border bg-bg text-text transition-colors duration-150 hover:bg-surface disabled:opacity-40"
        aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
      >
        {isPausing || isResuming ? (
          <LoaderCircle className="h-4 w-4 animate-spin" strokeWidth={1.75} />
        ) : isPaused ? (
          <Play className="h-4 w-4" fill="currentColor" strokeWidth={1.75} />
        ) : (
          <Pause className="h-4 w-4" fill="currentColor" strokeWidth={1.75} />
        )}
      </button>

      <button
        type="button"
        onClick={onStop}
        disabled={controlsBusy || isProcessing}
        className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-full bg-record text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
        aria-label="Stop recording"
      >
        {isStopping ? (
          <LoaderCircle className="h-4 w-4 animate-spin" strokeWidth={1.75} />
        ) : (
          <Square className="h-3.5 w-3.5" fill="currentColor" strokeWidth={1.75} />
        )}
      </button>
    </div>
  );
}
