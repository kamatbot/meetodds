'use client';

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import * as Dialog from '@radix-ui/react-dialog';

interface SourceCheck {
  deviceName: string | null; source: string; status: string; samplesReceived: number;
  rms: number; peak: number; message: string;
}
interface Preflight {
  microphone: SourceCheck; systemAudio: SourceCheck;
  audioRetained: boolean; recordingFolder: string; storageWritable: boolean; storageMessage: string;
}
export interface CaptureChoice { microphone: string; systemAudio: string | null }

function Review({ microphone, systemAudio, finish }: { microphone: string | null; systemAudio: string | null; finish: (choice: CaptureChoice | null) => void }) {
  const [includeSystem, setIncludeSystem] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Preflight | null>(null);
  const [acknowledgeSilence, setAcknowledgeSilence] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setResult(null); setAcknowledgeSilence(false); setConsent(false); }, [includeSystem]);
  const test = async () => {
    if (busy) return;
    setBusy(true); setResult(null); setError(null); setAcknowledgeSilence(false);
    try {
      setResult(await invoke<Preflight>('run_capture_preflight', {
        micDeviceName: microphone, systemDeviceName: systemAudio, includeSystem,
      }));
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(/preferences/i.test(message) ? 'Recording preferences could not be read. Open recording settings and verify retention and storage before retrying.' : 'The audio test could not complete. Check permissions and selected devices, then retry.');
    } finally { setBusy(false); }
  };
  const usable = (source: SourceCheck) => source.status === 'signal' || source.status === 'silent';
  const sources = result ? [result.microphone, ...(includeSystem ? [result.systemAudio] : [])] : [];
  const silent = sources.some(source => source.status === 'silent');
  const ready = Boolean(result?.storageWritable && sources.length && sources.every(usable) && (!silent || acknowledgeSilence) && consent);
  const button = 'rounded-control border border-border px-3 py-2 text-ui font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40';
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) finish(null); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/40" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-[101] max-h-[85vh] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card border border-border bg-surface p-6 text-text shadow-xl">
        <Dialog.Title className="text-title">Check your recording</Dialog.Title>
        <Dialog.Description className="mt-2 text-ui text-2">Speak and play a little meeting audio during the test. Test samples are discarded locally and are not transcribed or sent to a provider.</Dialog.Description>
        <label className="mt-4 flex items-center gap-2 text-ui"><input type="checkbox" checked={includeSystem} disabled={busy} onChange={event => setIncludeSystem(event.target.checked)} /> Capture system audio as well as my microphone</label>
        {!includeSystem && <p className="mt-2 text-caption text-warn">Microphone-only mode may not hear remote participants. This is an explicit choice, not an automatic fallback.</p>}
        <button type="button" className={`${button} mt-4`} disabled={busy} onClick={() => void test()}>{busy ? 'Listening to actual audio sources…' : result ? 'Test audio again' : 'Test audio'}</button>
        <div className="mt-4 space-y-3" aria-live="polite">
          {sources.map(source => <div key={source.source} className="rounded-control border border-border p-3">
            <div className="flex items-center justify-between gap-3 text-ui"><strong>{source.source === 'microphone' ? 'Microphone' : 'System audio'}</strong><span>{source.status === 'signal' ? 'Signal received' : source.status === 'silent' ? 'Open, but silent' : source.status === 'permission_denied' ? 'Permission needed' : 'Not verified'}</span></div>
            <p className="mt-1 break-all text-caption text-2">{source.deviceName || 'No source selected'}</p>
            <p className="mt-1 text-caption text-2">{source.message}</p>
            {source.samplesReceived > 0 && <meter aria-label={`${source.source} measured level`} min={0} max={1} value={Math.min(1, source.rms)} className="mt-2 h-2 w-full" />}
          </div>)}
          {result && <div className="rounded-control border border-border p-3 text-caption text-2">
            <p className="text-ui font-semibold text-text">{result.audioRetained ? 'Audio will be kept on this device' : 'Transcript only · audio will not be retained'}</p>
            <p className="mt-1">{result.audioRetained ? 'Retained audio supports playback and re-transcription.' : 'There will be no saved audio for playback, repair, or re-transcription.'}</p>
            <p className="mt-2 break-all">Folder: {result.recordingFolder}</p>
            <p className={result.storageWritable ? 'mt-1' : 'mt-1 text-danger'}>{result.storageMessage}</p>
          </div>}
        </div>
        {silent && <label className="mt-4 flex items-start gap-2 text-ui"><input type="checkbox" className="mt-1" checked={acknowledgeSilence} onChange={event => setAcknowledgeSilence(event.target.checked)} /> I understand a selected source was silent during testing and choose to continue.</label>}
        <label className="mt-4 flex items-start gap-2 text-ui"><input type="checkbox" className="mt-1" checked={consent} onChange={event => setConsent(event.target.checked)} /> Participants are informed and I am ready to record with these capture and retention settings.</label>
        {error && <p role="alert" className="mt-3 text-ui text-danger">{error}</p>}
        <p className="mt-3 text-caption text-2">Pause excludes new audio from transcription and the saved recording. Previously captured words may finish processing. Change retention in Recording settings before starting.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={button} disabled={busy} onClick={() => finish(null)}>Cancel</button>
          <button type="button" className={`${button} bg-accent text-white`} disabled={busy || !ready} onClick={() => {
            if (result && ready && result.microphone.deviceName) finish({ microphone: result.microphone.deviceName, systemAudio: includeSystem ? result.systemAudio.deviceName : null });
          }}>Start recording</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function reviewCaptureStart(microphone: string | null, systemAudio: string | null, signal: AbortSignal): Promise<CaptureChoice | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const trigger = document.activeElement;
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host); let settled = false;
    const finish = (result: CaptureChoice | null) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', abort); resolve(result);
      queueMicrotask(() => { root.unmount(); host.remove(); if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus(); });
    };
    const abort = () => finish(null);
    signal.addEventListener('abort', abort, { once: true });
    root.render(<Review microphone={microphone} systemAudio={systemAudio} finish={finish} />);
  });
}
