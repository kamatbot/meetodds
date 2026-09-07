'use client';

import { useMemo, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  FileAudio,
  LoaderCircle,
  Mic,
  Radio,
  RefreshCw,
  Settings,
  Sparkles,
  Star,
  Upload,
} from 'lucide-react';
import { useConfig } from '@/contexts/ConfigContext';
import { useMeetingList } from '@/hooks/useMeetingList';
import type { MeetingMetadata } from '@/services/indexedDBService';
import type { MeetingListItem } from '@/types/meeting';
import { RecordingStatus } from '@/contexts/RecordingStateContext';
import ActionInboxPreview from '@/components/Home/ActionInboxPreview';

interface HomeDashboardProps {
  hasMicrophone: boolean;
  hasSystemAudio: boolean;
  permissionsLoading: boolean;
  permissionError: string | null;
  recoverableMeetings: MeetingMetadata[];
  isRecoveryLoading: boolean;
  isRecording: boolean;
  recordingStatus: RecordingStatus;
  recordingDuration: number | null;
  newMeetingDisabled: boolean;
  onNewMeeting: () => void;
  onImport: (filePath?: string | null) => void;
  onReviewRecovery: () => void;
  onOpenSettings: () => void;
}

function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function formatDuration(durationMs: number | null): string {
  if (durationMs == null || !Number.isFinite(durationMs)) return '';
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  return `${minutes} min`;
}

function formatMeetingTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatRecordingDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '0:00';
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function displayMeetingTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || /^Meeting\s+\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/i.test(trimmed)) {
    return 'Untitled meeting';
  }
  return trimmed;
}

function providerLabel(value: string): string {
  return value
    .split(/[-_]/g)
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ');
}

function RecentMeetingRow({ item, onOpen }: { item: MeetingListItem; onOpen: () => void }) {
  const duration = formatDuration(item.durationMs);
  const time = formatMeetingTime(item.createdAt);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-4 py-3 text-left first:border-t-0 transition-colors duration-150 hover:bg-bg"
    >
      <Star
        className={item.starred ? 'h-4 w-4 text-accent' : 'h-4 w-4 text-3'}
        fill={item.starred ? 'currentColor' : 'none'}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block truncate text-ui font-semibold text-text">
          {displayMeetingTitle(item.title)}
        </span>
        <span className="mt-0.5 block text-caption text-3">
          {item.summaryStatus === 'ready'
            ? 'Summarised'
            : item.summaryStatus === 'generating'
              ? 'Generating summary…'
              : item.summaryStatus === 'failed'
                ? 'Summary failed'
                : 'No summary'}
        </span>
      </span>
      <span className="text-right text-caption text-3">
        <span className="block">{time}</span>
        {duration && <span className="block">{duration}</span>}
      </span>
    </button>
  );
}

export default function HomeDashboard({
  hasMicrophone,
  hasSystemAudio,
  permissionsLoading,
  permissionError,
  recoverableMeetings,
  isRecoveryLoading,
  isRecording,
  recordingStatus,
  recordingDuration,
  newMeetingDisabled,
  onNewMeeting,
  onImport,
  onReviewRecovery,
  onOpenSettings,
}: HomeDashboardProps) {
  const router = useRouter();
  const {
    selectedDevices,
    transcriptModelConfig,
    selectedLanguage,
    modelConfig,
    error: configError,
  } = useConfig();
  const {
    items: recentMeetings,
    isLoading: meetingsLoading,
    error: meetingsError,
    refresh: refreshMeetings,
  } = useMeetingList({ query: '', sort: 'newest', starredOnly: false });

  const now = useMemo(() => new Date(), []);
  const meetingNeedingAttention = recentMeetings.find(
    (meeting) => meeting.summaryStatus === 'missing' || meeting.summaryStatus === 'failed',
  );
  const recent = recentMeetings.slice(0, 10);
  const hasAttention = Boolean(
    recoverableMeetings.length > 0 ||
    permissionError ||
    meetingNeedingAttention,
  );
  const busyRecording =
    isRecording ||
    recordingStatus === RecordingStatus.STARTING ||
    recordingStatus === RecordingStatus.STOPPING;

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
    if (!file) return;
    onImport(file.path ?? null);
  };

  return (
    <div
      className="h-full overflow-y-auto bg-bg custom-scrollbar"
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="mx-auto w-full max-w-[760px] px-6 py-8 md:py-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-display text-text">{greetingFor(now)}</h1>
            <p className="mt-1 text-ui text-3">{formatDate(now)}</p>
          </div>
          <button
            type="button"
            onClick={onNewMeeting}
            disabled={newMeetingDisabled || busyRecording}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-control border border-accent bg-accent px-3.5 text-ui font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span className="h-2 w-2 rounded-full bg-white" aria-hidden="true" />
            {busyRecording ? 'Meeting in progress' : 'New meeting'}
          </button>
        </div>

        {busyRecording && (
          <div className="mt-6 flex items-center gap-3 rounded-card border border-record bg-surface px-4 py-3">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-record" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-ui font-semibold text-text">
                {recordingStatus === RecordingStatus.STARTING ? 'Starting recording…' : 'Recording in progress'}
              </p>
              <p className="text-caption text-3">
                Recording continues while you use the app.
              </p>
            </div>
            <span className="font-mono text-caption tabular-nums text-record">
              {formatRecordingDuration(recordingDuration)}
            </span>
          </div>
        )}

        <div className="mt-7">
          <ActionInboxPreview />
        </div>

        <section className="mt-6 overflow-hidden rounded-card border border-border bg-surface" aria-label="Capture readiness">
          <button
            type="button"
            onClick={() => router.push('/settings?section=recording')}
            className="grid w-full grid-cols-[20px_112px_minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-bg"
          >
            {permissionsLoading ? (
              <LoaderCircle className="h-4 w-4 animate-spin text-3" strokeWidth={1.75} />
            ) : hasMicrophone ? (
              <CheckCircle2 className="h-4 w-4 text-success" strokeWidth={1.75} />
            ) : (
              <AlertCircle className="h-4 w-4 text-warn" strokeWidth={1.75} />
            )}
            <span className="text-ui font-medium text-text">Microphone</span>
            <span className="min-w-0 truncate text-ui text-2">
              {permissionsLoading
                ? 'Checking…'
                : hasMicrophone
                  ? selectedDevices.micDevice || 'Available · default device'
                  : 'No available microphone'}
            </span>
            <span className="rounded-control border border-border bg-bg px-2 py-1 text-caption text-2">
              {hasMicrophone ? 'Change' : 'Fix'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => router.push('/settings?section=recording')}
            className="grid w-full grid-cols-[20px_112px_minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-bg"
          >
            {permissionsLoading ? (
              <LoaderCircle className="h-4 w-4 animate-spin text-3" strokeWidth={1.75} />
            ) : hasSystemAudio ? (
              <CheckCircle2 className="h-4 w-4 text-success" strokeWidth={1.75} />
            ) : (
              <AlertCircle className="h-4 w-4 text-warn" strokeWidth={1.75} />
            )}
            <span className="text-ui font-medium text-text">System audio</span>
            <span className="min-w-0 truncate text-ui text-2">
              {permissionsLoading
                ? 'Checking…'
                : hasSystemAudio
                  ? selectedDevices.systemDevice || 'Available · default device'
                  : 'No available system-audio device'}
            </span>
            <span className="rounded-control border border-border bg-bg px-2 py-1 text-caption text-2">
              {hasSystemAudio ? 'Change' : 'Fix'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => router.push('/settings?section=transcription')}
            className="grid w-full grid-cols-[20px_112px_minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-bg"
          >
            <Radio className="h-4 w-4 text-3" strokeWidth={1.75} />
            <span className="text-ui font-medium text-text">Transcription</span>
            <span className="min-w-0 truncate text-ui text-2">
              {providerLabel(transcriptModelConfig.provider)} · {transcriptModelConfig.model}
              <span className="ml-1 text-caption text-3">· {selectedLanguage}</span>
            </span>
            <span className="rounded-control border border-border bg-bg px-2 py-1 text-caption text-2">Change</span>
          </button>

          <button
            type="button"
            onClick={() => router.push('/settings?section=summary')}
            className="grid w-full grid-cols-[20px_112px_minmax(0,1fr)_auto] items-center gap-2 px-4 py-3 text-left hover:bg-bg"
          >
            {configError ? (
              <AlertCircle className="h-4 w-4 text-warn" strokeWidth={1.75} />
            ) : (
              <Sparkles className="h-4 w-4 text-3" strokeWidth={1.75} />
            )}
            <span className="text-ui font-medium text-text">Summary</span>
            <span className="min-w-0 truncate text-ui text-2">
              {configError
                ? 'Open Settings to verify the configured provider'
                : `${providerLabel(modelConfig.provider)} · ${modelConfig.model}`}
            </span>
            <span className="rounded-control border border-border bg-bg px-2 py-1 text-caption text-2">Change</span>
          </button>
        </section>

        {hasAttention && (
          <section className="mt-7" aria-labelledby="needs-attention-title">
            <h2 id="needs-attention-title" className="mb-2 text-ui font-semibold text-2">Needs attention</h2>
            <div className="overflow-hidden rounded-card border border-border bg-surface">
              {recoverableMeetings.length > 0 && (
                <button
                  type="button"
                  onClick={onReviewRecovery}
                  className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-bg"
                >
                  {isRecoveryLoading ? (
                    <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-warn" strokeWidth={1.75} />
                  ) : (
                    <AlertCircle className="h-4 w-4 shrink-0 text-warn" strokeWidth={1.75} />
                  )}
                  <span className="min-w-0 flex-1 text-ui text-text">
                    {recoverableMeetings.length === 1
                      ? 'An interrupted meeting can be recovered'
                      : `${recoverableMeetings.length} interrupted meetings can be recovered`}
                  </span>
                  <span className="inline-flex items-center gap-1 text-caption font-medium text-accent">
                    Review <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </span>
                </button>
              )}

              {permissionError && (
                <button
                  type="button"
                  onClick={() => router.push('/settings?section=recording')}
                  className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-bg"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 text-warn" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 text-ui text-text">Audio readiness could not be verified</span>
                  <span className="text-caption font-medium text-accent">Open Settings</span>
                </button>
              )}

              {meetingNeedingAttention && (
                <button
                  type="button"
                  onClick={() => router.push(`/meeting?id=${encodeURIComponent(meetingNeedingAttention.id)}`)}
                  className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-bg"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 text-warn" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate text-ui text-text">
                    <strong>{displayMeetingTitle(meetingNeedingAttention.title)}</strong>{' '}
                    {meetingNeedingAttention.summaryStatus === 'failed'
                      ? 'has a failed summary'
                      : 'has no summary yet'}
                  </span>
                  <span className="text-caption font-medium text-accent">Open</span>
                </button>
              )}
            </div>
          </section>
        )}

        <section className="mt-7" aria-labelledby="recent-meetings-title">
          <div className="mb-2 flex items-center justify-between gap-4">
            <h2 id="recent-meetings-title" className="text-ui font-semibold text-2">Recent meetings</h2>
            {recent.length > 0 && (
              <button
                type="button"
                onClick={() => router.push('/meetings')}
                className="inline-flex items-center gap-1 text-caption font-medium text-accent hover:underline"
              >
                See all meetings <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            )}
          </div>

          {meetingsLoading && recent.length === 0 ? (
            <div className="flex items-center justify-center rounded-card border border-border bg-surface py-10 text-ui text-3">
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.75} />
              Loading recent meetings…
            </div>
          ) : meetingsError && recent.length === 0 ? (
            <div className="rounded-card border border-border bg-surface p-5 text-center">
              <p className="text-ui font-semibold text-text">Recent meetings could not be loaded</p>
              <button
                type="button"
                onClick={() => void refreshMeetings()}
                className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-bg px-3 text-ui font-medium text-text hover:bg-surface"
              >
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} /> Retry
              </button>
            </div>
          ) : recent.length === 0 ? (
            <div className="rounded-card border border-border bg-surface p-8 text-center">
              <FileAudio className="mx-auto h-5 w-5 text-3" strokeWidth={1.75} aria-hidden="true" />
              <h3 className="mt-3 text-title text-text">Your meetings will appear here</h3>
              <p className="mx-auto mt-1.5 max-w-md text-body text-2">
                Start one, or drop an audio file anywhere on this page to import it.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <button
                  type="button"
                  onClick={onNewMeeting}
                  disabled={newMeetingDisabled || busyRecording}
                  className="inline-flex h-8 items-center gap-1.5 rounded-control border border-accent bg-accent px-3 text-ui font-semibold text-white disabled:opacity-45"
                >
                  <Mic className="h-3.5 w-3.5" strokeWidth={1.75} /> New meeting
                </button>
                <button
                  type="button"
                  onClick={() => onImport()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-bg px-3 text-ui font-medium text-text hover:bg-surface"
                >
                  <Upload className="h-3.5 w-3.5" strokeWidth={1.75} /> Import audio…
                </button>
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-card border border-border bg-surface">
              {recent.map((meeting) => (
                <RecentMeetingRow
                  key={meeting.id}
                  item={meeting}
                  onOpen={() => router.push(`/meeting?id=${encodeURIComponent(meeting.id)}`)}
                />
              ))}
            </div>
          )}
        </section>

        <button
          type="button"
          onClick={onOpenSettings}
          className="mt-6 inline-flex items-center gap-1.5 text-caption text-3 transition-colors duration-150 hover:text-text"
        >
          <Settings className="h-3.5 w-3.5" strokeWidth={1.75} /> Capture or model settings
        </button>
      </div>
    </div>
  );
}
