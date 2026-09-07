'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useRouter } from 'next/navigation';
import { Check, CheckCircle2, ChevronRight, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { evidenceHref } from '@/lib/evidence-navigation';
import type {
  ActionInboxItem,
  ActionInboxResponse,
  MeetingAction,
  MeetingActionUpdate,
} from '@/types/intelligence';

interface ActionInboxPanelProps {
  compact?: boolean;
  limit?: number;
}

function metadata(item: ActionInboxItem): string {
  return [item.project, item.client, item.meetingTitle].filter(Boolean).join(' · ');
}

function actionUpdate(action: MeetingAction, overrides: Partial<MeetingActionUpdate>): MeetingActionUpdate {
  return {
    actionId: action.id,
    text: action.text,
    owner: action.owner,
    dueAt: action.dueAt,
    dueText: action.dueText,
    status: action.status,
    commitmentState: action.commitmentState,
    confirmed: action.confirmed,
    ...overrides,
  };
}

export default function ActionInboxPanel({ compact = false, limit = 6 }: ActionInboxPanelProps) {
  const router = useRouter();
  const [data, setData] = useState<ActionInboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setData(await invoke<ActionInboxResponse>('api_get_action_inbox')); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : String(loadError)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const mutate = async (item: ActionInboxItem, overrides: Partial<MeetingActionUpdate>) => {
    if (busyAction) return;
    setBusyAction(item.action.id);
    try {
      await invoke<MeetingAction>('api_update_meeting_action', {
        update: actionUpdate(item.action, overrides),
      });
      await load();
    } catch (mutationError) {
      toast.error('Could not update action', { description: String(mutationError) });
    } finally { setBusyAction(null); }
  };

  if (loading && !data) {
    return <div className={`flex items-center justify-center rounded-card border border-border bg-surface text-ui text-3 ${compact ? 'py-5' : 'min-h-[220px]'}`}><LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Loading actions…</div>;
  }

  if (!data) {
    return <div className="rounded-card border border-border bg-surface p-4 text-ui text-danger">{error || 'Action inbox unavailable'} <button type="button" className="ml-2 underline" onClick={() => void load()}>Retry</button></div>;
  }

  const review = data.needsReview.slice(0, compact ? Math.min(limit, 3) : limit);
  const open = data.open.slice(0, compact ? Math.max(0, limit - review.length) : limit);
  const empty = data.needsReview.length === 0 && data.open.length === 0;

  const renderRow = (item: ActionInboxItem, needsReview: boolean) => {
    const evidence = item.action.evidence[0];
    return (
      <div key={item.action.id} className="flex items-start gap-3 border-t border-border px-3.5 py-3 first:border-t-0">
        <button
          type="button"
          disabled={busyAction === item.action.id}
          onClick={() => void mutate(item, { status: item.action.status === 'done' ? 'open' : 'done', confirmed: true })}
          className={`mt-0.5 inline-grid h-5 w-5 shrink-0 place-items-center rounded border ${item.action.status === 'done' ? 'border-success bg-success text-white' : 'border-border bg-bg text-transparent'} disabled:opacity-40`}
          aria-label={item.action.status === 'done' ? 'Reopen action' : 'Complete action'}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => router.push(`/meeting?id=${encodeURIComponent(item.meetingId)}`)} className="min-w-0 flex-1 text-left">
          <span className="block text-ui font-medium leading-5 text-text">{item.action.text}</span>
          <span className="mt-1 block truncate text-caption text-3">
            {item.action.commitmentState === 'proposed' ? 'Proposed · ' : ''}{item.action.owner ? `${item.action.owner} · ` : ''}{item.action.dueAt || item.action.dueText ? `Due ${item.action.dueAt || item.action.dueText} · ` : ''}{metadata(item)}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {evidence && (
            <button type="button" onClick={() => router.push(evidenceHref(item.meetingId, evidence))} className="h-7 rounded-control border border-border px-2 text-caption font-medium text-accent hover:bg-bg">Evidence</button>
          )}
          {needsReview ? <>
            <button type="button" disabled={busyAction === item.action.id} onClick={() => void mutate(item, { confirmed: true, commitmentState: item.action.commitmentState === 'detected' ? 'agreed' : item.action.commitmentState })} className="inline-flex h-7 items-center gap-1 rounded-control border border-border px-2 text-caption font-medium text-text hover:bg-bg disabled:opacity-40"><CheckCircle2 className="h-3 w-3" /> Confirm</button>
            <button type="button" disabled={busyAction === item.action.id} onClick={() => void mutate(item, { status: 'dismissed', confirmed: true })} className="inline-grid h-7 w-7 place-items-center rounded-control text-3 hover:bg-bg hover:text-danger disabled:opacity-40" title="Dismiss" aria-label="Dismiss action"><X className="h-3.5 w-3.5" /></button>
          </> : <ChevronRight className="h-4 w-4 text-3" />}
        </div>
      </div>
    );
  };

  return (
    <section aria-labelledby={compact ? 'home-actions-title' : 'action-inbox-title'}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 id={compact ? 'home-actions-title' : 'action-inbox-title'} className={compact ? 'text-ui font-semibold text-2' : 'text-title text-text'}>{compact ? 'Actions' : 'Action inbox'}</h2>
          {!compact && <p className="mt-1 text-ui text-3">Review detected commitments before they become trusted work. Confirmed actions persist across summary regeneration.</p>}
        </div>
        <div className="flex items-center gap-2">
          {data.needsReview.length > 0 && <span className="rounded-full bg-warn/10 px-2 py-0.5 text-[11px] font-semibold text-warn">{data.needsReview.length} to review</span>}
          {compact ? (
            !empty && <button type="button" onClick={() => router.push('/actions')} className="text-caption font-medium text-accent hover:underline">Open inbox</button>
          ) : (
            <button type="button" disabled={loading} onClick={() => void load()} className="inline-grid h-8 w-8 place-items-center rounded-control border border-border bg-surface text-2 hover:bg-bg disabled:opacity-40" aria-label="Refresh actions"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
          )}
        </div>
      </div>

      {error && <p role="alert" className="mb-2 text-caption text-danger">{error}</p>}
      {empty ? (
        <div className="rounded-card border border-border bg-surface p-5 text-center text-ui text-3">No open commitments need your attention.</div>
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-surface">
          {review.map((item) => renderRow(item, true))}
          {open.map((item) => renderRow(item, false))}
        </div>
      )}

      {!compact && data.doneRecent.length > 0 && (
        <div className="mt-7">
          <h3 className="mb-2 text-ui font-semibold text-2">Recently completed</h3>
          <div className="overflow-hidden rounded-card border border-border bg-surface opacity-75">
            {data.doneRecent.slice(0, 20).map((item) => renderRow(item, false))}
          </div>
        </div>
      )}
    </section>
  );
}
