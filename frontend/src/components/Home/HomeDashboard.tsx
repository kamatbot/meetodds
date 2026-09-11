'use client';

import { useMemo, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowRight, CheckCircle2, FileAudio, LoaderCircle, Mic, Radio, RefreshCw, Sparkles, Star, Upload } from 'lucide-react';
import { useConfig } from '@/contexts/ConfigContext';
import { useMeetingList } from '@/hooks/useMeetingList';
import type { MeetingMetadata } from '@/services/indexedDBService';
import type { CalendarEvent } from '@/services/calendarService';
import type { MeetingListItem } from '@/types/meeting';
import { RecordingStatus } from '@/contexts/RecordingStateContext';
import ActionInboxPreview from '@/components/Home/ActionInboxPreview';
import CalendarAgendaCard from '@/components/Home/CalendarAgendaCard';

interface HomeDashboardProps {
  hasMicrophone: boolean; hasSystemAudio: boolean; permissionsLoading: boolean; permissionError: string | null;
  recoverableMeetings: MeetingMetadata[]; isRecoveryLoading: boolean; isRecording: boolean; recordingStatus: RecordingStatus;
  recordingDuration: number | null; newMeetingDisabled: boolean; onNewMeeting: () => void; onCalendarMeetingStart: (event: CalendarEvent) => void; onImport: (filePath?: string | null) => void;
  onReviewRecovery: () => void; onOpenSettings: () => void;
}
function greetingFor(date: Date) { const hour = date.getHours(); return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening' }
function formatDate(date: Date) { return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date) }
function formatDuration(ms: number | null) { if (ms == null || !Number.isFinite(ms)) return ''; const mins = Math.max(1, Math.round(ms / 60000)); return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60 ? `${mins % 60}m` : ''}`.trim() }
function formatMeetingTime(value: string) { const date = new Date(value); if (Number.isNaN(date.getTime())) return ''; const same = date.toDateString() === new Date().toDateString(); return new Intl.DateTimeFormat(undefined, same ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(date) }
function displayMeetingTitle(title: string) { const v = title.trim(); return !v || /^Meeting\s+\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/i.test(v) ? 'Untitled meeting' : v }
function providerLabel(value: string) { return value.split(/[-_]/g).map(p => p ? `${p[0].toUpperCase()}${p.slice(1)}` : p).join(' ') }
function statusLabel(status: MeetingListItem['summaryStatus']) { return status === 'ready' ? ['Summarised', 'text-success'] : status === 'generating' ? ['Generating summary…', 'text-warn'] : status === 'failed' ? ['Summary failed', 'text-danger'] : ['No summary', 'text-3'] }

function RecentMeetingRow({ item, onOpen }: { item: MeetingListItem; onOpen: () => void }) {
  const [label, tone] = statusLabel(item.summaryStatus);
  return <button type="button" onClick={onOpen} className="grid w-full grid-cols-[22px_minmax(0,1fr)_110px] items-center gap-3 border-t border-border px-4 py-3 text-left first:border-t-0 hover:bg-[var(--hover)]">
    <Star className={item.starred ? 'h-4 w-4 text-accent' : 'h-4 w-4 text-3'} fill={item.starred ? 'currentColor' : 'none'} strokeWidth={1.7} />
    <span className="min-w-0"><span className="block truncate text-[13px] font-semibold text-text">{displayMeetingTitle(item.title)}</span><span className={`mt-0.5 block text-[11px] ${tone}`}>{label}</span></span>
    <span className="text-right font-mono text-[10.5px] leading-5 text-3"><span className="block">{formatMeetingTime(item.createdAt)}</span><span className="block">{formatDuration(item.durationMs)}</span></span>
  </button>;
}

export default function HomeDashboard(props: HomeDashboardProps) {
  const router = useRouter();
  const { selectedDevices, transcriptModelConfig, selectedLanguage, modelConfig, error: configError } = useConfig();
  const { items, isLoading: meetingsLoading, error: meetingsError, refresh } = useMeetingList({ query: '', sort: 'newest', starredOnly: false });
  const now = useMemo(() => new Date(), []); const recent = items.slice(0, 2);
  const busyRecording = props.isRecording || props.recordingStatus === RecordingStatus.STARTING || props.recordingStatus === RecordingStatus.STOPPING;
  const meetingNeedingAttention = items.find(m => m.summaryStatus === 'missing' || m.summaryStatus === 'failed');
  const hasAttention = props.recoverableMeetings.length > 0 || props.permissionError || meetingNeedingAttention;
  const handleDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); const file = event.dataTransfer.files?.[0] as (File & { path?: string }) | undefined; if (file) props.onImport(file.path ?? null) };
  const readiness = [
    { label: 'Microphone', ok: props.hasMicrophone, loading: props.permissionsLoading, text: props.permissionsLoading ? 'Checking…' : props.hasMicrophone ? selectedDevices.micDevice || 'Available · default device' : 'No available microphone', href: '/settings?section=recording', icon: 'audio' },
    { label: 'System audio', ok: props.hasSystemAudio, loading: props.permissionsLoading, text: props.permissionsLoading ? 'Checking…' : props.hasSystemAudio ? selectedDevices.systemDevice || 'Available · default device' : 'No available system-audio device', href: '/settings?section=recording', icon: 'audio' },
    { label: 'Transcription', ok: true, loading: false, text: `${providerLabel(transcriptModelConfig.provider)} · ${transcriptModelConfig.model} · ${selectedLanguage}`, href: '/settings?section=transcription', icon: 'transcription' },
    { label: 'Summary', ok: !configError, loading: false, text: configError ? 'Verify the configured provider' : `${providerLabel(modelConfig.provider)} · ${modelConfig.model}`, href: '/settings?section=summary', icon: 'summary' },
  ];

  return <div className="h-full overflow-y-auto bg-bg custom-scrollbar" onDragOver={e => e.preventDefault()} onDrop={handleDrop}>
    <div className="mx-auto w-full max-w-[760px] px-6 pb-12 pt-7 md:px-8">
      <div className="flex items-start justify-between gap-6"><div><h1 className="text-[26px] font-semibold tracking-[-.035em] text-text">{greetingFor(now)}</h1><p className="mt-1 font-mono text-[11px] text-3">{formatDate(now)}</p></div><button type="button" onClick={props.onNewMeeting} disabled={props.newMeetingDisabled || busyRecording} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[11px] bg-accent px-4 text-[12px] font-semibold text-accent-foreground shadow-[0_6px_18px_rgba(204,72,5,.16)] hover:brightness-95 disabled:opacity-45"><span className="h-2 w-2 rounded-full bg-current" />{busyRecording ? 'Meeting in progress' : 'New meeting'}</button></div>

      <CalendarAgendaCard onStart={props.onCalendarMeetingStart} />

      <div className="mt-7"><ActionInboxPreview /></div>

      <section className="mt-6 overflow-hidden rounded-[16px] border border-border bg-panel shadow-[0_1px_2px_rgba(24,18,12,.03)]" aria-labelledby="capture-readiness"><div className="flex h-11 items-center justify-between border-b border-border px-4"><h2 id="capture-readiness" className="text-[13px] font-semibold text-text">Capture readiness</h2><span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] text-3"><i className="h-1.5 w-1.5 rounded-full bg-success" />Ready</span></div>{readiness.map(row => <button key={row.label} type="button" onClick={() => router.push(row.href)} className="grid w-full grid-cols-[18px_112px_minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-4 py-[11px] text-left last:border-b-0 hover:bg-[var(--hover)]">
        {row.loading ? <LoaderCircle className="h-4 w-4 animate-spin text-3" /> : row.icon === 'transcription' ? <Radio className="h-4 w-4 text-3" /> : row.icon === 'summary' ? <Sparkles className={`h-4 w-4 ${row.ok ? 'text-3' : 'text-warn'}`} /> : row.ok ? <CheckCircle2 className="h-4 w-4 text-success" /> : <AlertCircle className="h-4 w-4 text-warn" />}
        <span className="text-[12.5px] font-medium text-text">{row.label}</span><span className="min-w-0 truncate text-[12px] text-2">{row.text}</span><span className="rounded-[8px] border border-border bg-panel-2 px-2.5 py-1 text-[10.5px] font-medium text-2">{row.ok ? 'Change' : 'Fix'}</span></button>)}</section>

      <section className="mt-6" aria-labelledby="recent-home"><div className="mb-2 flex items-center justify-between"><h2 id="recent-home" className="text-[13px] font-semibold text-text">Recent meetings</h2>{items.length > 0 && <button type="button" onClick={() => router.push('/meetings')} className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline">See all <ArrowRight className="h-3 w-3" /></button>}</div>
        {meetingsLoading && !items.length ? <div className="horizon-card flex items-center justify-center py-8 text-[12px] text-3"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Loading meetings…</div> : meetingsError && !items.length ? <div className="horizon-card p-5 text-center"><p className="text-[12px] font-semibold">Recent meetings could not be loaded</p><button type="button" onClick={() => void refresh()} className="mt-3 rounded-[9px] border border-border px-3 py-1.5 text-[11px]">Retry</button></div> : !recent.length ? <div className="horizon-card p-7 text-center"><FileAudio className="mx-auto h-5 w-5 text-3" /><p className="mt-3 text-[14px] font-semibold">Your meetings will appear here</p><p className="mt-1 text-[12px] text-2">Start a meeting, or import an audio file.</p><div className="mt-4 flex justify-center gap-2"><button type="button" onClick={props.onNewMeeting} disabled={props.newMeetingDisabled} className="rounded-[9px] bg-accent px-3 py-2 text-[11px] font-semibold text-accent-foreground"><Mic className="mr-1 inline h-3 w-3" />New meeting</button><button type="button" onClick={() => props.onImport()} className="rounded-[9px] border border-border px-3 py-2 text-[11px]"><Upload className="mr-1 inline h-3 w-3" />Import</button></div></div> : <div className="overflow-hidden rounded-[16px] border border-border bg-panel">{recent.map(item => <RecentMeetingRow key={item.id} item={item} onOpen={() => router.push(`/meeting?id=${encodeURIComponent(item.id)}`)} />)}</div>}
      </section>

      {hasAttention && <section className="mt-6" aria-labelledby="attention-home"><h2 id="attention-home" className="mb-2 text-[12px] font-semibold text-2">Needs attention</h2><div className="overflow-hidden rounded-[16px] border border-border bg-panel">{props.recoverableMeetings.length > 0 && <button type="button" onClick={props.onReviewRecovery} className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-[var(--hover)]"><AlertCircle className="h-4 w-4 text-warn" /><span className="min-w-0 flex-1 text-[12px]">{props.recoverableMeetings.length === 1 ? 'An interrupted meeting can be recovered' : `${props.recoverableMeetings.length} interrupted meetings can be recovered`}</span><span className="text-[10.5px] font-medium text-accent">Review →</span></button>}{props.permissionError && <button type="button" onClick={props.onOpenSettings} className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-[var(--hover)]"><AlertCircle className="h-4 w-4 text-warn" /><span className="flex-1 text-[12px]">Audio readiness could not be verified</span><span className="text-[10.5px] text-accent">Settings →</span></button>}{meetingNeedingAttention && <button type="button" onClick={() => router.push(`/meeting?id=${encodeURIComponent(meetingNeedingAttention.id)}`)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)]"><AlertCircle className="h-4 w-4 text-warn" /><span className="min-w-0 flex-1 truncate text-[12px]"><strong>{displayMeetingTitle(meetingNeedingAttention.title)}</strong> · {meetingNeedingAttention.summaryStatus === 'failed' ? 'summary failed' : 'no summary'}</span><span className="text-[10.5px] text-accent">Open →</span></button>}</div></section>}
    </div>
  </div>;
}
