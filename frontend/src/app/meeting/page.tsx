'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LoaderIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import MeetingHeader, { type MeetingDetailTab } from '@/components/Meeting/MeetingHeader';
import { useConfig } from '@/contexts/ConfigContext';
import { usePaginatedTranscripts } from '@/hooks/usePaginatedTranscripts';
import Analytics from '@/lib/analytics';
import type { Summary, Transcript } from '@/types';
import PageContent from '@/app/meeting-details/page-content';

interface MeetingDetailsResponse {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  transcripts: Transcript[];
  folder_path?: string;
}

interface OllamaModelResponse {
  name: string;
}

interface StoredModelConfig {
  model?: string | null;
}

interface SummaryEnvelope {
  status: string;
  data?: unknown;
  error?: string | null;
}

interface LegacySection {
  title?: string;
  blocks?: unknown[];
}

function isMeetingTab(value: string | null): value is MeetingDetailTab {
  return value === 'summary' || value === 'notes' || value === 'transcript';
}

function MeetingContent() {
  const searchParams = useSearchParams();
  const meetingId = searchParams.get('id');
  const source = searchParams.get('source');
  const requestedTab = searchParams.get('tab');
  const { setCurrentMeeting, refetchMeetings, stopSummaryPolling } = useSidebar();
  const { isAutoSummary } = useConfig();
  const router = useRouter();
  const [meetingDetails, setMeetingDetails] = useState<MeetingDetailsResponse | null>(null);
  const [meetingSummary, setMeetingSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [shouldAutoGenerate, setShouldAutoGenerate] = useState(false);
  const [hasCheckedAutoGen, setHasCheckedAutoGen] = useState(false);
  const [activeTab, setActiveTab] = useState<MeetingDetailTab>(
    isMeetingTab(requestedTab) ? requestedTab : 'summary',
  );

  const {
    metadata,
    segments,
    transcripts,
    isLoading: isLoadingTranscripts,
    isLoadingMore,
    hasMore,
    totalCount,
    loadedCount,
    loadMore,
    refetch,
    error: transcriptError,
  } = usePaginatedTranscripts({ meetingId: meetingId || '' });

  useEffect(() => {
    if (isMeetingTab(requestedTab)) setActiveTab(requestedTab);
  }, [requestedTab]);

  const checkForGemmaModel = useCallback(async (): Promise<boolean> => {
    try {
      const models = await invoke<OllamaModelResponse[]>('get_ollama_models', { endpoint: null });
      const hasGemma = models.some((model) => model.name === 'gemma3:1b');
      console.log('🔍 Checked for gemma3:1b:', hasGemma);
      return hasGemma;
    } catch (modelError) {
      console.error('❌ Failed to check Ollama models:', modelError);
      return false;
    }
  }, []);

  const setupAutoGeneration = useCallback(async () => {
    if (hasCheckedAutoGen) return;

    if (source !== 'recording') {
      console.log('Not from recording navigation, skipping auto-generation');
      setHasCheckedAutoGen(true);
      return;
    }

    if (!isAutoSummary) {
      console.log('Auto-summary is disabled in settings');
      setHasCheckedAutoGen(true);
      return;
    }

    try {
      const currentConfig = await invoke<StoredModelConfig | null>('api_get_model_config');

      if (currentConfig?.model) {
        console.log('Using existing model from DB:', currentConfig.model);
        setShouldAutoGenerate(true);
        setHasCheckedAutoGen(true);
        return;
      }

      const hasGemma = await checkForGemmaModel();
      if (hasGemma) {
        console.log('💾 DB empty, using gemma3:1b as initial default');
        await invoke('api_save_model_config', {
          provider: 'ollama',
          model: '',
          whisperModel: 'large-v3',
          apiKey: null,
          ollamaEndpoint: null,
        });
        setShouldAutoGenerate(true);
      } else {
        console.log('⚠️ No model configured and gemma3:1b not found');
      }
    } catch (setupError) {
      console.error('❌ Failed to setup auto-generation:', setupError);
    }

    setHasCheckedAutoGen(true);
  }, [checkForGemmaModel, hasCheckedAutoGen, isAutoSummary, source]);

  useEffect(() => {
    if (metadata && (!meetingId || meetingId === 'intro-call')) return;

    if (metadata) {
      setMeetingDetails({
        id: metadata.id,
        title: metadata.title,
        created_at: metadata.created_at,
        updated_at: metadata.updated_at,
        transcripts,
        folder_path: metadata.folder_path,
      });
      setCurrentMeeting({ id: metadata.id, title: metadata.title });
    }
  }, [meetingId, metadata, setCurrentMeeting, transcripts]);

  useEffect(() => {
    if (transcriptError) {
      console.error('Error loading transcripts:', transcriptError);
      setError(transcriptError);
    }
  }, [transcriptError]);

  useEffect(() => {
    setMeetingDetails(null);
    setMeetingSummary(null);
    setError(null);
    setIsLoading(true);
    setHasCheckedAutoGen(false);
    setShouldAutoGenerate(false);
  }, [meetingId]);

  useEffect(() => {
    return () => {
      if (meetingId) {
        stopSummaryPolling(meetingId);
      }
    };
  }, [meetingId, stopSummaryPolling]);

  useEffect(() => {
    if (!meetingId || meetingId === 'intro-call') {
      setError('No meeting selected');
      setIsLoading(false);
      Analytics.trackPageView('meeting_details');
      return;
    }

    setMeetingSummary(null);
    setError(null);
    setIsLoading(true);

    const fetchMeetingSummary = async () => {
      try {
        const summary = await invoke<SummaryEnvelope>('api_get_summary', { meetingId });

        if (summary.status === 'idle' || (!summary.data && summary.status === 'error')) {
          setMeetingSummary(null);
          return;
        }

        let parsedData: unknown = summary.data ?? {};
        if (typeof parsedData === 'string') {
          try {
            parsedData = JSON.parse(parsedData);
          } catch {
            parsedData = {};
          }
        }

        if (!parsedData || typeof parsedData !== 'object') {
          setMeetingSummary(null);
          return;
        }

        const record = parsedData as Record<string, unknown>;
        if (record.summary_json || record.markdown) {
          setMeetingSummary(record as unknown as Summary);
          return;
        }

        const restSummaryData = { ...record };
        delete restSummaryData.MeetingName;
        const sectionOrder = Array.isArray(record._section_order)
          ? record._section_order.filter((key): key is string => typeof key === 'string')
          : Object.keys(restSummaryData).filter((key) => key !== '_section_order');
        delete restSummaryData._section_order;

        const formattedSummary: Summary = {};
        for (const key of sectionOrder) {
          const rawSection = restSummaryData[key];
          if (!rawSection || typeof rawSection !== 'object') continue;
          const section = rawSection as LegacySection;
          if (!Array.isArray(section.blocks)) continue;

          formattedSummary[key] = {
            title: section.title || key,
            blocks: section.blocks.map((rawBlock, index) => {
              const block = rawBlock && typeof rawBlock === 'object'
                ? rawBlock as Record<string, unknown>
                : {};
              const content = typeof block.content === 'string' ? block.content.trim() : '';
              return {
                id: typeof block.id === 'string' ? block.id : `${key}-${index}`,
                type: typeof block.type === 'string' ? block.type : 'bullet',
                color: 'default',
                content,
              };
            }),
          };
        }
        setMeetingSummary(formattedSummary);
      } catch (summaryError) {
        console.error('FETCH SUMMARY: Error fetching meeting summary:', summaryError);
        setMeetingSummary(null);
      }
    };

    const loadData = async () => {
      try {
        await fetchMeetingSummary();
      } finally {
        setIsLoading(false);
      }
    };

    void loadData();
  }, [meetingId]);

  useEffect(() => {
    const checkAutoGen = async () => {
      if (
        meetingDetails &&
        meetingSummary === null &&
        meetingDetails.transcripts.length > 0 &&
        !hasCheckedAutoGen
      ) {
        await setupAutoGeneration();
      }
    };

    void checkAutoGen();
  }, [hasCheckedAutoGen, meetingDetails, meetingSummary, setupAutoGeneration]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-bg px-6">
        <div className="max-w-sm text-center">
          <p className="text-ui font-semibold text-danger">{error}</p>
          <button
            type="button"
            onClick={() => router.push('/meetings')}
            className="mt-4 h-8 rounded-control border border-border bg-surface px-3 text-ui font-medium text-text hover:bg-bg"
          >
            Back to meetings
          </button>
        </div>
      </div>
    );
  }

  if (isLoading || isLoadingTranscripts || !meetingDetails) {
    return (
      <div className="flex h-full items-center justify-center bg-bg text-3">
        <LoaderIcon className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <MeetingHeader
        meetingId={meetingDetails.id}
        title={meetingDetails.title}
        createdAt={meetingDetails.created_at}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onTitleSaved={(title) => {
          setMeetingDetails((current) => current ? { ...current, title } : current);
        }}
        onDeleted={() => router.replace('/meetings')}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <PageContent
          meeting={meetingDetails}
          summaryData={meetingSummary}
          activeTab={activeTab}
          shouldAutoGenerate={shouldAutoGenerate}
          onAutoGenerateComplete={() => setShouldAutoGenerate(false)}
          onMeetingUpdated={async () => {
            await refetchMeetings();
          }}
          onRefetchTranscripts={refetch}
          segments={segments}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={loadMore}
        />
      </div>
    </div>
  );
}

export default function MeetingPage() {
  return (
    <Suspense
      fallback={(
        <div className="flex h-full items-center justify-center bg-bg text-3">
          <LoaderIcon className="h-5 w-5 animate-spin" />
        </div>
      )}
    >
      <MeetingContent />
    </Suspense>
  );
}
