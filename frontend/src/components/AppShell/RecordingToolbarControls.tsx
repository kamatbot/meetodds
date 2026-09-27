'use client';

import { useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { ArrowLeft, Pause, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useRecordingPostProcessing } from '@/contexts/RecordingPostProcessingProvider';

/** Keep capture controllable while reading a different meeting or Settings.
 * The main live view already owns its recorder bar. Reuse the app-level stop
 * finalizer: the raw native stop command does not emit the tray's completion event.
 */
export default function RecordingToolbarControls() {
  const pathname = usePathname();
  const router = useRouter();
  const { isRecording, isPaused, isStopping, isProcessing } = useRecordingState();
  const finishRecording = useRecordingPostProcessing();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  if (pathname === '/' || !isRecording) return null;

  const control = async (stop: boolean) => {
    if (pending.current || isStopping || isProcessing) return;
    pending.current = true;
    setBusy(true);
    try {
      if (stop) {
        const directory = await appDataDir();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await invoke('stop_recording', { args: { save_path: `${directory}/recording-${stamp}.wav` } });
        await finishRecording(true);
      } else {
        await invoke(isPaused ? 'resume_recording' : 'pause_recording');
      }
    } catch {
      toast.error(stop ? 'Could not stop recording' : `Could not ${isPaused ? 'resume' : 'pause'} recording`, {
        description: 'Return to the live meeting to check its state and retry.',
      });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const disabled = busy || isStopping || isProcessing;
  const button = 'inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-caption text-text disabled:opacity-50';
  return <div className="flex items-center gap-1.5" aria-label="Active meeting controls">
    <button type="button" onClick={() => router.push('/')} className={button} aria-label="Return to live meeting"><ArrowLeft size={14} />Live</button>
    <button type="button" onClick={() => void control(false)} disabled={disabled} className={button}>
      {isPaused ? <Play size={14} /> : <Pause size={14} />}{isPaused ? 'Resume' : 'Pause'}
    </button>
    <button type="button" onClick={() => void control(true)} disabled={disabled} className={`${button} text-danger`}><Square size={13} />Stop</button>
  </div>;
}
