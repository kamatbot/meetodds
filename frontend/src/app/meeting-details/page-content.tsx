'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Summary, SummaryResponse } from '@/types';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { TranscriptPanel } from '@/components/MeetingDetails/TranscriptPanel';
import { SummaryPanel } from '@/components/MeetingDetails/SummaryPanel';
import NotesEditor from '@/components/Meeting/NotesEditor';
import ManualNotesCard from '@/components/Meeting/ManualNotesCard';
import type { ModelConfig } from '@/components/ModelSettingsModal';
import type { MeetingDetailTab } from '@/components/Meeting/MeetingHeader';
import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useSummaryGeneration } from '@/hooks/meeting-details/useSummaryGeneration';
import { useTemplates } from '@/hooks/meeting-details/useTemplates';
import { useCopyOperations } from '@/hooks/meeting-details/useCopyOperations';
import { useMeetingOperations } from '@/hooks/meeting-details/useMeetingOperations';
import { useConfig } from '@/contexts/ConfigContext';
import Analytics from '@/lib/analytics';

export default function PageContent({ meeting, summaryData, activeTab, shouldAutoGenerate = false,
  onAutoGenerateComplete, onMeetingUpdated, onRefetchTranscripts,
  segments, hasMore, isLoadingMore, totalCount, loadedCount, onLoadMore, focusSegmentId,
}: {
  meeting: any;
  summaryData: Summary | null;
  activeTab: MeetingDetailTab;
  shouldAutoGenerate?: boolean;
  onAutoGenerateComplete?: () => void;
  onMeetingUpdated?: () => Promise<void>;
  onRefetchTranscripts?: () => Promise<void>;
  segments?: any[]; hasMore?: boolean; isLoadingMore?: boolean; totalCount?: number; loadedCount?: number;
  onLoadMore?: () => void; focusSegmentId?: string | null;
}) {
  const [visitedTabs, setVisitedTabs] = useState<Set<MeetingDetailTab>>(() => new Set([activeTab]));
  useEffect(() => { setVisitedTabs(new Set([activeTab])); }, [meeting.id]);
  useEffect(() => { setVisitedTabs(previous => previous.has(activeTab) ? previous : new Set([...previous, activeTab])); }, [activeTab]);
  const [customPrompt, setCustomPrompt] = useState('');
  const [summaryResponse] = useState<SummaryResponse | null>(null);
  const openModelSettingsRef = useRef<(() => void) | null>(null);
  const autoStartedFor = useRef<string | null>(null);
  const { modelConfig, setModelConfig } = useConfig();
  const meetingData = useMeetingData({ meeting, summaryData, onMeetingUpdated });
  const templates = useTemplates();
  const handleRegisterModalOpen = useCallback((open: () => void) => { openModelSettingsRef.current = open; }, []);
  const handleOpenModelSettings = useCallback(() => { openModelSettingsRef.current?.(); }, []);
  const handleSaveModelConfig = async (config?: ModelConfig) => {
    if (!config) return;
    try {
      await invoke('api_save_model_config', {
        provider: config.provider, model: config.model, whisperModel: config.whisperModel,
        apiKey: config.apiKey ?? null, ollamaEndpoint: config.ollamaEndpoint ?? null,
      });
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);
      toast.success('Model settings saved');
    } catch (error) { toast.error('Failed to save model settings'); throw error; }
  };
  const summaryGeneration = useSummaryGeneration({
    meeting, transcripts: meetingData.transcripts, modelConfig, isModelConfigLoading: false,
    selectedTemplate: templates.selectedTemplate, onMeetingUpdated,
    updateMeetingTitle: meetingData.updateMeetingTitle, setAiSummary: meetingData.setAiSummary,
    onOpenModelSettings: handleOpenModelSettings,
  });
  const generationRef = useRef(summaryGeneration); generationRef.current = summaryGeneration;
  const onAutoCompleteRef = useRef(onAutoGenerateComplete); onAutoCompleteRef.current = onAutoGenerateComplete;
  const copyOperations = useCopyOperations({ meeting, transcripts: meetingData.transcripts, meetingTitle: meetingData.meetingTitle, aiSummary: meetingData.aiSummary, blockNoteSummaryRef: meetingData.blockNoteSummaryRef });
  const meetingOperations = useMeetingOperations({ meeting });
  useEffect(() => { Analytics.trackPageView('meeting_details'); }, []);
  useEffect(() => {
    if (!shouldAutoGenerate || summaryGeneration.isCheckingSummary || !meetingData.transcripts.length || autoStartedFor.current === meeting.id) return;
    autoStartedFor.current = meeting.id;
    // The hook also claims a persistent per-meeting attempt and checks the native
    // job before dispatch. React effects/reloads cannot create duplicate AI calls.
    void generationRef.current.handleGenerateSummary('', { automatic: true })
      .finally(() => onAutoCompleteRef.current?.());
  }, [shouldAutoGenerate, meeting.id, summaryGeneration.isCheckingSummary, meetingData.transcripts.length]);

  const summaryPanel = <SummaryPanel
    meeting={meeting} meetingTitle={meetingData.meetingTitle} onTitleChange={meetingData.handleTitleChange}
    isEditingTitle={meetingData.isEditingTitle} onStartEditTitle={() => meetingData.setIsEditingTitle(true)} onFinishEditTitle={() => meetingData.setIsEditingTitle(false)}
    isTitleDirty={meetingData.isTitleDirty} summaryRef={meetingData.blockNoteSummaryRef} isSaving={meetingData.isSaving}
    onSaveAll={meetingData.saveAllChanges} onCopySummary={copyOperations.handleCopySummary} onOpenFolder={meetingOperations.handleOpenMeetingFolder}
    aiSummary={meetingData.aiSummary} summaryStatus={summaryGeneration.summaryStatus} transcripts={meetingData.transcripts}
    modelConfig={modelConfig} setModelConfig={setModelConfig} onSaveModelConfig={handleSaveModelConfig}
    onGenerateSummary={summaryGeneration.handleGenerateSummary} onStopGeneration={summaryGeneration.handleStopGeneration}
    customPrompt={customPrompt} summaryResponse={summaryResponse} onSaveSummary={meetingData.handleSaveSummary}
    onSummaryChange={meetingData.handleSummaryChange} onDirtyChange={meetingData.setIsSummaryDirty}
    summaryError={summaryGeneration.summaryError} onRegenerateSummary={summaryGeneration.handleRegenerateSummary}
    getSummaryStatusMessage={summaryGeneration.getSummaryStatusMessage} availableTemplates={templates.availableTemplates}
    selectedTemplate={templates.selectedTemplate} onTemplateSelect={templates.handleTemplateSelection}
    isModelConfigLoading={summaryGeneration.isCheckingSummary} onOpenModelSettings={handleRegisterModalOpen}
  />;
  const transcriptPanel = <TranscriptPanel
    transcripts={meetingData.transcripts} customPrompt={customPrompt} onPromptChange={setCustomPrompt}
    onCopyTranscript={copyOperations.handleCopyTranscript} onOpenMeetingFolder={meetingOperations.handleOpenMeetingFolder}
    isRecording={false} disableAutoScroll usePagination segments={segments} hasMore={hasMore} isLoadingMore={isLoadingMore}
    totalCount={totalCount} loadedCount={loadedCount} onLoadMore={onLoadMore} meetingId={meeting.id}
    meetingFolderPath={meeting.folder_path} onRefetchTranscripts={onRefetchTranscripts} focusSegmentId={focusSegmentId}
  />;
  return <div className="flex h-full min-h-0 flex-col bg-bg"><div className="min-h-0 flex-1 overflow-hidden">
    {(activeTab === 'summary' || visitedTabs.has('summary')) && <div id="meeting-panel-summary" role="tabpanel" aria-labelledby="meeting-tab-summary" hidden={activeTab !== 'summary'} className={activeTab === 'summary' ? 'flex h-full min-h-0 [&>div]:!bg-bg' : 'hidden'}>{summaryPanel}</div>}
    {(activeTab === 'transcript' || visitedTabs.has('transcript')) && <div id="meeting-panel-transcript" role="tabpanel" aria-labelledby="meeting-tab-transcript" hidden={activeTab !== 'transcript'} className={activeTab === 'transcript' ? 'flex h-full min-h-0 [&>div]:!flex [&>div]:!w-full [&>div]:!border-r-0 [&>div]:!bg-bg' : 'hidden'}>{transcriptPanel}</div>}
    {(activeTab === 'notes' || visitedTabs.has('notes')) && <div id="meeting-panel-notes" role="tabpanel" aria-labelledby="meeting-tab-notes" hidden={activeTab !== 'notes'} className={activeTab === 'notes' ? 'flex h-full min-h-0 flex-col' : 'hidden'}><ManualNotesCard meetingId={meeting.id} /><div className="min-h-0 flex-1 overflow-hidden"><NotesEditor meetingId={meeting.id} /></div></div>}
  </div></div>;
}
