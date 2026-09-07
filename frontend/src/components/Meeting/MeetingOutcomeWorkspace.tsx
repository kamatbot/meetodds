'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  FileText,
  LoaderCircle,
  Mail,
  MessageSquareText,
  RefreshCw,
  Save,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { evidenceHref } from '@/lib/evidence-navigation';
import { useMeetingIntelligence } from '@/hooks/useMeetingIntelligence';
import type {
  EvidenceReference,
  FollowupDraft,
  MeetingAction,
  MeetingActionUpdate,
  MeetingContext,
  MeetingFact,
  PreparationItem,
} from '@/types/intelligence';

interface MeetingOutcomeWorkspaceProps {
  meetingId: string;
}

function formatEvidenceTime(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function EvidenceButton({ meetingId, evidence }: { meetingId: string; evidence?: EvidenceReference | null }) {
  const router = useRouter();
  if (!evidence) return <span className="text-caption text-3">No source link</span>;
  const time = formatEvidenceTime(evidence.audioStartTime);
  return (
    <button
      type="button"
      onClick={() => router.push(evidenceHref(meetingId, evidence))}
      className="inline-flex items-center gap-1 rounded-control border border-border bg-bg px-2 py-1 text-caption font-medium text-accent hover:bg-surface"
      title={evidence.quote}
    >
      Evidence{time ? ` · ${time}` : ''} <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
    </button>
  );
}

function ReviewBadge({ confirmed }: { confirmed: boolean }) {
  return confirmed ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
      <CheckCircle2 className="h-3 w-3" /> Confirmed
    </span>
  ) : (
    <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] font-medium text-3">Needs review</span>
  );
}

function FactRow({
  meetingId,
  fact,
  onConfirm,
  onDismiss,
}: {
  meetingId: string;
  fact: MeetingFact;
  onConfirm: (id: string) => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const evidence = fact.evidence[0];
  const act = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await operation(); }
    catch (error) { toast.error('Could not update meeting evidence', { description: String(error) }); }
    finally { setBusy(false); }
  };
  return (
    <div className="group rounded-control border border-border bg-surface px-3.5 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-body leading-6 text-text">{fact.text}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ReviewBadge confirmed={fact.confirmed} />
            <EvidenceButton meetingId={meetingId} evidence={evidence} />
            {evidence?.speakerLabel && <span className="text-caption text-3">{evidence.speakerLabel}</span>}
          </div>
        </div>
        {!fact.confirmed && (
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => onConfirm(fact.id))}
              className="inline-flex h-7 items-center gap-1 rounded-control border border-border px-2 text-caption font-medium text-text hover:bg-bg disabled:opacity-40"
            >
              <Check className="h-3 w-3" /> Confirm
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => onDismiss(fact.id))}
              className="inline-grid h-7 w-7 place-items-center rounded-control border border-border text-3 hover:bg-bg hover:text-danger disabled:opacity-40"
              aria-label="Dismiss detected item"
              title="Not accurate"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ActionRow({
  meetingId,
  action,
  onSave,
}: {
  meetingId: string;
  action: MeetingAction;
  onSave: (update: MeetingActionUpdate) => Promise<MeetingAction>;
}) {
  const [text, setText] = useState(action.text);
  const [owner, setOwner] = useState(action.owner ?? '');
  const [dueAt, setDueAt] = useState(action.dueAt?.slice(0, 10) ?? '');
  const [commitmentState, setCommitmentState] = useState(action.commitmentState);
  const [busy, setBusy] = useState(false);
  const dirty = text !== action.text
    || owner !== (action.owner ?? '')
    || dueAt !== (action.dueAt?.slice(0, 10) ?? '')
    || commitmentState !== action.commitmentState;

  useEffect(() => {
    setText(action.text);
    setOwner(action.owner ?? '');
    setDueAt(action.dueAt?.slice(0, 10) ?? '');
    setCommitmentState(action.commitmentState);
  }, [action]);

  const save = async (overrides: Partial<MeetingActionUpdate> = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      await onSave({
        actionId: action.id,
        text: text.trim(),
        owner: owner.trim() || null,
        dueAt: dueAt || null,
        dueText: action.dueText,
        status: action.status,
        commitmentState,
        confirmed: action.confirmed,
        ...overrides,
      });
    } catch (error) {
      toast.error('Could not update action', { description: String(error) });
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-control border border-border bg-surface p-3.5">
      <div className="flex items-start gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save({ status: action.status === 'done' ? 'open' : 'done', confirmed: true })}
          className={`mt-0.5 inline-grid h-5 w-5 shrink-0 place-items-center rounded border ${action.status === 'done' ? 'border-success bg-success text-white' : 'border-border bg-bg text-transparent'} disabled:opacity-40`}
          aria-label={action.status === 'done' ? 'Mark action open' : 'Mark action done'}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={Math.min(4, Math.max(1, text.split('\n').length))}
            className={`w-full resize-y bg-transparent text-body leading-6 text-text outline-none ${action.status === 'done' ? 'line-through opacity-60' : ''}`}
            aria-label="Action item"
          />
          <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(120px,1fr)_150px_140px]">
            <input
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              placeholder="Owner"
              aria-label="Action owner"
              className="h-8 min-w-0 rounded-control border border-border bg-bg px-2.5 text-caption text-text outline-none focus:border-accent"
            />
            <input
              type="date"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
              aria-label="Action due date"
              className="h-8 rounded-control border border-border bg-bg px-2 text-caption text-text outline-none focus:border-accent"
            />
            <select
              value={commitmentState}
              onChange={(event) => setCommitmentState(event.target.value as MeetingAction['commitmentState'])}
              aria-label="Commitment status"
              className="h-8 rounded-control border border-border bg-bg px-2 text-caption text-text outline-none focus:border-accent"
            >
              <option value="detected">Detected</option>
              <option value="proposed">Proposed</option>
              <option value="agreed">Agreed</option>
            </select>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ReviewBadge confirmed={action.confirmed} />
            <EvidenceButton meetingId={meetingId} evidence={action.evidence[0]} />
            {action.dueText && !action.dueAt && <span className="text-caption text-3">Heard: {action.dueText}</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          {(dirty || !action.confirmed) && (
            <button
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => void save({ confirmed: true })}
              className="inline-flex h-7 items-center justify-center gap-1 rounded-control border border-border px-2 text-caption font-medium text-text hover:bg-bg disabled:opacity-40"
            >
              {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : dirty ? <Save className="h-3 w-3" /> : <Check className="h-3 w-3" />}
              {dirty ? 'Save' : 'Confirm'}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void save({ status: 'dismissed', confirmed: true })}
            className="h-7 rounded-control px-2 text-caption text-3 hover:bg-bg hover:text-danger disabled:opacity-40"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function ContextEditor({
  initial,
  onSave,
}: {
  initial: MeetingContext;
  onSave: (context: MeetingContext) => Promise<MeetingContext>;
}) {
  const [project, setProject] = useState(initial.project ?? '');
  const [client, setClient] = useState(initial.client ?? '');
  const [participants, setParticipants] = useState(initial.participants.join(', '));
  const [agenda, setAgenda] = useState(initial.agenda ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setProject(initial.project ?? '');
    setClient(initial.client ?? '');
    setParticipants(initial.participants.join(', '));
    setAgenda(initial.agenda ?? '');
  }, [initial]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSave({
        project: project.trim() || null,
        client: client.trim() || null,
        participants: participants.split(',').map((value) => value.trim()).filter(Boolean),
        agenda: agenda.trim() || null,
      });
      toast.success('Meeting context saved');
    } catch (error) {
      toast.error('Could not save meeting context', { description: String(error) });
    } finally { setBusy(false); }
  };

  return (
    <details className="rounded-card border border-border bg-surface p-4">
      <summary className="cursor-pointer text-ui font-semibold text-text">Project, client & preparation context</summary>
      <p className="mt-1 text-caption text-3">This stays local and controls recurring-meeting recall. It is not inferred from attendee names.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-caption font-medium text-2">Project
          <input value={project} onChange={(event) => setProject(event.target.value)} placeholder="e.g. Stablecoin launch" className="mt-1 block h-9 w-full rounded-control border border-border bg-bg px-3 text-ui text-text outline-none focus:border-accent" />
        </label>
        <label className="text-caption font-medium text-2">Client / company
          <input value={client} onChange={(event) => setClient(event.target.value)} placeholder="e.g. Cellulant" className="mt-1 block h-9 w-full rounded-control border border-border bg-bg px-3 text-ui text-text outline-none focus:border-accent" />
        </label>
        <label className="text-caption font-medium text-2 sm:col-span-2">Participants
          <input value={participants} onChange={(event) => setParticipants(event.target.value)} placeholder="Comma-separated names" className="mt-1 block h-9 w-full rounded-control border border-border bg-bg px-3 text-ui text-text outline-none focus:border-accent" />
        </label>
        <label className="text-caption font-medium text-2 sm:col-span-2">Agenda / objective
          <textarea value={agenda} onChange={(event) => setAgenda(event.target.value)} rows={2} placeholder="What did this meeting need to resolve?" className="mt-1 block w-full resize-y rounded-control border border-border bg-bg px-3 py-2 text-ui text-text outline-none focus:border-accent" />
        </label>
      </div>
      <button type="button" disabled={busy} onClick={() => void save()} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-bg px-3 text-ui font-medium text-text hover:bg-surface disabled:opacity-40">
        {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save context
      </button>
    </details>
  );
}

function PreparationSection({ title, items }: { title: string; items: PreparationItem[] }) {
  const router = useRouter();
  if (!items.length) return null;
  return (
    <div>
      <h4 className="text-caption font-semibold uppercase tracking-[0.05em] text-3">{title}</h4>
      <div className="mt-1.5 space-y-1.5">
        {items.slice(0, 5).map((item, index) => (
          <button
            key={`${item.meetingId}-${index}-${item.text}`}
            type="button"
            onClick={() => item.evidence ? router.push(evidenceHref(item.meetingId, item.evidence)) : router.push(`/meeting?id=${encodeURIComponent(item.meetingId)}`)}
            className="flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left text-ui text-text hover:bg-bg"
          >
            <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-3" />
            <span className="min-w-0 flex-1"><span className="block">{item.text}</span><span className="mt-0.5 block text-caption text-3">{item.meetingTitle}{item.confirmed ? ' · confirmed' : ''}</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function MeetingOutcomeWorkspace({ meetingId }: MeetingOutcomeWorkspaceProps) {
  const router = useRouter();
  const {
    data,
    preparation,
    isLoading,
    isRefreshing,
    error,
    refresh,
    saveContext,
    confirmFact,
    dismissFact,
    updateAction,
    generateFollowup,
  } = useMeetingIntelligence(meetingId);
  const [followup, setFollowup] = useState<FollowupDraft | null>(null);
  const [followupOpen, setFollowupOpen] = useState(false);
  const [followupLoading, setFollowupLoading] = useState(false);

  const reviewCount = useMemo(() => {
    if (!data) return 0;
    return [data.outcome, ...data.decisions, ...data.openQuestions].filter((fact) => fact && !fact.confirmed).length
      + data.actions.filter((action) => !action.confirmed).length;
  }, [data]);

  const openFollowup = async () => {
    setFollowupOpen(true);
    setFollowupLoading(true);
    try { setFollowup(await generateFollowup()); }
    catch (failure) { toast.error('Could not prepare follow-up', { description: String(failure) }); }
    finally { setFollowupLoading(false); }
  };

  if (isLoading && !data) {
    return <div className="flex min-h-[220px] items-center justify-center rounded-card border border-border bg-surface text-ui text-3"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Building verifiable meeting record…</div>;
  }

  if (!data) {
    return (
      <div className="rounded-card border border-border bg-surface p-5">
        <p className="text-ui font-semibold text-text">Verifiable meeting record unavailable</p>
        <p className="mt-1 text-caption text-3">{error || 'No saved transcript is available yet.'}</p>
      </div>
    );
  }

  return (
    <section aria-labelledby="meeting-outcome-title" className="space-y-5">
      <Dialog open={followupOpen} onOpenChange={setFollowupOpen}>
        <DialogContent className="border-border bg-surface text-text sm:max-w-[680px]">
          <DialogTitle>Follow-up draft</DialogTitle>
          <DialogDescription>Built only from reviewed actions and evidence-backed decisions/questions. Edit it in your mail or chat app before sending.</DialogDescription>
          {followupLoading ? <div className="flex min-h-40 items-center justify-center text-ui text-3"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Preparing draft…</div> : followup && (
            <div className="space-y-3">
              <div className="rounded-control border border-border bg-bg p-3 text-ui"><strong>Subject:</strong> {followup.subject}</div>
              <textarea readOnly value={followup.body} rows={14} className="w-full resize-y rounded-control border border-border bg-bg p-3 text-ui leading-6 text-text" />
            </div>
          )}
          <DialogFooter>
            <button type="button" className="h-8 rounded-control border border-border px-3 text-ui" onClick={() => setFollowupOpen(false)}>Close</button>
            <button type="button" disabled={!followup} className="h-8 rounded-control border border-accent bg-accent px-3 text-ui font-semibold text-white disabled:opacity-40" onClick={() => {
              if (!followup) return;
              void navigator.clipboard.writeText(`Subject: ${followup.subject}\n\n${followup.body}`).then(() => toast.success('Follow-up copied'));
            }}>Copy draft</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            <h2 id="meeting-outcome-title" className="text-title text-text">Meeting outcome</h2>
            {reviewCount > 0 && <span className="rounded-full bg-warn/10 px-2 py-0.5 text-[11px] font-semibold text-warn">{reviewCount} to review</span>}
          </div>
          <p className="mt-1 max-w-2xl text-caption text-3">Decisions and commitments stay separate from the editable AI summary. Confirmed items survive regeneration; every supported claim links back to its source.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => router.push(`/memory?meetingId=${encodeURIComponent(meetingId)}&scope=meeting`)} className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-3 text-ui font-medium text-text hover:bg-bg"><MessageSquareText className="h-3.5 w-3.5" /> Ask this meeting</button>
          <button type="button" onClick={() => void openFollowup()} className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-3 text-ui font-medium text-text hover:bg-bg"><Mail className="h-3.5 w-3.5" /> Draft follow-up</button>
          <button type="button" disabled={isRefreshing} onClick={() => void refresh().catch(() => undefined)} className="inline-grid h-8 w-8 place-items-center rounded-control border border-border bg-surface text-2 hover:bg-bg disabled:opacity-40" title="Rebuild detected outcomes from the saved summary and transcript" aria-label="Refresh meeting intelligence">{isRefreshing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}</button>
        </div>
      </div>

      {error && <div role="alert" className="rounded-control border border-warn/40 bg-warn/5 px-3 py-2 text-caption text-warn">{error}</div>}

      <ContextEditor initial={data.context} onSave={saveContext} />

      <div className="rounded-card border border-border bg-surface p-5">
        <div className="mb-2 flex items-center gap-2 text-caption font-semibold uppercase tracking-[0.05em] text-3"><FileText className="h-3.5 w-3.5" /> Outcome</div>
        {data.outcome ? (
          <div>
            <p className="text-[17px] font-medium leading-7 text-text">{data.outcome.text}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ReviewBadge confirmed={data.outcome.confirmed} />
              <EvidenceButton meetingId={meetingId} evidence={data.outcome.evidence[0]} />
              {!data.outcome.confirmed && <>
                <button type="button" onClick={() => void confirmFact(data.outcome!.id)} className="h-7 rounded-control border border-border px-2 text-caption font-medium text-text hover:bg-bg">Confirm</button>
                <button type="button" onClick={() => void dismissFact(data.outcome!.id)} className="h-7 rounded-control px-2 text-caption text-3 hover:bg-bg hover:text-danger">Not accurate</button>
              </>}
            </div>
          </div>
        ) : <p className="text-body text-3">No explicit outcome was detected. This is better than inventing one.</p>}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="decisions-heading">
          <div className="mb-2 flex items-center justify-between"><h3 id="decisions-heading" className="text-ui font-semibold text-2">Decisions <span className="ml-1 text-caption font-normal text-3">{data.decisions.length}</span></h3></div>
          <div className="space-y-2">
            {data.decisions.map((fact) => <FactRow key={fact.id} meetingId={meetingId} fact={fact} onConfirm={confirmFact} onDismiss={dismissFact} />)}
            {!data.decisions.length && <div className="rounded-control border border-dashed border-border p-4 text-ui text-3">No explicit decision recorded.</div>}
          </div>
        </section>

        <section aria-labelledby="questions-heading">
          <div className="mb-2 flex items-center justify-between"><h3 id="questions-heading" className="text-ui font-semibold text-2">Open questions <span className="ml-1 text-caption font-normal text-3">{data.openQuestions.length}</span></h3></div>
          <div className="space-y-2">
            {data.openQuestions.map((fact) => <FactRow key={fact.id} meetingId={meetingId} fact={fact} onConfirm={confirmFact} onDismiss={dismissFact} />)}
            {!data.openQuestions.length && <div className="rounded-control border border-dashed border-border p-4 text-ui text-3">No unresolved question detected.</div>}
          </div>
        </section>
      </div>

      <section aria-labelledby="actions-heading">
        <div className="mb-2 flex items-center gap-2"><ClipboardCheck className="h-4 w-4 text-2" /><h3 id="actions-heading" className="text-ui font-semibold text-2">Actions <span className="ml-1 text-caption font-normal text-3">{data.actions.length}</span></h3></div>
        <div className="space-y-2">
          {data.actions.map((action) => <ActionRow key={action.id} meetingId={meetingId} action={action} onSave={updateAction} />)}
          {!data.actions.length && <div className="rounded-control border border-dashed border-border p-4 text-ui text-3">No explicit commitment detected.</div>}
        </div>
      </section>

      {preparation && (preparation.priorDecisions.length || preparation.openActions.length || preparation.openQuestions.length) > 0 && (
        <section className="rounded-card border border-border bg-surface p-4" aria-labelledby="continuity-heading">
          <div className="flex items-start justify-between gap-4">
            <div><h3 id="continuity-heading" className="text-ui font-semibold text-text">From earlier meetings</h3><p className="mt-0.5 text-caption text-3">{preparation.scopeLabel}</p></div>
            <button type="button" onClick={() => router.push(`/memory?meetingId=${encodeURIComponent(meetingId)}&scope=${data.context.project ? 'project' : 'client'}`)} className="text-caption font-medium text-accent hover:underline">Open meeting memory</button>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <PreparationSection title="Prior decisions" items={preparation.priorDecisions} />
            <PreparationSection title="Open actions" items={preparation.openActions} />
            <PreparationSection title="Open questions" items={preparation.openQuestions} />
          </div>
        </section>
      )}
    </section>
  );
}
