'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LoaderIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import MeetingHeader, { type MeetingDetailTab } from '@/components/Meeting/MeetingHeader';
import AudioPlayer from '@/components/AudioPlayer';
import { useConfig } from '@/contexts/ConfigContext';
import { usePaginatedTranscripts } from '@/hooks/usePaginatedTranscripts';
import { parseSummaryData } from '@/lib/summary-input';
import type { Summary } from '@/types';
import PageContent from '@/app/meeting-details/page-content';

interface SummaryEnvelope { status: string; data?: unknown; error?: string | null }
function isMeetingTab(value: string | null): value is MeetingDetailTab { return value === 'summary' || value === 'notes' || value === 'transcript'; }

function MeetingContent() {
  const params = useSearchParams();
  const meetingId = params.get('id') || '';
  const source = params.get('source');
  const requestedTab = params.get('tab');
  const evidenceSegmentId = params.get('evidence');
  const rawTime = params.get('at');
  const time = rawTime === null ? null : Number(rawTime);
  const evidenceTime = time !== null && Number.isFinite(time) ? time : null;
  const { setCurrentMeeting, refetchMeetings } = useSidebar();
  const { isAutoSummary } = useConfig();
  const router = useRouter();
  const [savedSummary, setSavedSummary] = useState<{ id: string; ready: boolean; summary: Summary | null; status: string }>({ id: '', ready: false, summary: null, status: 'idle' });
  const [titleOverride, setTitleOverride] = useState<{ id: string; title: string } | null>(null);
  const [autoHandled, setAutoHandled] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MeetingDetailTab>(isMeetingTab(requestedTab) ? requestedTab : 'summary');
  // Capture the preference on arrival. Checking "automatic next time" on this
  // meeting's generation card must not unexpectedly submit the current meeting.
  const autoAtArrival = useRef({ id: meetingId, enabled: isAutoSummary });
  if (autoAtArrival.current.id !== meetingId) autoAtArrival.current = { id: meetingId, enabled: isAutoSummary };
  const { metadata, segments, transcripts, isLoading: loadingTranscripts, isLoadingMore, hasMore, totalCount, loadedCount, loadMore, refetch, error } = usePaginatedTranscripts({ meetingId, initialTimestamp: evidenceTime ?? undefined, initialTranscriptId: evidenceSegmentId });
  const meeting = useMemo(() => metadata?.id === meetingId ? {
    ...metadata, transcripts, title: titleOverride?.id === meetingId ? titleOverride.title : metadata.title,
  } : null, [metadata, meetingId, titleOverride, transcripts]);

  useEffect(() => { setActiveTab(isMeetingTab(requestedTab) ? requestedTab : 'summary'); }, [meetingId, requestedTab]);
  useEffect(() => {
    if (meeting) setCurrentMeeting({ id: meeting.id, title: meeting.title });
  }, [meeting?.id, meeting?.title, setCurrentMeeting]);
  useEffect(() => {
    let disposed = false;
    setSavedSummary({ id: meetingId, ready: false, summary: null, status: 'idle' });
    if (!meetingId || meetingId === 'intro-call') return () => { disposed = true; };
    void invoke<SummaryEnvelope>('api_get_summary', { meetingId }).then(result => {
      if (!disposed) setSavedSummary({ id: meetingId, ready: true, summary: parseSummaryData(result.data) as Summary | null, status: result.status.toLowerCase() });
    }).catch(() => {
      // Notes/transcript remain accessible. The generation hook shows the status
      // error and retries the native check before allowing a manual request.
      if (!disposed) setSavedSummary({ id: meetingId, ready: true, summary: null, status: 'error' });
    });
    return () => { disposed = true; };
  }, [meetingId]);

  const summaryLoaded = savedSummary.id === meetingId && savedSummary.ready;
  const shouldAutoGenerate = summaryLoaded && source === 'recording' && autoAtArrival.current.enabled
    && autoHandled !== meetingId && !savedSummary.summary && !['pending', 'processing', 'summarizing', 'regenerating', 'failed', 'error', 'cancelled'].includes(savedSummary.status)
    && transcripts.length > 0;
  if (!meetingId || meetingId === 'intro-call' || error) return <div className="flex h-full items-center justify-center bg-bg px-6"><div className="max-w-sm text-center"><p className="text-sm font-semibold text-danger">{error || 'No meeting selected'}</p><button type="button" onClick={() => router.push('/meetings')} className="mt-4 rounded-control border border-border bg-surface px-3 py-2 text-sm text-text">Back to meetings</button></div></div>;
  if (!summaryLoaded || loadingTranscripts || !meeting) return <div role="status" aria-label="Loading saved meeting" className="flex h-full items-center justify-center bg-bg text-3"><LoaderIcon className="h-5 w-5 animate-spin motion-reduce:animate-none" /></div>;
  return <div className="flex h-full min-h-0 flex-col bg-bg">
    <MeetingHeader key={meeting.id} meetingId={meeting.id} title={meeting.title} createdAt={meeting.created_at} activeTab={activeTab} onTabChange={setActiveTab} onTitleSaved={title => setTitleOverride({ id: meeting.id, title })} onDeleted={() => router.replace('/meetings')} />
    <div className="min-h-0 flex-1 overflow-hidden"><PageContent key={meeting.id} meeting={meeting} summaryData={savedSummary.summary} activeTab={activeTab}
      shouldAutoGenerate={shouldAutoGenerate} onAutoGenerateComplete={() => setAutoHandled(meeting.id)} onMeetingUpdated={refetchMeetings}
      onRefetchTranscripts={refetch} segments={segments} hasMore={hasMore} isLoadingMore={isLoadingMore} totalCount={totalCount} loadedCount={loadedCount} onLoadMore={loadMore} focusSegmentId={evidenceSegmentId} /></div>
    {activeTab === 'transcript' && <AudioPlayer key={meeting.id} meetingId={meeting.id} initialSeek={evidenceTime} />}
  </div>;
}
export default function MeetingPage() { return <Suspense fallback={<div className="flex h-full items-center justify-center bg-bg text-3"><LoaderIcon className="h-5 w-5 animate-spin motion-reduce:animate-none" /></div>}><MeetingContent /></Suspense>; }
