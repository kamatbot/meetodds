'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import HomeDashboard from '@/components/Home/HomeDashboard';
import LiveMeetingBar from '@/components/Meeting/LiveMeetingBar';
import TranscriptDrawer from '@/components/Meeting/TranscriptDrawer';
import LiveMeetingNotes from '@/components/Meeting/LiveMeetingNotes';
import StopProgressStrip from '@/components/Meeting/StopProgressStrip';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { useTranscriptSession } from '@/contexts/TranscriptContext';
import { useCalendarAwareness } from '@/contexts/CalendarAwarenessContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { recordingService } from '@/services/recordingService';
import type { CalendarEvent } from '@/services/calendarService';
import Analytics from '@/lib/analytics';
import { SettingsModals } from './_components/SettingsModal';
import { useModalState } from '@/hooks/useModalState';
import { useRecordingStateSync } from '@/hooks/useRecordingStateSync';
import { useRecordingStart } from '@/hooks/useRecordingStart';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { useTranscriptRecovery } from '@/hooks/useTranscriptRecovery';
import { TranscriptRecovery } from '@/components/TranscriptRecovery';
import { indexedDBService } from '@/services/indexedDBService';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';

export default function Home() {
  const [isRecording, setIsRecordingState] = useState(false);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);
  const [isHomeControlBusy, setIsHomeControlBusy] = useState(false);
  const { transcriptModelConfig } = useConfig();
  const { openImportDialog } = useImportDialog();
  const calendar = useCalendarAwareness();
  const { currentMeetingId, captionsVisible, setCaptionsVisible } = useTranscriptSession();
  const recordingState = useRecordingState();
  const { status, isStopping, isProcessing } = recordingState;
  const inAppRecording = recordingState.isRecording || isRecording;
  const { hasMicrophone, hasSystemAudio, isChecking: isCheckingPermissions, error: permissionError } = usePermissionCheck();
  const { setIsMeetingActive, refetchMeetings } = useSidebar();
  const { modals, messages, showModal, hideModal } = useModalState(transcriptModelConfig);
  const { isRecordingDisabled, setIsRecordingDisabled } = useRecordingStateSync(isRecording, setIsRecordingState, setIsMeetingActive);
  const { handleRecordingStart } = useRecordingStart(isRecording, setIsRecordingState, showModal);
  const { handleRecordingStop, setIsStopping } = useRecordingStop(setIsRecordingState, setIsRecordingDisabled);
  const { recoverableMeetings, isLoading: isLoadingRecovery, checkForRecoverableTranscripts, recoverMeeting, loadMeetingTranscripts, deleteRecoverableMeeting } = useTranscriptRecovery();
  const router = useRouter();

  useEffect(() => { Analytics.trackPageView('home'); }, []);
  useEffect(() => {
    const performStartupChecks = async () => {
      try {
        if (recordingState.isRecording || status === RecordingStatus.STOPPING || status === RecordingStatus.PROCESSING_TRANSCRIPTS || status === RecordingStatus.SAVING) return;
        try { await indexedDBService.deleteSavedMeetings(24); } catch (error) { console.warn('Failed to clean up saved meetings:', error); }
        await checkForRecoverableTranscripts();
      } catch (error) { console.error('Failed to perform startup checks:', error); }
    };
    void performStartupChecks();
  }, [checkForRecoverableTranscripts, recordingState.isRecording, status]);

  useEffect(() => {
    if (!inAppRecording && status !== RecordingStatus.STARTING && status !== RecordingStatus.STOPPING && status !== RecordingStatus.PROCESSING_TRANSCRIPTS && status !== RecordingStatus.SAVING) {
      calendar.setRecordingEvent(null);
    }
  }, [inAppRecording, status, calendar.setRecordingEvent]);

  const handleRecovery = async (meetingId: string) => {
    try {
      const result = await recoverMeeting(meetingId);
      if (result.success) {
        toast.success('Meeting recovered successfully!', { description: result.audioRecoveryStatus?.audio_file_path ? 'Transcripts and audio recovered' : 'Transcripts recovered (no audio available)', action: result.meetingId ? { label: 'View Meeting', onClick: () => router.push(`/meeting?id=${result.meetingId}`) } : undefined, duration: 10_000 });
        await refetchMeetings();
        if (recoverableMeetings.length === 0) sessionStorage.removeItem('recovery_dialog_shown');
        if (result.meetingId) setTimeout(() => router.push(`/meeting?id=${result.meetingId}`), 2_000);
      }
    } catch (error) { toast.error('Failed to recover meeting', { description: error instanceof Error ? error.message : 'Unknown error occurred' }); throw error; }
  };
  const handleDialogClose = () => { setShowRecoveryDialog(false); if (recoverableMeetings.length === 0) sessionStorage.removeItem('recovery_dialog_shown'); };
  const isProcessingStop = status === RecordingStatus.PROCESSING_TRANSCRIPTS || isProcessing;
  const recordingBusy = inAppRecording || status === RecordingStatus.STARTING || status === RecordingStatus.STOPPING || status === RecordingStatus.PROCESSING_TRANSCRIPTS || status === RecordingStatus.SAVING;
  const handleNewMeeting = async () => {
    if (!hasMicrophone || recordingBusy || isRecordingDisabled) return;
    calendar.setRecordingEvent(null);
    try { await handleRecordingStart(); }
    catch (error) { showModal('errorAlert', error instanceof Error ? error.message : 'Failed to start recording'); }
  };
  const handleCalendarMeetingStart = useCallback(async (event: CalendarEvent) => {
    if (!hasMicrophone || recordingBusy || isRecordingDisabled) return;
    try {
      await handleRecordingStart({ title: event.title });
      if (await recordingService.isRecording().catch(() => false)) calendar.setRecordingEvent(event);
    } catch (error) {
      showModal('errorAlert', error instanceof Error ? error.message : 'Failed to start recording');
    }
  }, [hasMicrophone, recordingBusy, isRecordingDisabled, handleRecordingStart, calendar.setRecordingEvent, showModal]);
  const handleHomePauseResume = useCallback(async () => {
    if (!inAppRecording || isHomeControlBusy) return; setIsHomeControlBusy(true);
    try { await invoke(recordingState.isPaused ? 'resume_recording' : 'pause_recording'); }
    catch (error) { toast.error(`Could not ${recordingState.isPaused ? 'resume' : 'pause'} recording`, { description: error instanceof Error ? error.message : String(error) }); }
    finally { setIsHomeControlBusy(false); }
  }, [inAppRecording, isHomeControlBusy, recordingState.isPaused]);
  const handleHomeStop = useCallback(async () => {
    if (!inAppRecording || isHomeControlBusy) return; setIsHomeControlBusy(true); setIsStopping(true);
    try {
      const dataDir = await appDataDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      await invoke('stop_recording', { args: { save_path: `${dataDir}/recording-${timestamp}.wav` } });
      await handleRecordingStop(true);
      calendar.setRecordingEvent(null);
    }
    catch (error) { setIsStopping(false); toast.error('Could not stop recording', { description: error instanceof Error ? error.message : String(error) }); }
    finally { setIsHomeControlBusy(false); }
  }, [handleRecordingStop, inAppRecording, isHomeControlBusy, setIsStopping, calendar.setRecordingEvent]);

  return <div className="relative flex h-full min-h-0 flex-col bg-bg">
    <SettingsModals modals={modals} messages={messages} onClose={hideModal} />
    <TranscriptRecovery isOpen={showRecoveryDialog} onClose={handleDialogClose} recoverableMeetings={recoverableMeetings} onRecover={handleRecovery} onDelete={deleteRecoverableMeeting} onLoadPreview={loadMeetingTranscripts} />
    <StopProgressStrip isProcessing={status === RecordingStatus.PROCESSING_TRANSCRIPTS && !recordingState.isRecording} isSaving={status === RecordingStatus.SAVING} />

    <div className="relative flex min-h-0 flex-1">
      {inAppRecording || isStopping || isProcessingStop ? <div className="live-recording-layout w-full">
        <main className="live-notes-pane" aria-label="Live meeting notes">
          {currentMeetingId ? <LiveMeetingNotes meetingId={currentMeetingId} calendarEvent={calendar.recordingEvent} /> : <div className="flex h-full items-center justify-center text-[12px] text-3">Preparing meeting notes…</div>}
        </main>
        <TranscriptDrawer presentation="drawer" isProcessingStop={isProcessingStop} isStopping={isStopping} showModal={showModal} />
      </div> : <div className="min-w-0 flex-1"><HomeDashboard hasMicrophone={hasMicrophone} hasSystemAudio={hasSystemAudio} permissionsLoading={isCheckingPermissions} permissionError={permissionError} recoverableMeetings={recoverableMeetings} isRecoveryLoading={isLoadingRecovery} isRecording={inAppRecording} recordingStatus={status} recordingDuration={recordingState.recordingDuration} newMeetingDisabled={!hasMicrophone || isRecordingDisabled} onNewMeeting={() => void handleNewMeeting()} onCalendarMeetingStart={(event) => void handleCalendarMeetingStart(event)} onImport={(filePath) => openImportDialog(filePath)} onReviewRecovery={() => setShowRecoveryDialog(true)} onOpenSettings={() => router.push('/settings')} /></div>}
    </div>

    {(inAppRecording || isStopping || isProcessingStop) && <LiveMeetingBar isPaused={recordingState.isPaused} isBusy={isHomeControlBusy || isStopping || isProcessingStop} captionsVisible={captionsVisible} onPauseResume={() => void handleHomePauseResume()} onStop={() => void handleHomeStop()} onToggleCaptions={() => setCaptionsVisible(!captionsVisible)} />}
  </div>;
}
