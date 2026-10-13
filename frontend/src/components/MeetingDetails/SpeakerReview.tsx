"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertCircle, Check, ChevronLeft, ChevronRight, Loader2, Pause, Play, Search, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { MeetingSpeakerReview, SpeakerReviewTurn } from '@/types/speakers';

const PAGE_SIZE = 20;

interface SpeakerReviewProps {
  meetingId: string;
  disabled?: boolean;
  onChanged?: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'The request could not be completed. Please try again.';
}

function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function playableStart(turn: SpeakerReviewTurn): number | null {
  return turn.start !== null && Number.isFinite(turn.start) && turn.start >= 0 ? turn.start : null;
}

export function SpeakerReview({ meetingId, disabled = false, onChanged }: SpeakerReviewProps) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<MeetingSpeakerReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState('');
  const [needsReviewOnly, setNeedsReviewOnly] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [confirmClose, setConfirmClose] = useState(false);
  const [namesExpanded, setNamesExpanded] = useState(true);
  const [playingTurnId, setPlayingTurnId] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const pendingRef = useRef(false);
  const meetingIdRef = useRef(meetingId);
  const onChangedRef = useRef(onChanged);
  meetingIdRef.current = meetingId;
  onChangedRef.current = onChanged;

  useEffect(() => {
    setOpen(false);
    setReview(null);
    setDraftNames({});
    setNewName('');
    setError(null);
    setStatus(null);
    setPending(null);
    setConfirmClose(false);
    setSearch('');
    setPage(0);
    setNeedsReviewOnly(true);
    setNamesExpanded(true);
    setPlayingTurnId(null);
    pendingRef.current = false;
  }, [meetingId]);

  useEffect(() => {
    const version = ++requestVersion.current;
    if (!open) return;
    let active = true;
    setLoading(true);
    setReview(null);
    setError(null);
    setStatus(null);

    invoke<MeetingSpeakerReview>('api_get_meeting_speakers', { meetingId })
      .then((result) => {
        if (!active || version !== requestVersion.current || result.meetingId !== meetingIdRef.current) return;
        setReview(result);
        setDraftNames(Object.fromEntries(result.speakers.map((speaker) => [speaker.id, speaker.name])));
      })
      .catch((cause: unknown) => {
        if (active && version === requestVersion.current) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active && version === requestVersion.current) setLoading(false);
      });

    return () => {
      active = false;
      // Native work can outlive the dialog or route. Its result belongs only to this view.
      ++requestVersion.current;
    };
  }, [open, meetingId, retry]);

  const hasDrafts = newName.trim().length > 0 || Boolean(review?.speakers.some(
    (speaker) => (draftNames[speaker.id] ?? speaker.name) !== speaker.name,
  ));
  const unreviewedCount = review?.turns.filter((turn) => !turn.reviewed).length ?? 0;
  const filteredTurns = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (review?.turns ?? []).filter((turn) => {
      if (needsReviewOnly && turn.reviewed) return false;
      if (!query) return true;
      const speaker = review?.speakers.find((candidate) => candidate.id === turn.speakerId);
      return `${turn.text} ${speaker?.name ?? turn.speakerLabel ?? 'Unknown'}`.toLocaleLowerCase().includes(query);
    });
  }, [review, needsReviewOnly, search]);
  const pageCount = Math.max(1, Math.ceil(filteredTurns.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleTurns = filteredTurns.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const busy = Boolean(pending) || loading || disabled || review?.canEdit === false;

  useEffect(() => { setPage(0); }, [search, needsReviewOnly]);

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen && pendingRef.current) return;
    if (!nextOpen && hasDrafts) {
      setConfirmClose(true);
      return;
    }
    setConfirmClose(false);
    setOpen(nextOpen);
  };

  const mutate = async (
    command: string,
    args: Record<string, string | null>,
    pendingLabel: string,
    successLabel: string,
    savedNameId?: string,
    addingSpeaker = false,
  ) => {
    if (pendingRef.current || loading || disabled || !review?.canEdit) return;
    const version = requestVersion.current;
    const requestedMeetingId = meetingId;
    const isCurrent = () => version === requestVersion.current && requestedMeetingId === meetingIdRef.current;
    pendingRef.current = true;
    setPending(pendingLabel);
    setError(null);
    setStatus(null);
    setConfirmClose(false);
    try {
      const result = await invoke<MeetingSpeakerReview>(command, { meetingId: requestedMeetingId, ...args });
      if (!isCurrent() || result.meetingId !== requestedMeetingId) return;
      setDraftNames((previous) => Object.fromEntries(result.speakers.map((speaker) => {
        const oldName = review?.speakers.find((candidate) => candidate.id === speaker.id)?.name;
        const draft = previous[speaker.id];
        return [speaker.id, speaker.id === savedNameId || draft === undefined || draft === oldName ? speaker.name : draft];
      })));
      setReview(result);
      if (addingSpeaker) setNewName('');
      setStatus(successLabel);
      window.dispatchEvent(new CustomEvent('meetodds:speakers-changed', {
        detail: { meetingId: requestedMeetingId, summaryNeedsReview: result.summaryNeedsReview },
      }));
      try {
        await onChangedRef.current?.();
      } catch {
        if (isCurrent()) setError('Your speaker changes were saved, but the transcript view could not refresh. Reopen this meeting to see them.');
      }
    } catch (cause: unknown) {
      if (isCurrent()) setError(errorMessage(cause));
    } finally {
      if (isCurrent()) {
        pendingRef.current = false;
        setPending(null);
      }
    }
  };

  const assignSpeaker = (turn: SpeakerReviewTurn, speakerId: string | null) => mutate(
    'api_assign_transcript_speaker',
    { transcriptId: turn.id, speakerId },
    'Saving attribution…',
    speakerId === null ? 'Turn marked Unknown. Existing action owners are unchanged.' : 'Speaker attribution confirmed.',
  );

  const playTurn = (turn: SpeakerReviewTurn) => {
    const seconds = playableStart(turn);
    if (seconds === null) return;
    window.dispatchEvent(new CustomEvent('meetodds:seek-audio', { detail: { meetingId, seconds } }));
    setPlayingTurnId(turn.id);
  };

  const pausePlayback = () => {
    window.dispatchEvent(new CustomEvent('meetodds:seek-audio', { detail: { meetingId, pause: true } }));
    setPlayingTurnId(null);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} className="shrink-0">
          <Users aria-hidden="true" />
          Review speakers
        </Button>
      </DialogTrigger>
      <DialogContent
        className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-0 overflow-hidden rounded-xl border-border bg-bg p-0 text-text"
        onEscapeKeyDown={(event) => { if (pendingRef.current) event.preventDefault(); }}
        onInteractOutside={(event) => { if (pendingRef.current) event.preventDefault(); }}
      >
        <DialogHeader className="shrink-0 border-b border-border p-5 pr-12 text-left">
          <DialogTitle>Review speakers</DialogTitle>
          <DialogDescription className="text-2">
            Listen, name speakers, and confirm who spoke. Voice groups are estimates until you review each turn.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5" aria-busy={Boolean(pending) || loading}>
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-border bg-panel p-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1 break-words">
                <p>{error}</p>
                {!review && <Button variant="outline" size="sm" className="mt-2" disabled={loading} onClick={() => setRetry((value) => value + 1)}>Try again</Button>}
              </div>
            </div>
          )}

          {loading ? (
            <p role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading all speaker turns…
            </p>
          ) : review && (
            <>
              {!review.canEdit && (
                <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-panel p-3 text-sm text-2">
                  <p className="min-w-0 flex-1 basis-64">{review.readOnlyReason || 'Speaker editing is temporarily unavailable.'}</p>
                  <Button variant="outline" size="sm" disabled={Boolean(pending) || hasDrafts} onClick={() => setRetry((value) => value + 1)}>Check again</Button>
                </div>
              )}
              {review.summaryNeedsReview && (
                <p role="status" className="rounded-lg border border-border bg-accent-soft p-3 text-sm text-2">
                  Speaker information has changed. The existing summary and action owners may be out of date. Review or regenerate the summary when you finish.
                </p>
              )}

              <section aria-label="Local speaker analysis" className="rounded-lg border border-border bg-surface p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 basis-56">
                    <h3 className="text-sm font-semibold">Find possible speakers</h3>
                    <p className="mt-1 text-xs leading-relaxed text-2">
                      Analyze this recording on your device. Similar voices and overlapping speech can be grouped incorrectly. Your confirmed turns stay unchanged.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !review.canAnalyze || hasDrafts}
                    onClick={() => mutate('api_analyze_meeting_speakers', {}, 'Analyzing recording locally…', 'Local analysis finished. Review the suggested groups below.')}
                  >
                    {pending === 'Analyzing recording locally…' && <Loader2 className="animate-spin" aria-hidden="true" />}
                    {review.analyzedAt ? 'Analyze again' : 'Analyze recording'}
                  </Button>
                </div>
                {!review.canAnalyze && <p className="mt-2 text-xs text-2">{review.unavailableReason || 'Audio analysis is unavailable for this meeting. You can still add names and assign turns manually.'}</p>}
                {hasDrafts && <p className="mt-2 text-xs text-2">Save or discard your name edits before running analysis.</p>}
                {review.analyzedAt && !review.turns.some((turn) => turn.source === 'post-meeting-acoustic') && (
                  <p className="mt-2 text-xs text-2">No unconfirmed voice groups are available. Listen and assign speakers manually where you are sure.</p>
                )}
              </section>

              <details className="group rounded-lg border border-border" open={namesExpanded} onToggle={(event) => setNamesExpanded(event.currentTarget.open)}>
                <summary className="cursor-pointer px-3 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Speaker names <span className="ml-1 font-normal text-2">({review.speakers.length})</span>
                </summary>
                <div className="space-y-3 border-t border-border p-3">
                  <p className="text-xs text-2">Names apply to the whole meeting. Naming a group does not confirm its turns.</p>
                  {review.speakers.map((speaker) => {
                    const draft = draftNames[speaker.id] ?? speaker.name;
                    return (
                      <form key={speaker.id} className="flex flex-wrap items-center gap-2" onSubmit={(event) => {
                        event.preventDefault();
                        if (draft.trim() && draft.trim() !== speaker.name) void mutate('api_rename_meeting_speaker', { speakerId: speaker.id, name: draft.trim() }, 'Saving speaker name…', 'Speaker name saved. Turn confirmation is unchanged.', speaker.id);
                      }}>
                        <label htmlFor={`speaker-name-${speaker.id}`} className="sr-only">Name for {speaker.name}</label>
                        <Input id={`speaker-name-${speaker.id}`} value={draft} maxLength={80} disabled={busy} className="min-w-32 flex-1" onChange={(event) => setDraftNames((previous) => ({ ...previous, [speaker.id]: event.target.value }))} />
                        <span className="text-xs tabular-nums text-2">{speaker.turnCount} {speaker.turnCount === 1 ? 'turn' : 'turns'}</span>
                        <Button type="submit" size="sm" variant="outline" disabled={busy || !draft.trim() || draft.trim() === speaker.name}>Save name</Button>
                        {draft !== speaker.name && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraftNames((previous) => ({ ...previous, [speaker.id]: speaker.name }))}>Discard</Button>}
                      </form>
                    );
                  })}
                  <form className="flex gap-2" onSubmit={(event) => {
                    event.preventDefault();
                    if (newName.trim()) void mutate('api_add_meeting_speaker', { name: newName.trim() }, 'Adding speaker…', 'Speaker added. Choose their name on the relevant turns.', undefined, true);
                  }}>
                    <label htmlFor="new-meeting-speaker" className="sr-only">New speaker name</label>
                    <Input id="new-meeting-speaker" placeholder="New speaker name" maxLength={80} value={newName} disabled={busy} onChange={(event) => setNewName(event.target.value)} />
                    <Button type="submit" size="sm" variant="outline" className="h-9" disabled={busy || !newName.trim()}>Add speaker</Button>
                  </form>
                </div>
              </details>

              <section aria-label="Speaker turns" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">{unreviewedCount} {unreviewedCount === 1 ? 'turn needs' : 'turns need'} review</h3>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-2">
                    <input type="checkbox" checked={needsReviewOnly} onChange={(event) => setNeedsReviewOnly(event.target.checked)} className="h-4 w-4 accent-primary" />
                    Needs review only
                  </label>
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-3" aria-hidden="true" />
                  <label htmlFor="speaker-turn-search" className="sr-only">Search turns or speaker names</label>
                  <Input id="speaker-turn-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search turns or speaker names" className="pl-9" />
                </div>

                {visibleTurns.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-2">
                    {review.turns.length === 0 ? 'There are no saved transcript turns in this meeting.' : search.trim() ? 'No turns match this search.' : needsReviewOnly ? 'All turns have been reviewed. Uncheck “Needs review only” to make further changes.' : 'No turns to show.'}
                  </div>
                ) : (
                  <ol className="space-y-3" aria-label="Transcript turns">
                    {visibleTurns.map((turn) => {
                      const seconds = playableStart(turn);
                      const speaker = review.speakers.find((candidate) => candidate.id === turn.speakerId);
                      return (
                        <li key={turn.id} className="rounded-lg border border-border p-3">
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            {seconds === null ? <span className="text-xs text-3">Audio time unavailable</span> : (
                              <Button variant="ghost" size="sm" className="h-7 px-1 text-xs tabular-nums" onClick={() => playTurn(turn)} aria-label={`Play audio at ${formatTime(seconds)}`}>
                                <Play className="h-3 w-3" aria-hidden="true" /> Play {formatTime(seconds)}
                              </Button>
                            )}
                            <span className={`rounded-full px-2 py-0.5 text-[11px] ${turn.reviewed ? 'bg-surface text-2' : 'bg-accent-soft text-2'}`}>
                              {turn.reviewed ? turn.speakerId ? 'Confirmed' : 'Reviewed · Unknown' : turn.source === 'post-meeting-acoustic' ? 'Estimated · Needs review' : 'Unassigned · Needs review'}
                            </span>
                          </div>
                          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{turn.text}</p>
                          {!turn.reviewed && turn.reason && <p className="mt-2 text-xs leading-relaxed text-2">{turn.reason}</p>}
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <label htmlFor={`turn-speaker-${turn.id}`} className="text-xs text-2">Speaker</label>
                            <select
                              id={`turn-speaker-${turn.id}`}
                              value={turn.speakerId ?? ''}
                              disabled={busy}
                              className="h-9 min-w-0 max-w-full flex-1 rounded-md border border-input bg-bg px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                              onChange={(event) => void assignSpeaker(turn, event.target.value || null)}
                            >
                              <option value="">Unknown</option>
                              {review.speakers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                            </select>
                            {!turn.reviewed && <Button size="sm" variant="outline" disabled={busy} onClick={() => void assignSpeaker(turn, turn.speakerId)} aria-label={speaker ? `Confirm ${speaker.name} for this turn` : 'Keep this turn Unknown'}>
                              <Check aria-hidden="true" />{speaker ? 'Confirm' : 'Keep unknown'}
                            </Button>}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}

                {filteredTurns.length > 0 && (
                  <nav aria-label="Speaker turn pages" className="flex items-center justify-between gap-2">
                    <p className="text-xs tabular-nums text-2">{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filteredTurns.length)} of {filteredTurns.length} turns</p>
                    <div className="flex gap-1">
                      <Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="Previous turns"><ChevronLeft aria-hidden="true" /> Previous</Button>
                      <Button variant="outline" size="sm" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)} aria-label="Next turns">Next <ChevronRight aria-hidden="true" /></Button>
                    </div>
                  </nav>
                )}
              </section>
            </>
          )}
        </div>

        <div className="shrink-0 border-t border-border px-5 py-3">
          {confirmClose ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p role="alert" className="text-sm text-2">You have unsaved speaker names.</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setConfirmClose(false)}>Keep editing</Button>
                <Button variant="ghost" size="sm" onClick={() => { setNewName(''); setConfirmClose(false); setOpen(false); }}>Discard drafts and close</Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-2 text-xs text-2">
                {pending && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />}
                {pending || status || 'Speaker changes save as you confirm them.'}
              </p>
              {playingTurnId && <Button variant="ghost" size="sm" onClick={pausePlayback}><Pause aria-hidden="true" />Pause audio</Button>}
              <Button variant="outline" size="sm" disabled={Boolean(pending)} onClick={() => changeOpen(false)}>Done</Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
