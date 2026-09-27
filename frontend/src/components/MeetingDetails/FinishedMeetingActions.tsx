'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronRight, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { useMeetingIntelligence } from '@/hooks/useMeetingIntelligence';
import type { CommitmentState, EvidenceReference, MeetingAction, MeetingActionUpdate } from '@/types/intelligence';
import { visibleMeetingActions } from '@/lib/finished-meeting-state';

const quietButton = 'inline-flex min-h-7 items-center gap-1 rounded-md px-2 py-1 text-xs text-3 hover:bg-bg hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';
const field = 'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none focus:border-accent';

function timestamp(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

function EvidenceLink({ evidence }: { evidence: EvidenceReference[] }) {
  const router = useRouter();
  const source = evidence.find(item => item.transcriptId || typeof item.audioStartTime === 'number');
  if (!source) return null;

  const sourceTime = typeof source.audioStartTime === 'number' ? timestamp(source.audioStartTime) : null;
  const openSource = () => {
    const query = new URLSearchParams({ id: source.meetingId, tab: 'transcript' });
    if (source.transcriptId) query.set('evidence', source.transcriptId);
    if (typeof source.audioStartTime === 'number') query.set('at', String(source.audioStartTime));
    router.push(`/meeting?${query}`);
  };

  return <button type="button" className={quietButton} onClick={openSource} title={source.quote} aria-label={`Show transcript source${sourceTime ? ` at ${sourceTime}` : ''}`}>
    {sourceTime ? `Source · ${sourceTime}` : 'Show source'} <ChevronRight size={12} />
  </button>;
}

function ActionItem({ action, update, onEditing }: {
  action: MeetingAction;
  update: (value: MeetingActionUpdate) => Promise<MeetingAction>;
  onEditing: (id: string, editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState(action.text);
  const [owner, setOwner] = useState(action.owner || '');
  const [dueAt, setDueAt] = useState(action.dueAt || '');
  const [dueText, setDueText] = useState(action.dueText || '');
  const [commitmentState, setCommitmentState] = useState<CommitmentState>(action.commitmentState);

  useEffect(() => {
    if (editing) return;
    setText(action.text);
    setOwner(action.owner || '');
    setDueAt(action.dueAt || '');
    setDueText(action.dueText || '');
    setCommitmentState(action.commitmentState);
  }, [action, editing]);

  const finishEditing = () => {
    onEditing(action.id, false);
    setEditing(false);
  };

  const save = async (changes: Partial<MeetingActionUpdate>) => {
    setSaving(true);
    try {
      await update({
        actionId: action.id,
        text: action.text,
        owner: action.owner,
        dueAt: action.dueAt,
        dueText: action.dueText,
        status: action.status,
        commitmentState: action.commitmentState,
        confirmed: action.confirmed,
        ...changes,
      });
      finishEditing();
    } catch {
      toast.error('Could not save this action. Your edits are still here.');
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void save({
      text: text.trim(),
      owner: owner.trim() || null,
      dueAt: dueAt.trim() || null,
      dueText: dueText.trim() || null,
      commitmentState,
    });
  };

  if (editing) return <li className="border-b border-border py-3 last:border-b-0">
    <form onSubmit={submit} className="space-y-2.5">
      <label className="block text-xs text-2">Action<textarea required className={`${field} mt-1 min-h-16 resize-y`} value={text} onChange={event => setText(event.target.value)} /></label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-2">Owner<input className={`${field} mt-1`} value={owner} onChange={event => setOwner(event.target.value)} placeholder="Leave blank when unknown" /></label>
        <label className="text-xs text-2">Due date<input type="date" className={`${field} mt-1`} value={dueAt} onChange={event => setDueAt(event.target.value)} /></label>
      </div>
      <label className="block text-xs text-2">Timing as discussed<input className={`${field} mt-1`} value={dueText} onChange={event => setDueText(event.target.value)} placeholder="Leave blank when unstated" /></label>
      <label className="block text-xs text-2">Commitment<select className={`${field} mt-1`} value={commitmentState} onChange={event => setCommitmentState(event.target.value as CommitmentState)}><option value="detected">Needs review</option><option value="proposed">Proposed</option><option value="agreed">Agreed</option></select></label>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={saving || !text.trim()} className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-foreground disabled:opacity-50">{saving ? 'Saving…' : 'Save edits'}</button>
        <button type="button" disabled={saving} className={quietButton} onClick={finishEditing}>Cancel</button>
      </div>
    </form>
  </li>;

  const metadata = [
    `Owner: ${action.owner?.trim() || 'Not specified'}`,
    `Due: ${action.dueAt?.trim() || action.dueText?.trim() || 'Not specified'}`,
  ];

  return <li className="border-b border-border py-3 last:border-b-0">
    <div className="flex items-start gap-2.5">
      <input
        type="checkbox"
        checked={action.status === 'done'}
        disabled={saving}
        aria-label={`${action.status === 'done' ? 'Reopen' : 'Complete'}: ${action.text}`}
        onChange={() => void save({ status: action.status === 'done' ? 'open' : 'done' })}
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      />
      <div className="min-w-0 flex-1">
        <p className={`text-sm leading-6 text-text ${action.status === 'done' ? 'line-through opacity-60' : ''}`}>{action.text}</p>
        <p className="mt-1 text-xs leading-5 text-3">{metadata.join(' · ')}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="px-2 py-1 text-[11px] text-3">{action.commitmentState === 'agreed' ? 'Agreed' : action.commitmentState === 'proposed' ? 'Proposed' : 'Needs review'}</span>
          <EvidenceLink evidence={action.evidence} />
          <button type="button" disabled={saving} className={quietButton} onClick={() => { setText(action.text); setOwner(action.owner || ''); setDueAt(action.dueAt || ''); setDueText(action.dueText || ''); setCommitmentState(action.commitmentState); onEditing(action.id, true); setEditing(true); }}><Pencil size={12} /> Edit</button>
          <button type="button" disabled={saving} className={`${quietButton} ml-auto`} aria-label={`Dismiss: ${action.text}`} onClick={() => void save({ status: 'dismissed' })}><X size={12} /> Dismiss</button>
        </div>
        {action.status === 'done' && <span className="sr-only"><Check /> Completed</span>}
      </div>
    </div>
  </li>;
}

export default function FinishedMeetingActions({ meetingId, onPersistedActionsChange }: { meetingId: string; onPersistedActionsChange?: (actions: MeetingAction[]) => void }) {
  const model = useMeetingIntelligence(meetingId);
  const editing = useRef(new Set<string>());

  useEffect(() => {
    if (model.data) onPersistedActionsChange?.(model.data.actions);
  }, [model.data, onPersistedActionsChange]);

  useEffect(() => {
    editing.current.clear();
    const guard = (event: Event) => {
      const detail = (event as CustomEvent<{ meetingId?: string }>).detail;
      if (detail?.meetingId === meetingId && editing.current.size > 0) event.preventDefault();
    };
    window.addEventListener('meetodds:before-summary-generation', guard);
    return () => window.removeEventListener('meetodds:before-summary-generation', guard);
  }, [meetingId]);

  const onEditing = (id: string, value: boolean) => {
    if (value) editing.current.add(id);
    else editing.current.delete(id);
  };

  if (model.isLoading && !model.data) return <p role="status" className="mt-5 text-xs text-3">Loading action items…</p>;
  if (!model.data) return model.error ? <div role="alert" className="mt-5 flex items-center gap-2 text-xs text-3"><span>Action items could not be loaded.</span><button type="button" className={quietButton} onClick={() => void model.load()}>Retry</button></div> : null;

  const actions = visibleMeetingActions(model.data.actions);
  if (!actions.length) return null;

  return <section aria-labelledby="finished-action-items" className="mt-7 border-t border-border pt-5">
    <h3 id="finished-action-items" className="text-sm font-semibold text-text">Action items <span className="ml-1 text-xs font-normal text-3">{actions.filter(action => action.status !== 'done').length} open</span></h3>
    {model.error && <p role="alert" className="mt-2 text-xs text-danger">{model.error}</p>}
    <ul className="mt-1">
      {actions.map(action => <ActionItem key={action.id} action={action} update={model.updateAction} onEditing={onEditing} />)}
    </ul>
  </section>;
}
