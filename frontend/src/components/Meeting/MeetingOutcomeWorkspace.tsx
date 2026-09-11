'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronRight, Copy, Loader2, Mail, Pencil, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { useMeetingIntelligence } from '@/hooks/useMeetingIntelligence';
import type { CommitmentState, EvidenceReference, FollowupDraft, MeetingAction, MeetingActionUpdate, MeetingContext, MeetingFact } from '@/types/intelligence';

const button = 'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text hover:bg-bg disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
const input = 'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent';
const blank = (value: string) => value.trim() || null;

function Source({ evidence }: { evidence: EvidenceReference[] }) {
  const router = useRouter();
  const first = evidence.find(item => item.transcriptId || item.audioStartTime !== null);
  if (!first) return null;
  const open = () => {
    const query = new URLSearchParams({ id: first.meetingId, tab: 'transcript' });
    if (first.transcriptId) query.set('evidence', first.transcriptId);
    if (first.audioStartTime !== null) query.set('at', String(first.audioStartTime));
    router.push(`/meeting?${query}`);
  };
  return <button type="button" className={`${button} border-transparent text-3`} title={first.quote} onClick={open}>Related moment <ChevronRight size={12} /></button>;
}

function Fact({ fact, confirm, dismiss }: { fact: MeetingFact; confirm: (id: string) => Promise<void>; dismiss: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const act = async (operation: (id: string) => Promise<void>) => {
    setBusy(true);
    try { await operation(fact.id); } catch { toast.error('Could not save the review. Please retry.'); } finally { setBusy(false); }
  };
  return <article className="rounded-xl border border-border bg-surface p-4">
    <p className="text-sm leading-7 text-text">{fact.text}</p>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {fact.confirmed ? <span className="inline-flex items-center gap-1 text-xs text-accent"><Check size={12} /> Reviewed</span> : <button type="button" className={button} disabled={busy} onClick={() => void act(confirm)}>Confirm</button>}
      <Source evidence={fact.evidence} />
      <button type="button" className={`${button} ml-auto border-transparent text-3`} disabled={busy} aria-label={`Dismiss: ${fact.text}`} onClick={() => void act(dismiss)}><X size={13} /> Dismiss</button>
    </div>
  </article>;
}

function Task({ action, update, onEditing }: { action: MeetingAction; update: (value: MeetingActionUpdate) => Promise<MeetingAction>; onEditing: (id: string, editing: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(action.text);
  const [owner, setOwner] = useState(action.owner || '');
  const [due, setDue] = useState(action.dueAt || '');
  const [dueText, setDueText] = useState(action.dueText || '');
  const [commitment, setCommitment] = useState<CommitmentState>(action.commitmentState);
  const start = () => {
    setText(action.text); setOwner(action.owner || ''); setDue(action.dueAt || ''); setDueText(action.dueText || ''); setCommitment(action.commitmentState);
    onEditing(action.id, true); setEditing(true);
  };
  const finish = () => { onEditing(action.id, false); setEditing(false); };
  const save = async (changes: Partial<MeetingActionUpdate>) => {
    setBusy(true);
    try {
      await update({ actionId: action.id, text: action.text, owner: action.owner, dueAt: action.dueAt, dueText: action.dueText, status: action.status, commitmentState: action.commitmentState, confirmed: true, ...changes });
      finish();
    } catch { toast.error('Could not save this action. Your edits are still here.'); }
    finally { setBusy(false); }
  };
  return <article className="border-b border-border p-4 last:border-b-0 sm:p-5">
    {editing ? <form onSubmit={e => { e.preventDefault(); void save({ text: text.trim(), owner: blank(owner), dueAt: blank(due), dueText: blank(dueText), commitmentState: commitment }); }} className="space-y-3">
      <label className="block text-xs font-medium text-2">Action<textarea required className={`${input} mt-1 min-h-20`} value={text} onChange={e => setText(e.target.value)} /></label>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-2">Owner<input className={`${input} mt-1`} value={owner} onChange={e => setOwner(e.target.value)} placeholder="Leave blank when unknown" /></label><label className="text-xs text-2">Due date<input type="date" className={`${input} mt-1`} value={due} onChange={e => setDue(e.target.value)} /></label></div>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-2">Timing as discussed<input className={`${input} mt-1`} value={dueText} onChange={e => setDueText(e.target.value)} placeholder="For example, after the review" /></label><label className="text-xs text-2">Commitment<select className={`${input} mt-1`} value={commitment} onChange={e => setCommitment(e.target.value as CommitmentState)}><option value="detected">Not yet established</option><option value="proposed">Proposed, not agreed</option><option value="agreed">Explicitly agreed</option></select></label></div>
      <div className="flex gap-2"><button className={`${button} bg-accent-soft text-accent`} disabled={busy || !text.trim()} type="submit">{busy ? 'Saving…' : 'Save & confirm'}</button><button type="button" className={button} disabled={busy} onClick={finish}>Cancel</button></div>
    </form> : <>
      <div className="flex items-start gap-3"><button type="button" role="checkbox" aria-checked={action.status === 'done'} aria-label={`${action.status === 'done' ? 'Reopen' : 'Complete'}: ${action.text}`} disabled={busy} onClick={() => void save({ status: action.status === 'done' ? 'open' : 'done' })} className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-md border border-border bg-bg text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{action.status === 'done' && <Check size={13} />}</button>
        <div className="min-w-0 flex-1"><p className={`text-sm leading-7 text-text ${action.status === 'done' ? 'line-through opacity-60' : ''}`}>{action.text}</p>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-3"><span>{action.owner || 'Owner not specified'}</span><span>{action.dueAt || action.dueText || 'No deadline stated'}</span><span>{action.commitmentState === 'agreed' ? 'Agreed follow-up' : action.commitmentState === 'proposed' ? 'Proposed follow-up' : 'Commitment needs review'}</span></p>
        </div>
      </div>
      <div className="ml-8 mt-3 flex flex-wrap items-center gap-2">
        {action.confirmed ? <span className="inline-flex items-center gap-1 text-xs text-accent"><Check size={12} /> Reviewed</span> : <button type="button" className={`${button} bg-accent-soft text-accent`} disabled={busy} onClick={() => void save({})}>Confirm action</button>}
        <button type="button" className={button} disabled={busy} onClick={start}><Pencil size={12} /> Edit</button><Source evidence={action.evidence} />
        <button type="button" className={`${button} ml-auto border-transparent text-3`} disabled={busy} onClick={() => void save({ status: 'dismissed' })} aria-label={`Dismiss: ${action.text}`}><X size={13} /> Dismiss</button>
      </div>
    </>}
  </article>;
}

function ContextForm({ context, save }: { context: MeetingContext; save: (context: MeetingContext) => Promise<MeetingContext> }) {
  const [draft, setDraft] = useState(context); const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true); try { await save(draft); toast.success('Meeting context saved'); } catch { toast.error('Could not save meeting context'); } finally { setSaving(false); }
  };
  return <form className="mt-4 space-y-3" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-2">Project<input className={`${input} mt-1`} value={draft.project || ''} onChange={e => setDraft(p => ({ ...p, project: blank(e.target.value) }))} /></label><label className="text-xs text-2">Client<input className={`${input} mt-1`} value={draft.client || ''} onChange={e => setDraft(p => ({ ...p, client: blank(e.target.value) }))} /></label></div>
    <label className="block text-xs text-2">Participants, separated by commas<input className={`${input} mt-1`} defaultValue={draft.participants.join(', ')} onChange={e => setDraft(p => ({ ...p, participants: e.target.value.split(',').map(v => v.trim()).filter(Boolean) }))} /></label>
    <label className="block text-xs text-2">Agenda<textarea className={`${input} mt-1`} value={draft.agenda || ''} onChange={e => setDraft(p => ({ ...p, agenda: e.target.value }))} /></label>
    <button type="submit" className={button} disabled={saving}>{saving ? 'Saving…' : 'Save meeting context'}</button>
  </form>;
}

export default function MeetingOutcomeWorkspace({ meetingId }: { meetingId: string }) {
  const model = useMeetingIntelligence(meetingId);
  const [draft, setDraft] = useState<FollowupDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const editing = useRef(new Set<string>());
  useEffect(() => {
    editing.current.clear(); setDraft(null);
    const guard = (event: Event) => {
      const detail = (event as CustomEvent<{ meetingId: string }>).detail;
      if (detail?.meetingId === meetingId && editing.current.size > 0) event.preventDefault();
    };
    window.addEventListener('meetodds:before-summary-generation', guard);
    return () => window.removeEventListener('meetodds:before-summary-generation', guard);
  }, [meetingId]);
  const onEditing = (id: string, value: boolean) => { if (value) editing.current.add(id); else editing.current.delete(id); };
  const refresh = async () => {
    if (editing.current.size) { toast.info('Save or cancel your action edits before reloading.'); return; }
    try { await model.refresh(); } catch { /* Hook exposes the error and retains existing data. */ }
  };
  const followup = async () => {
    setDrafting(true); try { setDraft(await model.generateFollowup()); } catch { toast.error('Could not prepare the follow-up draft'); } finally { setDrafting(false); }
  };
  if (model.isLoading && !model.data) return <div role="status" className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-6 text-sm text-2"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" />Preparing the outcome from your saved AI summary…</div>;
  const data = model.data;
  if (!data) return <div role="alert" className="rounded-xl border border-border bg-surface p-5"><p className="text-sm text-2">{model.error || 'The outcome is not available yet.'}</p><button type="button" className={`${button} mt-3`} onClick={() => void refresh()} disabled={model.isRefreshing}>Reload from saved summary</button></div>;
  const canDraft = Boolean(data.decisions.some(item => item.confirmed) || data.actions.some(item => item.confirmed));
  return <div className="space-y-5">
    {model.error && <p role="alert" className="rounded-xl border border-border bg-surface p-4 text-sm text-danger">{model.error}</p>}
    {data.outcome && <section aria-labelledby="outcome-heading" className="rounded-2xl border border-border bg-accent-soft p-5 sm:p-6"><h3 id="outcome-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[.13em] text-accent">Meeting outcome</h3><p className="text-lg leading-8 text-text">{data.outcome.text}</p><div className="mt-3 flex items-center gap-2">{data.outcome.confirmed ? <span className="text-xs text-accent">Reviewed</span> : <button type="button" className={button} onClick={() => void model.confirmFact(data.outcome!.id).catch(() => toast.error('Could not confirm outcome'))}>Confirm outcome</button>}<Source evidence={data.outcome.evidence} /></div></section>}
    <section aria-labelledby="actions-heading" className="overflow-hidden rounded-2xl border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4"><div><h3 id="actions-heading" className="text-base font-semibold text-text">Next steps <span className="ml-2 text-xs font-normal text-3">{data.actions.filter(a => a.status !== 'done').length} open</span></h3><p className="mt-1 text-xs leading-5 text-3">Written by your AI, not assembled from transcript fragments. Confirm what is useful.</p></div><button type="button" className={button} onClick={() => void refresh()} disabled={model.isRefreshing}><RefreshCw size={13} className={model.isRefreshing ? 'animate-spin motion-reduce:animate-none' : ''} /> Reload</button></header>
      {data.actions.length ? data.actions.map(action => <Task key={action.id} action={action} update={model.updateAction} onEditing={onEditing} />) : <div className="px-5 py-7"><p className="text-sm font-medium text-text">No action items in this AI summary.</p><p className="mt-1 text-xs leading-6 text-3">Not every meeting creates work. Nothing has been invented to fill this space.</p></div>}
    </section>
    {data.decisions.length > 0 && <section aria-labelledby="decisions-heading"><h3 id="decisions-heading" className="mb-3 text-sm font-semibold text-text">Decisions</h3><div className="grid gap-3 lg:grid-cols-2">{data.decisions.map(fact => <Fact key={fact.id} fact={fact} confirm={model.confirmFact} dismiss={model.dismissFact} />)}</div></section>}
    {data.openQuestions.length > 0 && <details className="rounded-xl border border-border bg-surface p-4"><summary className="cursor-pointer text-sm font-medium text-text">Still open <span className="ml-2 text-xs text-3">{data.openQuestions.length} questions</span></summary><div className="mt-3 grid gap-3">{data.openQuestions.map(fact => <Fact key={fact.id} fact={fact} confirm={model.confirmFact} dismiss={model.dismissFact} />)}</div></details>}
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-[560px] text-xs leading-5 text-3">Confirmed edits, completed tasks, and dismissed suggestions are kept when you regenerate. Source links identify related moments; they are not automatic proof of agreement.</p><button type="button" className={button} disabled={!canDraft || drafting} onClick={() => void followup()}><Mail size={14} />{drafting ? 'Preparing…' : 'Draft a follow-up'}</button></div>
    {draft && <section className="rounded-xl border border-border bg-surface p-5"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-text">{draft.subject}</h3><button type="button" className={button} onClick={() => { void navigator.clipboard.writeText(`${draft.subject}\n\n${draft.body}`).then(() => toast.success('Follow-up copied'), () => toast.error('Clipboard unavailable')); }}><Copy size={13} />Copy</button></div><pre className="mt-4 whitespace-pre-wrap break-words font-sans text-sm leading-7 text-2">{draft.body}</pre><p className="mt-3 text-xs text-3">Uses reviewed decisions and actions only. Nothing is sent automatically.</p></section>}
    <details className="rounded-xl border border-border bg-surface p-4"><summary className="cursor-pointer text-sm font-medium text-2">Meeting context & related meetings</summary><ContextForm key={meetingId} context={data.context} save={model.saveContext} />
      {model.preparation && <div className="mt-5 border-t border-border pt-4"><p className="text-xs font-medium text-2">{model.preparation.scopeLabel}</p>{[...model.preparation.priorDecisions, ...model.preparation.openActions, ...model.preparation.openQuestions].map((item, index) => <div key={`${item.meetingId}-${index}`} className="mt-3 text-sm leading-6 text-2"><span>{item.text}</span>{item.evidence && <Source evidence={[item.evidence]} />}</div>)}</div>}
    </details>
  </div>;
}
