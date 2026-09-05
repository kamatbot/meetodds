'use client';

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Dialog from '@radix-ui/react-dialog';
import { approveSummaryInput, type ApprovedSummaryInput, type SummaryReviewInput } from '@/lib/summary-input';

function Review({ input, finish }: { input: SummaryReviewInput; finish: (result: ApprovedSummaryInput | null) => void }) {
  const [includeNotes, setIncludeNotes] = useState(false);
  const [notes, setNotes] = useState(input.notes);
  const [includeManualNotes, setIncludeManualNotes] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const target = input.target;
  const requiresSendConfirmation = !target.local && target.provider !== 'openai-codex';
  const hasManualNotes = Boolean(input.manualNotes.trim());
  const approve = () => {
    try { finish(approveSummaryInput(input, includeNotes, notes, includeManualNotes)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The selected input could not be prepared.'); }
  };
  const copy = async () => {
    try {
      const selected = approveSummaryInput(input, includeNotes, notes, includeManualNotes);
      await navigator.clipboard.writeText(`${selected.customPrompt}\n\nTemplate: ${input.template}\n\n${selected.text}`);
      setCopied(true);
    } catch { setError('Could not copy the selected text. Review its size or try again.'); }
  };
  const button = 'rounded-control border border-border px-3 py-2 text-ui font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) finish(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[101] flex max-h-[85vh] w-[min(680px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface p-5 text-text shadow-xl" onOpenAutoFocus={(event) => { event.preventDefault(); document.getElementById('summary-review-cancel')?.focus(); }}>
          <Dialog.Title className="text-lg font-semibold">Review summary input</Dialog.Title>
          <Dialog.Description className="mt-1 text-ui text-2">{target.local ? 'Review the text to process with the selected local provider.' : 'Review the text that will leave this device. Audio is not included in this summary request.'}</Dialog.Description>
          <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <div className="rounded-control border border-border p-3 text-ui">
              <p className="font-semibold">{target.label}</p><p className="mt-1 break-all text-caption text-2">{target.destination}</p>
              <p className="mt-1 text-caption text-2">Model: {target.model} · Template: {input.template}</p>
              {target.provider === 'openai-codex' && <p className="mt-2 text-caption text-2">Uses your account's Codex allowance, not API credit. OpenAI account and workspace policies apply.</p>}
              {target.local && target.provider !== 'builtin-ai' && <p className="mt-2 text-caption text-2">This endpoint is on loopback. Its server configuration determines whether it forwards data elsewhere.</p>}
            </div>
            <details className="rounded-control border border-border p-3">
              <summary className="cursor-pointer text-ui font-medium">Saved transcript · {input.transcript.length.toLocaleString()} characters</summary>
              <pre className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-caption leading-6">{input.transcript}</pre>
            </details>
            {hasManualNotes && (
              <div>
                <label className="flex items-start gap-2 text-ui font-medium"><input type="checkbox" className="mt-1" checked={includeManualNotes} onChange={(event) => { setIncludeManualNotes(event.target.checked); setCopied(false); }} /> Include notes taken during the meeting</label>
                {includeManualNotes && <pre className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-caption leading-6">{input.manualNotes}</pre>}
              </div>
            )}
            <div>
              <label className="flex items-start gap-2 text-ui font-medium"><input type="checkbox" className="mt-1" checked={includeNotes} onChange={(event) => { setIncludeNotes(event.target.checked); setCopied(false); }} /> Enhance with selected personal notes</label>
              <p className="mt-1 text-caption text-2">Excluded by default. Including notes allows them to influence the generated summary; review the result before sharing. Your original notes are not edited.</p>
              {input.notesUnavailable && <p className="mt-2 text-caption text-warn">Saved notes could not be loaded. Continue without them or paste an excerpt below.</p>}
              {includeNotes && <textarea aria-label="Personal notes selected for summary" value={notes} onChange={(event) => { setNotes(event.target.value); setCopied(false); }} rows={5} className="mt-2 w-full resize-y rounded-control border border-border bg-bg p-3 text-ui leading-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" placeholder="Paste only the observations you want the AI to use…" />}
            </div>
            {input.prompt.trim() && <details className="text-ui"><summary className="cursor-pointer">Additional instructions</summary><pre className="mt-2 whitespace-pre-wrap break-words text-caption">{input.prompt}</pre></details>}
            {requiresSendConfirmation && <label className="flex items-start gap-2 rounded-control border border-border p-3 text-ui"><input type="checkbox" className="mt-1" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I approve sending the transcript, selected notes, and instructions to this provider for this summary.</span></label>}
            {error && <p role="alert" className="text-ui text-danger">{error}</p>}
            {copied && <p role="status" className="text-caption text-2">Selected text copied. The clipboard may be shared with other apps or devices by your operating system.</p>}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
            <button type="button" onClick={() => void copy()} className={`${button} mr-auto`}>Copy for ChatGPT</button>
            <button id="summary-review-cancel" type="button" onClick={() => finish(null)} className={button}>Cancel</button>
            <button type="button" disabled={requiresSendConfirmation && !confirmed} onClick={approve} className={`${button} bg-accent text-white disabled:cursor-not-allowed disabled:opacity-40`}>{includeNotes ? (target.local ? 'Generate locally' : 'Send selected text') : 'Skip notes & generate'}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Lazy imperative dialog, owned by the request; navigation/abort settles without dispatch. */
export function reviewSummaryInput(input: SummaryReviewInput, signal: AbortSignal): Promise<ApprovedSummaryInput | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const trigger = document.activeElement;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const finish = (result: ApprovedSummaryInput | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(result);
      queueMicrotask(() => {
        root.unmount(); host.remove();
        if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
      });
    };
    const abort = () => finish(null);
    signal.addEventListener('abort', abort, { once: true });
    root.render(<Review input={input} finish={finish} />);
  });
}
