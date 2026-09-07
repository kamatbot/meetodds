'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  Pause,
  Play,
  Volume2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';
import type { MeetingExportInfo } from '@/types/meeting';

interface AudioPlayerProps {
  meetingId: string;
  initialSeek?: number | null;
}

function formatTime(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '--:--';
  const totalSeconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default function AudioPlayer({ meetingId, initialSeek = null }: AudioPlayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const appliedEvidenceSeekRef = useRef<string | null>(null);
  const [info, setInfo] = useState<MeetingExportInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(true);
  const [infoError, setInfoError] = useState<string | null>(null);
  const {
    isLoading,
    isPlaying,
    currentTime,
    duration,
    playbackRate,
    error,
    play,
    pause,
    seek,
    seekBy,
    setPlaybackRate,
  } = useAudioPlayer(info?.audioPath ?? null);

  useEffect(() => {
    if (initialSeek == null || !Number.isFinite(initialSeek) || duration == null) return;
    const key = `${meetingId}:${initialSeek}`;
    if (appliedEvidenceSeekRef.current === key) return;
    appliedEvidenceSeekRef.current = key;
    // Start slightly before the cited words so the user hears their context.
    seek(Math.max(0, initialSeek - 1.5));
  }, [duration, initialSeek, meetingId, seek]);

  useEffect(() => {
    appliedEvidenceSeekRef.current = null;
  }, [initialSeek, meetingId]);

  const loadInfo = useCallback(async () => {
    setInfoLoading(true);
    setInfoError(null);
    try {
      const response = await invoke<MeetingExportInfo>('api_get_meeting_export_info', {
        meetingId,
      });
      setInfo(response);
    } catch (loadError) {
      console.error('[AudioPlayer] Failed to load audio metadata:', loadError);
      setInfo(null);
      setInfoError(messageFromError(loadError));
    } finally {
      setInfoLoading(false);
    }
  }, [meetingId]);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        if (isPlaying) pause();
        else void play();
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        seekBy(-5);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        seekBy(5);
      }
    };

    root.addEventListener('keydown', handleKeyDown);
    return () => root.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, pause, play, seekBy]);

  const revealAudio = async () => {
    try {
      await invoke<void>('api_reveal_meeting_audio', { meetingId });
    } catch (revealError) {
      console.error('[AudioPlayer] Failed to reveal recording:', revealError);
      toast.error('Could not reveal recording', {
        description: messageFromError(revealError),
      });
    }
  };

  if (infoLoading) {
    return (
      <div className="flex h-12 shrink-0 items-center justify-center border-t border-border bg-surface text-caption text-3">
        <LoaderCircle className="mr-2 h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
        Loading saved audio…
      </div>
    );
  }

  if (infoError) {
    return (
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-t border-border bg-surface px-4 text-caption">
        <span className="truncate text-danger">Audio metadata unavailable</span>
        <button
          type="button"
          onClick={() => void loadInfo()}
          className="rounded-control border border-border bg-bg px-2.5 py-1 text-text hover:bg-surface"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!info?.hasAudio || !info.audioPath) {
    return (
      <div className="flex h-12 shrink-0 items-center gap-2 border-t border-border bg-surface px-4 text-caption text-3">
        <Volume2 className="h-4 w-4" strokeWidth={1.75} />
        No audio saved for this meeting
      </div>
    );
  }

  const controlsDisabled = isLoading || duration == null;
  const progressMax = duration ?? 1;
  const progressValue = duration == null ? 0 : Math.min(currentTime, duration);

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      aria-label="Meeting audio player"
      className="flex h-14 shrink-0 items-center gap-2 border-t border-border bg-surface px-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    >
      <button
        type="button"
        onClick={() => isPlaying ? pause() : void play()}
        disabled={controlsDisabled}
        className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
        aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
      >
        {isLoading ? (
          <LoaderCircle className="h-4 w-4 animate-spin" strokeWidth={1.75} />
        ) : isPlaying ? (
          <Pause className="h-4 w-4" fill="currentColor" strokeWidth={1.75} />
        ) : (
          <Play className="h-4 w-4" fill="currentColor" strokeWidth={1.75} />
        )}
      </button>

      <button
        type="button"
        onClick={() => seekBy(-5)}
        disabled={controlsDisabled}
        className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-control text-2 hover:bg-bg hover:text-text disabled:opacity-35"
        aria-label="Seek back 5 seconds"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
      </button>

      <div className="min-w-0 flex-1">
        <input
          type="range"
          min={0}
          max={progressMax}
          step={0.05}
          value={progressValue}
          disabled={controlsDisabled}
          onChange={(event) => seek(Number(event.target.value))}
          aria-label="Audio position"
          className="block w-full accent-accent disabled:opacity-35"
        />
        <div className="mt-0.5 flex justify-between font-mono text-[10px] tabular-nums text-3">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => seekBy(5)}
        disabled={controlsDisabled}
        className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-control text-2 hover:bg-bg hover:text-text disabled:opacity-35"
        aria-label="Seek forward 5 seconds"
      >
        <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
      </button>

      <select
        value={playbackRate}
        onChange={(event) => setPlaybackRate(Number(event.target.value))}
        aria-label="Playback speed"
        className="h-7 rounded-control border border-border bg-bg px-1.5 text-caption text-text outline-none focus:border-accent"
      >
        <option value={0.75}>0.75×</option>
        <option value={1}>1×</option>
        <option value={1.25}>1.25×</option>
        <option value={1.5}>1.5×</option>
        <option value={2}>2×</option>
      </select>

      <button
        type="button"
        onClick={() => void revealAudio()}
        className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-control text-2 hover:bg-bg hover:text-text"
        aria-label="Reveal recording in Finder"
        title="Reveal recording in Finder"
      >
        <FolderOpen className="h-4 w-4" strokeWidth={1.75} />
      </button>

      {error && <span className="max-w-[180px] truncate text-caption text-danger">{error}</span>}
    </div>
  );
}
