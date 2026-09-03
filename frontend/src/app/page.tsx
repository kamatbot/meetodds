'use client';

import { useEffect, useState } from 'react';
import { RecordingControls } from '@/components/RecordingControls';
import HomeDashboard from '@/components/Home/HomeDashboard';
import TranscriptDrawer from '@/components/Meeting/TranscriptDrawer';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { StatusOverlays } from '@/app/_components/StatusOverlays';
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
  // Keep the existing local recorder state because the start/stop hooks still depend on it.
  const [isRecording, setIsRecordingState] = useState(false);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);

  const { meetingTitle } = useTranscripts();
  const { transcriptModelConfig, selectedDevices } = useConfig();
  const { openImportDialog } = useImportDialog();
  const recordingState = useRecordingState();
  const { status, isStopping, isProcessing } = recordingState;

  const {
    hasMicrophone,
    hasSystemAudio,
    isChecking: isCheckingPermissions,
    error: permissionError,
  } = usePermissionCheck();
  const {
    setIsMeetingActive,
    isCollapsed: sidebarCollapsed,
    refetchMeetings,
  } = useSidebar();
  const { modals, messages, showModal, hideModal } = useModalState(transcriptModelConfig);
  const { isRecordingDisabled, setIsRecordingDisabled } = useRecordingStateSync(
    isRecording,
    setIsRecordingState,
    setIsMeetingActive,
  );
  const { handleRecordingStart } = useRecordingStart(
    isRecording,
    setIsRecordingState,
    showModal,
  );
  const { handleRecordingStop, setIsStopping } = useRecordingStop(
    setIsRecordingState,
    setIsRecordingDisabled,
  );

  const {
    recoverableMeetings,
    isLoading: isLoadingRecovery,
    checkForRecoverableTranscripts,
    recoverMeeting,
    loadMeetingTranscripts,
    deleteRecoverableMeeting,
  } = useTranscriptRecovery();

  const router = useRouter();

  useEffect(() => {
    Analytics.trackPageView('home');
  }, []);

  // Preserve the existing startup cleanup and recovery scan. Recovery is surfaced in
  // the dashboard instead of automatically interrupting the user with a modal.
  useEffect(() => {
    const performStartupChecks = async () => {
      try {
        if (
          recordingState.isRecording ||
          status === RecordingStatus.STOPPING ||
          status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
          status === RecordingStatus.SAVING
        ) {
          console.log('Skipping recovery check - recording in progress or processing');
          return;
        }

        try {
          await indexedDBService.deleteOldMeetings(7);
        } catch (error) {
          console.warn('⚠️ Failed to clean up old meetings:', error);
        }

        try {
          await indexedDBService.deleteSavedMeetings(24);
        } catch (error) {
          console.warn('⚠️ Failed to clean up saved meetings:', error);
        }

        await checkForRecoverableTranscripts();
      } catch (error) {
        console.error('Failed to perform startup checks:', error);
      }
    };

    void performStartupChecks();
  }, [checkForRecoverableTranscripts, recordingState.isRecording, status]);

  const handleRecovery = async (meetingId: string) => {
    try {
      const result = await recoverMeeting(meetingId);

      if (result.success) {
        toast.success('Meeting recovered successfully!', {
          description: result.audioRecoveryStatus?.status === 'success'
            ? 'Transcripts and audio recovered'
            : 'Transcripts recovered (no audio available)',
          action: result.meetingId ? {
            label: 'View Meeting',
            onClick: () => {
              router.push(`/meeting?id=${result.meetingId}`);
            },
          } : undefined,
          duration: 10_000,
        });

        await refetchMeetings();

        if (recoverableMeetings.length === 0) {
          sessionStorage.removeItem('recovery_dialog_shown');
        }

        if (result.meetingId) {
          setTimeout(() => {
            router.push(`/meeting?id=${result.meetingId}`);
          }, 2_000);
        }
      }
    } catch (error) {
      toast.error('Failed to recover meeting', {
        description: error instanceof Error ? error.message : 'Unknown error occurred',
      });
      throw error;
    }
  };

  const handleDialogClose = () => {
    setShowRecoveryDialog(false);
    if (recoverableMeetings.length === 0) {
      sessionStorage.removeItem('recovery_dialog_shown');
    }
  };

  const isProcessingStop = status === RecordingStatus.PROCESSING_TRANSCRIPTS || isProcessing;
  const recordingBusy =
    recordingState.isRecording ||
    status === RecordingStatus.STARTING ||
    status === RecordingStatus.STOPPING ||
    status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
    status === RecordingStatus.SAVING;

  const handleNewMeeting = async () => {
    if (!hasMicrophone || recordingBusy || isRecordingDisabled) return;
    try {
      await handleRecordingStart();
    } catch (error) {
      showModal(
        'errorAlert',
        error instanceof Error ? error.message : 'Failed to start recording',
      );
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-bg">
      <SettingsModals
        modals={modals}
        messages={messages}
        onClose={hideModal}
      />

      <TranscriptRecovery
        isOpen={showRecoveryDialog}
        onClose={handleDialogClose}
        recoverableMeetings={recoverableMeetings}
        onRecover={handleRecovery}
        onDelete={deleteRecoverableMeeting}
        onLoadPreview={loadMeetingTranscripts}
      />

      <div className="relative flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <HomeDashboard
            hasMicrophone={hasMicrophone}
            hasSystemAudio={hasSystemAudio}
            permissionsLoading={isCheckingPermissions}
            permissionError={permissionError}
            recoverableMeetings={recoverableMeetings}
            isRecoveryLoading={isLoadingRecovery}
            isRecording={recordingState.isRecording}
            recordingStatus={status}
            recordingDuration={recordingState.recordingDuration}
            newMeetingDisabled={!hasMicrophone || isRecordingDisabled}
            onNewMeeting={() => void handleNewMeeting()}
            onImport={(filePath) => openImportDialog(filePath)}
            onReviewRecovery={() => setShowRecoveryDialog(true)}
            onOpenSettings={() => router.push('/settings')}
          />
        </div>

        {(recordingState.isRecording || isStopping || isProcessingStop) && (
          <TranscriptDrawer
            isProcessingStop={isProcessingStop}
            isStopping={isStopping}
            showModal={showModal}
          />
        )}
      </div>

      {recordingState.isRecording &&
        status !== RecordingStatus.PROCESSING_TRANSCRIPTS &&
        status !== RecordingStatus.SAVING && (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 z-30 flex justify-center px-6">
            <div className="pointer-events-auto">
              <RecordingControls
                isRecording={recordingState.isRecording}
                onRecordingStop={(callApi = true) => handleRecordingStop(callApi)}
                onRecordingStart={handleRecordingStart}
                onTranscriptReceived={() => {}}
                onStopInitiated={() => setIsStopping(true)}
                barHeights={[]}
                onTranscriptionError={(message) => {
                  showModal('errorAlert', message);
                }}
                isRecordingDisabled={isRecordingDisabled}
                isParentProcessing={isProcessingStop}
                selectedDevices={selectedDevices}
                meetingName={meetingTitle}
              />
            </div>
          </div>
        )}

      <StatusOverlays
        isProcessing={status === RecordingStatus.PROCESSING_TRANSCRIPTS && !recordingState.isRecording}
        isSaving={status === RecordingStatus.SAVING}
        sidebarCollapsed={sidebarCollapsed}
      />
    </div>
  );
}
