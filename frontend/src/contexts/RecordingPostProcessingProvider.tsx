'use client';

import React, { createContext, useContext, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useRecordingStop } from '@/hooks/useRecordingStop';

const RecordingPostProcessingContext = createContext<((callApi: boolean) => Promise<void>) | null>(null);

export function useRecordingPostProcessing() {
  const finish = useContext(RecordingPostProcessingContext);
  if (!finish) throw new Error('Recording controls must be inside RecordingPostProcessingProvider');
  return finish;
}

/**
 * RecordingPostProcessingProvider
 *
 * This provider handles post-processing when recording stops from any source:
 * - Tray menu stop
 * - Global keyboard shortcut
 * - Overlay stop button
 * - Main UI stop button
 *
 * It listens for the 'recording-stop-complete' event from Rust backend
 * and triggers the full post-processing flow (save to database, navigate, analytics)
 * regardless of which page the user is currently on.
 */
export function RecordingPostProcessingProvider({ children }: { children: React.ReactNode }) {
  // No-op functions since the global RecordingStateContext already handles state updates
  // These are only needed for the hook's local component state management
  const setIsRecording = () => { };
  const setIsRecordingDisabled = () => { };

  const {
    handleRecordingStop,
  } = useRecordingStop(setIsRecording, setIsRecordingDisabled);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let disposed = false;

    const setupListener = async () => {
      try {
        // Listen for recording-stop-complete event from Rust
        const unlisten = await listen<boolean>('recording-stop-complete', (event) => {
          if (disposed) return;
          console.log('[RecordingPostProcessing] Received recording-stop-complete event:', event.payload);

          // Call the post-processing handler
          // event.payload is the callApi boolean (true for normal stops)
          void handleRecordingStop(event.payload);
        });
        if (disposed) unlisten();
        else unlistenFn = unlisten;

        console.log('[RecordingPostProcessing] Event listener set up successfully');
      } catch (error) {
        console.error('[RecordingPostProcessing] Failed to set up event listener:', error);
      }
    };

    setupListener();

    return () => {
      disposed = true;
      if (unlistenFn) {
        console.log('[RecordingPostProcessing] Cleaning up event listener');
        unlistenFn();
      }
    };
  }, [handleRecordingStop]);

  return <RecordingPostProcessingContext.Provider value={handleRecordingStop}>{children}</RecordingPostProcessingContext.Provider>;
}
