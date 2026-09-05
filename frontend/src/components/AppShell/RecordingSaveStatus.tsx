'use client';

import { useEffect, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { CheckCircle2, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { captureStatusCopy, initialCaptureStatus, reduceCaptureStatus, retainedAudioFromReceipt } from '@/lib/capture-status';

/** Lives in the shell, so changing meeting pages does not lose the save receipt. */
export default function RecordingSaveStatus() {
  const [state, dispatch] = useReducer(reduceCaptureStatus, initialCaptureStatus);
  const router = useRouter();
  useEffect(() => {
    let disposed = false;
    const subscriptions: UnlistenFn[] = [];
    const subscribe = async <T,>(name: string, handle: (payload: T) => void) => {
      try {
        const unsubscribe = await listen<T>(name, (event) => { if (!disposed) handle(event.payload); });
        if (disposed) unsubscribe(); else subscriptions.push(unsubscribe);
      } catch { /* Absence of native events is not a save acknowledgement (e.g. browser preview). */ }
    };
    void subscribe('recording-started', () => dispatch({ type: 'started' }));
    void subscribe('recording-paused', () => dispatch({ type: 'paused' }));
    void subscribe('recording-resumed', () => dispatch({ type: 'resumed' }));
    void subscribe('recording-stopped', () => dispatch({ type: 'stopped' }));
    void subscribe('recording-saved', (payload) => dispatch({ type: 'saved', audioRetained: retainedAudioFromReceipt(payload) }));
    // Additive event from the capture branch; harmless when run independently on older main.
    void subscribe('recording-save-failed', () => dispatch({ type: 'failed' }));
    void subscribe<{ stage?: string }>('recording-shutdown-progress', (payload) => {
      if (payload?.stage && payload.stage !== 'complete') dispatch({ type: 'finishing' });
    });
    return () => { disposed = true; subscriptions.forEach((unsubscribe) => unsubscribe()); };
  }, []);
  const copy = captureStatusCopy(state);
  if (!copy) return null;
  const saved = state.saved !== 'unconfirmed';
  const Icon = copy.warning ? TriangleAlert : saved ? CheckCircle2 : LoaderCircle;
  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-border bg-surface px-4 py-3" role={copy.warning ? 'alert' : 'status'} aria-live={copy.warning ? 'assertive' : 'polite'} aria-atomic="true">
      <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${copy.warning ? 'text-warn' : saved ? 'text-success' : 'animate-spin text-accent'}`} />
      <div className="min-w-0 flex-1">
        <p className="text-ui font-semibold text-text">{copy.title}</p>
        <p className="mt-0.5 break-words text-caption text-2">{copy.detail}</p>
      </div>
      {copy.warning && <button type="button" onClick={() => router.push('/')} className="shrink-0 rounded-control border border-border px-2.5 py-1.5 text-caption font-medium text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Review recovery</button>}
      <button type="button" onClick={() => dispatch({ type: 'dismissed' })} aria-label="Dismiss recording status" className="shrink-0 rounded-control p-1.5 text-2 hover:bg-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><X aria-hidden="true" className="h-4 w-4" /></button>
    </div>
  );
}
