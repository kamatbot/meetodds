"use client";
import { useState, useEffect, useRef } from 'react';
import { Summary, SummaryResponse } from '@/types';
import Analytics from '@/lib/analytics';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { TranscriptPanel } from '@/components/MeetingDetails/TranscriptPanel';
import { SummaryPanel } from '@/components/MeetingDetails/SummaryPanel';
import NotesEditor from '@/components/Meeting/NotesEditor';
import { ModelConfig } from '@/components/ModelSettingsModal';
import type { MeetingDetailTab } from '@/components/Meeting/MeetingHeader';

// Custom hooks
import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useSummaryGeneration } from '@/hooks/meeting-details/useSummaryGeneration';
import { useTemplates } from '@/hooks/meeting-details/useTemplates';
import { useCopyOperations } from '@/hooks/meeting-details/useCopyOperations';
import { useMeetingOperations } from '@/hooks/meeting-details/useMeetingOperations';
import { useConfig } from '@/contexts/ConfigContext';

export default function PageContent({
  meeting,
  summaryData,
  activeTab,
  shouldAutoGenerate = false,
  onAutoGenerateComplete,
  onMeetingUpdated,
  onRefetchTranscripts,
  // Pagination props for efficient transcript loading
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
}: {
  meeting: any;
  summaryData: Summary | null;
  activeTab: MeetingDetailTab;
  shouldAutoGenerate?: boolean;
  onAutoGenerateComplete?: () => void;
  onMeetingUpdated?: () => Promise<void>;
  onRefetchTranscripts?: () => Promise<void>;
  // Pagination props
  segments?: any[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
}) {
  console.log('📄 PAGE CONTENT: Initializing with data:', {
    meetingId: meeting.id,
    summaryDataKeys: summaryData ? Object.keys(summaryData) : null,
    transcriptsCount: meeting.transcripts?.length
  });

  const [visitedTabs, setVisitedTabs] = useState<Set<MeetingDetailTab>>(() => new Set([activeTab]));
  useEffect(() => { setVisitedTabs(new Set([activeTab])); }, [meeting.id]);
  useEffect(() => { setVisitedTabs(previous => new Set([...previous, activeTab])); }, [activeTab]);

  // State
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const [isRecording] = useState(false);
  const [summaryResponse] = useState<SummaryResponse | null>(null);

  // Ref to store the modal open function from SummaryGeneratorButtonGroup
  const openModelSettingsRef = useRef<(() => void) | null>(null);

  // Get model config from ConfigContext
  const { modelConfig, setModelConfig } = useConfig();

  // Custom hooks stay mounted while tabs switch so summary/transcript state is not reloaded.
  const meetingData = useMeetingData({ meeting, summaryData, onMeetingUpdated });
  const templates = useTemplates();

  // Callback to register the modal open function
  const handleRegisterModalOpen = (openFn: () => void) => {
    console.log('📝 Registering modal open function in PageContent');
    openModelSettingsRef.current = openFn;
  };

  // Callback to trigger modal open (called from error handler)
  const handleOpenModelSettings = () => {
    console.log('🔔 Opening model settings from PageContent');
    if (openModelSettingsRef.current) {
      openModelSettingsRef.current();
    } else {
      console.warn('⚠️ Modal open function not yet registered');
    }
  };

  // Save model config to backend database and sync via event
  const handleSaveModelConfig = async (config?: ModelConfig) => {
    if (!config) return;
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey ?? null,
        ollamaEndpoint: config.ollamaEndpoint ?? null,
      });

      // Emit event so ConfigContext and other listeners stay in sync
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);

      toast.success('Model settings saved successfully');
    } catch (error) {
      console.error('Failed to save model config:', error);
      toast.error('Failed to save model settings');
    }
  };

  const summaryGeneration = useSummaryGeneration({
    meeting,
    transcripts: meetingData.transcripts,
    modelConfig: modelConfig,
    isModelConfigLoading: false, // ConfigContext loads on mount
    selectedTemplate: templates.selectedTemplate,
    onMeetingUpdated,
    updateMeetingTitle: meetingData.updateMeetingTitle,
    setAiSummary: meetingData.setAiSummary,
    onOpenModelSettings: handleOpenModelSettings,
  });

  const copyOperations = useCopyOperations({
    meeting,
    transcripts: meetingData.transcripts,
    meetingTitle: meetingData.meetingTitle,
    aiSummary: meetingData.aiSummary,
    blockNoteSummaryRef: meetingData.blockNoteSummaryRef,
  });

  const meetingOperations = useMeetingOperations({
    meeting,
  });

  useEffect(() => {
    Analytics.trackPageView('meeting_details');
  }, []);

  useEffect(() => {
    let cancelled = false;

    const autoGenerate = async () => {
      if (shouldAutoGenerate && meetingData.transcripts.length > 0 && !cancelled) {
        console.log(`🤖 Auto-generating summary with ${modelConfig.provider}/${modelConfig.model}...`);
        await summaryGeneration.handleGenerateSummary('');

        if (onAutoGenerateComplete && !cancelled) {
          onAutoGenerateComplete();
        }
      }
    };

    void autoGenerate();

    return () => {
      cancelled = true;
    };
  }, [shouldAutoGenerate, meeting.id]);

  const transcriptPanel = (
    <TranscriptPanel
      transcripts={meetingData.transcripts}
      customPrompt={customPrompt}
      onPromptChange={setCustomPrompt}
      onCopyTranscript={copyOperations.handleCopyTranscript}
      onOpenMeetingFolder={meetingOperations.handleOpenMeetingFolder}
      isRecording={isRecording}
      disableAutoScroll={true}
      usePagination={true}
      segments={segments}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      totalCount={totalCount}
      loadedCount={loadedCount}
      onLoadMore={onLoadMore}
      meetingId={meeting.id}
      meetingFolderPath={meeting.folder_path}
      onRefetchTranscripts={onRefetchTranscripts}
    />
  );

  const summaryPanel = (
    <SummaryPanel
      meeting={meeting}
      meetingTitle={meetingData.meetingTitle}
      onTitleChange={meetingData.handleTitleChange}
      isEditingTitle={meetingData.isEditingTitle}
      onStartEditTitle={() => meetingData.setIsEditingTitle(true)}
      onFinishEditTitle={() => meetingData.setIsEditingTitle(false)}
      isTitleDirty={meetingData.isTitleDirty}
      summaryRef={meetingData.blockNoteSummaryRef}
      isSaving={meetingData.isSaving}
      onSaveAll={meetingData.saveAllChanges}
      onCopySummary={copyOperations.handleCopySummary}
      onOpenFolder={meetingOperations.handleOpenMeetingFolder}
      aiSummary={meetingData.aiSummary}
      summaryStatus={summaryGeneration.summaryStatus}
      transcripts={meetingData.transcripts}
      modelConfig={modelConfig}
      setModelConfig={setModelConfig}
      onSaveModelConfig={handleSaveModelConfig}
      onGenerateSummary={summaryGeneration.handleGenerateSummary}
      onStopGeneration={summaryGeneration.handleStopGeneration}
      customPrompt={customPrompt}
      summaryResponse={summaryResponse}
      onSaveSummary={meetingData.handleSaveSummary}
      onSummaryChange={meetingData.handleSummaryChange}
      onDirtyChange={meetingData.setIsSummaryDirty}
      summaryError={summaryGeneration.summaryError}
      onRegenerateSummary={summaryGeneration.handleRegenerateSummary}
      getSummaryStatusMessage={summaryGeneration.getSummaryStatusMessage}
      availableTemplates={templates.availableTemplates}
      selectedTemplate={templates.selectedTemplate}
      onTemplateSelect={templates.handleTemplateSelection}
      isModelConfigLoading={false}
      onOpenModelSettings={handleRegisterModalOpen}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="min-h-0 flex-1 overflow-hidden">
        {(activeTab === 'summary' || visitedTabs.has('summary')) && (
          <div id="meeting-panel-summary" role="tabpanel" aria-labelledby="meeting-tab-summary" hidden={activeTab !== "summary"} className={activeTab === "summary" ? "flex h-full min-h-0 [&>div]:!bg-bg" : "hidden"}>
            {summaryPanel}
          </div>
        )}

        {(activeTab === 'transcript' || visitedTabs.has('transcript')) && (
          <div id="meeting-panel-transcript" role="tabpanel" aria-labelledby="meeting-tab-transcript" hidden={activeTab !== "transcript"} className={activeTab === "transcript" ? "flex h-full min-h-0 [&>div]:!flex [&>div]:!w-full [&>div]:!border-r-0 [&>div]:!bg-bg" : "hidden"}>
            {transcriptPanel}
          </div>
        )}

        {(activeTab === 'notes' || visitedTabs.has('notes')) && (
          <div id="meeting-panel-notes" role="tabpanel" aria-labelledby="meeting-tab-notes" hidden={activeTab !== 'notes'} className={activeTab === 'notes' ? 'h-full' : 'hidden'}><NotesEditor meetingId={meeting.id} /></div>
        )}
      </div>
    </div>
  );
}
