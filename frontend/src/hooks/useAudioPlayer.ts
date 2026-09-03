'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

export const useAudioPlayer = (audioPath: string | null) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackRateRef = useRef(1);
  const [isLoading, setIsLoading] = useState(Boolean(audioPath));
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(null);
    setError(null);

    if (!audioPath) {
      setIsLoading(false);
      audioRef.current = null;
      return;
    }

    setIsLoading(true);

    const audio = new Audio();
    audio.preload = 'metadata';
    audio.playbackRate = playbackRateRef.current;
    audioRef.current = audio;

    let disposed = false;
    let fallbackAttempted = false;
    let fallbackUrl: string | null = null;

    const handleLoadedMetadata = () => {
      const nextDuration = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : null;
      setDuration(nextDuration);
      setCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
      setIsLoading(false);
      setError(nextDuration === null ? 'Audio duration is unavailable' : null);
    };

    const handleDurationChange = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };

    const handleTimeUpdate = () => {
      if (Number.isFinite(audio.currentTime)) {
        setCurrentTime(audio.currentTime);
      }
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(Number.isFinite(audio.duration) ? audio.duration : 0);
    };

    const handleError = async () => {
      if (disposed) return;

      // Tauri's fast asset-protocol path is intentionally scoped. Saved recordings
      // may live outside that scope (the default macOS recording folder is under
      // Movies and users can choose another folder), so fall back once to the
      // pre-existing native file-read command using the native-confirmed audio path.
      // This avoids widening the application's asset-protocol permissions globally.
      if (!fallbackAttempted) {
        fallbackAttempted = true;
        try {
          const bytes = await invoke<number[]>('read_audio_file', { filePath: audioPath });
          if (disposed) return;

          fallbackUrl = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: 'audio/mp4' }),
          );
          audio.src = fallbackUrl;
          audio.playbackRate = playbackRateRef.current;
          audio.load();
          return;
        } catch (fallbackError) {
          console.error('[AudioPlayer] Native audio fallback failed:', fallbackError);
        }
      }

      setIsPlaying(false);
      setIsLoading(false);
      setError('Saved audio could not be played');
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    try {
      audio.src = convertFileSrc(audioPath);
      audio.load();
    } catch (loadError) {
      console.error('[AudioPlayer] Failed to create asset-protocol source:', loadError);
      void handleError();
    }

    return () => {
      disposed = true;
      audio.pause();
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
      audio.removeAttribute('src');
      audio.load();
      if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
      if (audioRef.current === audio) {
        audioRef.current = null;
      }
    };
  }, [audioPath]);

  useEffect(() => {
    playbackRateRef.current = playbackRate;
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      await audio.play();
      setError(null);
    } catch (playError) {
      console.error('[AudioPlayer] Playback failed:', playError);
      setError('Saved audio could not be played');
      setIsPlaying(false);
    }
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const maxTime = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : Math.max(0, time);
    const nextTime = Math.max(0, Math.min(maxTime, time));
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }, []);

  const seekBy = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    seek(audio.currentTime + seconds);
  }, [seek]);

  const setPlaybackRate = useCallback((rate: number) => {
    if (!Number.isFinite(rate)) return;
    const nextRate = Math.max(0.75, Math.min(2, rate));
    setPlaybackRateState(nextRate);
  }, []);

  return {
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
  };
};
