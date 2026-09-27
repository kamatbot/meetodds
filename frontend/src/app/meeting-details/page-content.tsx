'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import type { Summary } from '@/types';
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
  const [notesOpen, setNotesOpen] = useState(activeTab === 'notes');
  const [customPrompt, setCustomPrompt] = useState('');
  const openModelSettingsRef = useRef<(() => void) | null>(null);
  const autoStartedFor = useRef<string | null>(null);
  const { modelConfig, setModelConfig } = useConfig();
  const meetingData = useMeetingData({ meeting, summaryData, onMeetingUpdated });
  const templates = useTemplates();
  const handleRegisterModalOpen = useCallback((open: () => void) => { openModelSettingsRef.current = open; }, []);
  const handleOpenModelSettings = useCallback(() => { openModelSettingsRef.current?.(); }, []);

  useEffect(() => {
    if (activeTab === 'notes') setNotesOpen(true);
    if (activeTab === 'transcript') setNotesOpen(false);
  }, [activeTab]);
  useEffect(() => { Analytics.trackPageView('meeting_details'); }, []);

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

  useEffect(() => {
    if (!shouldAutoGenerate || summaryGeneration.isCheckingSummary || !meetingData.transcripts.length || autoStartedFor.current === meeting.id) return;
    autoStartedFor.current = meeting.id;
    // Parent consent and this hook own automatic generation. Keep both mounted
    // while the transcript is being read so a background job can finish here.
    void generationRef.current.handleGenerateSummary('', { automatic: true })
      .finally(() => onAutoCompleteRef.current?.());
  }, [shouldAutoGenerate, meeting.id, summaryGeneration.isCheckingSummary, meetingData.transcripts.length]);

  const summaryPanel = <SummaryPanel
    meeting={meeting} meetingTitle={meetingData.meetingTitle} summaryRef={meetingData.blockNoteSummaryRef}
    isSaving={meetingData.isSaving} onSaveAll={meetingData.saveAllChanges}
    onCopySummary={copyOperations.handleCopySummary} aiSummary={meetingData.aiSummary}
    summaryStatus={summaryGeneration.summaryStatus} transcripts={meetingData.transcripts}
    modelConfig={modelConfig} setModelConfig={setModelConfig} onSaveModelConfig={handleSaveModelConfig}
    onGenerateSummary={summaryGeneration.handleGenerateSummary} onStopGeneration={summaryGeneration.handleStopGeneration}
    customPrompt={customPrompt} onCustomPromptChange={setCustomPrompt}
    onSaveSummary={meetingData.handleSaveSummary} onSummaryChange={meetingData.handleSummaryChange}
    onDirtyChange={meetingData.setIsSummaryDirty} summaryError={summaryGeneration.summaryError}
    onOpenFolder={meetingOperations.handleOpenMeetingFolder}
    availableTemplates={templates.availableTemplates} selectedTemplate={templates.selectedTemplate}
    onTemplateSelect={templates.handleTemplateSelection} isModelConfigLoading={summaryGeneration.isCheckingSummary}
    onOpenModelSettings={handleRegisterModalOpen} notesOpen={notesOpen} onToggleNotes={() => setNotesOpen(value => !value)}
  />;

  const transcriptPanel = <TranscriptPanel
    transcripts={meetingData.transcripts} onCopyTranscript={copyOperations.handleCopyTranscript}
    onOpenMeetingFolder={meetingOperations.handleOpenMeetingFolder} isRecording={false} disableAutoScroll usePagination
    segments={segments} hasMore={hasMore} isLoadingMore={isLoadingMore} totalCount={totalCount}
    loadedCount={loadedCount} onLoadMore={onLoadMore} meetingId={meeting.id}
    meetingFolderPath={meeting.folder_path} onRefetchTranscripts={onRefetchTranscripts} focusSegmentId={focusSegmentId}
  />;

  return <div className="grid h-full min-h-0 min-w-0 grid-cols-2 bg-bg">
    <div className="min-h-0 min-w-0 border-r border-border">{transcriptPanel}</div>
    <div className="flex min-h-0 min-w-0 flex-col">
      {notesOpen && <section aria-label="Meeting notes" className="flex h-[38%] min-h-0 max-h-[320px] shrink-0 flex-col overflow-hidden border-b border-border bg-bg px-5 py-3">
        <div className="mb-1 flex shrink-0 justify-end"><button type="button" onClick={() => setNotesOpen(false)} aria-label="Close notes" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-3 hover:bg-panel-2 hover:text-text"><X size={13} />Close</button></div>
        <details className="mb-2 shrink-0">
          <summary className="cursor-pointer py-2 text-xs font-medium text-3">Transcript-linked notes</summary>
          <ManualNotesCard meetingId={meeting.id} />
        </details>
        <div className="min-h-0 flex-1 overflow-auto [&>div>div>textarea]:!min-h-0"><NotesEditor meetingId={meeting.id} /></div>
      </section>}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{summaryPanel}</div>
    </div>
  </div>;
}
