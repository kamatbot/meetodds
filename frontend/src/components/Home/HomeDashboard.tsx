'use client';

import { useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ChevronDown, ChevronRight, FileAudio, LoaderCircle, RefreshCw, Settings, Star, Upload } from 'lucide-react';
import { useMeetingList } from '@/hooks/useMeetingList';
import type { MeetingMetadata } from '@/services/indexedDBService';
import type { CalendarEvent } from '@/services/calendarService';
import type { MeetingListItem } from '@/types/meeting';
import ActionInboxPreview from '@/components/Home/ActionInboxPreview';
import CalendarAgendaCard from '@/components/Home/CalendarAgendaCard';

interface HomeDashboardProps {
  hasMicrophone: boolean;
  isCheckingMicrophone: boolean;
  permissionError: string | null;
  onRetryMicrophoneCheck: () => void;
  recoverableMeetings: MeetingMetadata[];
  newMeetingDisabled: boolean;
  onNewMeeting: () => void;
  onCalendarMeetingStart: (event: CalendarEvent) => void;
  onImport: (filePath?: string | null) => void;
  onReviewRecovery: () => void;
  onOpenSettings: () => void;
}

function formatDuration(ms: number | null) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const mins = Math.max(1, Math.round(ms / 60000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60 ? `${mins % 60}m` : ''}`.trim();
}

function formatMeetingTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function displayMeetingTitle(title: string) {
  const value = title.trim();
  return !value || /^Meeting\s+\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/i.test(value) ? 'Untitled meeting' : value;
}

function statusLabel(status: MeetingListItem['summaryStatus']) {
  if (status === 'ready') return 'Summary ready';
  if (status === 'generating') return 'Writing summary…';
  if (status === 'failed') return 'Summary failed';
  return 'No summary yet';
}

function MeetingRow({ item, onOpen }: { item: MeetingListItem; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} className="grid w-full grid-cols-[20px_minmax(0,1fr)_auto_18px] items-center gap-3 border-t border-border px-1 py-4 text-left first:border-t-0 hover:bg-[var(--hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
    <Star className={item.starred ? 'h-4 w-4 text-accent' : 'h-4 w-4 text-3'} fill={item.starred ? 'currentColor' : 'none'} strokeWidth={1.7} aria-hidden="true" />
    <span className="min-w-0"><span className="block truncate text-[13px] font-medium text-text">{displayMeetingTitle(item.title)}</span><span className="mt-1 block truncate text-[11px] text-3">{statusLabel(item.summaryStatus)}</span></span>
    <span className="text-right text-[11px] leading-5 text-3"><span className="block">{formatMeetingTime(item.createdAt)}</span><span className="block">{formatDuration(item.durationMs)}</span></span>
    <ChevronRight className="h-4 w-4 text-3" aria-hidden="true" />
  </button>;
}

export default function HomeDashboard(props: HomeDashboardProps) {
  const router = useRouter();
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(false);
  const { items, isLoading, error, hasMore, isLoadingMore, refresh, loadMore } = useMeetingList({ query: '', sort: 'newest', starredOnly: false });

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
    if (file) props.onImport(file.path ?? null);
  };

  return <div className="h-full overflow-y-auto bg-bg custom-scrollbar" onDragOver={event => event.preventDefault()} onDrop={handleDrop}>
    <div className="mx-auto w-full max-w-[920px] px-8 pb-12 pt-8">
      <header className="flex items-center justify-between gap-5">
        <div><h1 className="text-[25px] font-semibold tracking-[-.035em] text-text">Your meetings</h1><p className="mt-1 text-[12px] text-3">Recorded conversations, in one place.</p></div>
        <button type="button" onClick={props.onNewMeeting} disabled={props.newMeetingDisabled} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[10px] bg-text px-4 text-[12px] font-semibold text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45">New meeting</button>
      </header>

      <div className="mt-5 flex items-center gap-4 text-[11px]">
        <button type="button" onClick={() => props.onImport()} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-2 hover:bg-panel-2 hover:text-text"><Upload className="h-3.5 w-3.5" />Import audio</button>
        <button type="button" onClick={props.onOpenSettings} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-2 hover:bg-panel-2 hover:text-text"><Settings className="h-3.5 w-3.5" />Settings</button>
      </div>

      {props.recoverableMeetings.length > 0 && <div className="mt-6 flex items-center gap-3 rounded-[10px] border border-warn/30 bg-panel px-3.5 py-3" role="status">
        <AlertCircle className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-[11.5px] text-text">{props.recoverableMeetings.length === 1 ? 'An interrupted meeting can be recovered.' : `${props.recoverableMeetings.length} interrupted meetings can be recovered.`}</span>
        <button type="button" onClick={props.onReviewRecovery} className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent-soft">Review</button>
      </div>}
      {props.isCheckingMicrophone ? <div className="mt-3 flex items-center gap-2 text-[11px] text-3" role="status"><LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />Checking microphone availability…</div>
        : props.permissionError || !props.hasMicrophone ? <div className="mt-3 flex items-center gap-3 rounded-[10px] border border-warn/30 bg-panel px-3.5 py-3" role="status">
          <AlertCircle className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" /><span className="min-w-0 flex-1 text-[11.5px] text-text">{props.permissionError ? 'Microphone availability could not be checked.' : 'No microphone detected.'}</span>
          <button type="button" onClick={props.onRetryMicrophoneCheck} className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent-soft">Retry</button>
          <button type="button" onClick={props.onOpenSettings} className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent-soft">Settings</button>
        </div> : null}

      <section className="mt-7" aria-labelledby="meeting-list-heading">
        <div className="mb-2 flex items-center justify-between"><h2 id="meeting-list-heading" className="text-[12px] font-semibold text-2">Recent</h2><span className="text-[11px] text-3">Newest first</span></div>
        {isLoading && !items.length ? <div className="flex items-center justify-center border-y border-border py-10 text-[12px] text-3"><LoaderCircle className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />Loading meetings…</div>
          : error && !items.length ? <div className="border-y border-border py-8 text-center"><p className="text-[12px] font-medium text-text">Meetings could not be loaded.</p><button type="button" onClick={() => void refresh()} className="mt-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium text-accent hover:bg-accent-soft"><RefreshCw className="h-3 w-3" />Try again</button></div>
            : !items.length ? <div className="border-y border-border py-12 text-center"><FileAudio className="mx-auto h-5 w-5 text-3" aria-hidden="true" /><p className="mt-3 text-[13px] font-medium text-text">No meetings yet</p><p className="mt-1 text-[11px] text-3">Start a meeting or import an audio file.</p></div>
              : <div className="border-y border-border">{items.map(item => <MeetingRow key={item.id} item={item} onOpen={() => router.push(`/meeting?id=${encodeURIComponent(item.id)}`)} />)}</div>}
        {error && items.length > 0 && <div className="mt-3 flex items-center gap-2 text-[11px] text-danger" role="alert"><span>More meetings could not be loaded.</span><button type="button" onClick={() => void refresh()} className="font-semibold underline underline-offset-2">Retry</button></div>}
        {hasMore && <button type="button" onClick={() => void loadMore()} disabled={isLoadingMore} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-2 hover:bg-panel-2 disabled:opacity-50">{isLoadingMore ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <ChevronDown className="h-3.5 w-3.5" />}{isLoadingMore ? 'Loading…' : 'Load more meetings'}</button>}
      </section>

      <details className="mt-8 border-t border-border pt-4" onToggle={event => setMoreOptionsOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer list-none text-[11px] font-medium text-3 hover:text-text [&::-webkit-details-marker]:hidden"><span className="inline-flex items-center gap-1.5">Calendar and action inbox <ChevronDown className="h-3.5 w-3.5" /></span></summary>
        {moreOptionsOpen && <div className="mt-4 space-y-5">
          <CalendarAgendaCard onStart={props.onCalendarMeetingStart} />
          <ActionInboxPreview />
        </div>}
      </details>
    </div>
  </div>;
}
