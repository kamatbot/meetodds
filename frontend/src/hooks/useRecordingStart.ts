import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranscriptSession } from '@/contexts/TranscriptContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useConfig } from '@/contexts/ConfigContext';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { recordingService } from '@/services/recordingService';
import Analytics from '@/lib/analytics';
import { showRecordingNotification } from '@/lib/recordingNotification';
import { captureStartMessage, createCaptureStartGate, loadApprovedCapture, saveApprovedCapture } from '@/lib/capture-start';
import { toast } from 'sonner';

export interface RecordingStartOptions {
  title?: string | null;
}

interface UseRecordingStartReturn {
  handleRecordingStart: (options?: RecordingStartOptions) => Promise<void>;
  isAutoStarting: boolean;
}

const startGate = createCaptureStartGate();

export function useRecordingStart(
  isRecording: boolean,
  setIsRecording: (value: boolean) => void,
  showModal?: (name: 'modelSelector', message?: string) => void,
): UseRecordingStartReturn {
  const [isAutoStarting, setIsAutoStarting] = useState(false);
  const activeStart = useRef<AbortController | null>(null);
  useEffect(() => () => activeStart.current?.abort(), []);
  const { clearTranscripts, setMeetingTitle } = useTranscriptSession();
  const { setIsMeetingActive } = useSidebar();
  const { selectedDevices } = useConfig();
  const { setStatus } = useRecordingState();

  const handleRecordingStart = useCallback(async (options?: RecordingStartOptions) => {
    if (isRecording) return;
    await startGate.run(async () => {
      setIsAutoStarting(true);
      let nativeStarted = false;
      try {
        // Native state wins over stale React state after navigation or a delayed event.
        if (await recordingService.isRecording()) {
          setIsRecording(true);
          setIsMeetingActive(true);
          return;
        }
        const abort = new AbortController();
        activeStart.current = abort;
        const selectedMicrophone = selectedDevices?.micDevice || null;
        const selectedSystemAudio = selectedDevices?.systemDevice || null;
        let capture = loadApprovedCapture(selectedMicrophone, selectedSystemAudio);
        if (!capture) {
          const { reviewCaptureStart } = await import('@/components/Meeting/CapturePreflightReview');
          capture = await reviewCaptureStart(selectedMicrophone, selectedSystemAudio, abort.signal);
          if (capture) saveApprovedCapture(selectedMicrophone, selectedSystemAudio, capture);
        }
        if (!capture || abort.signal.aborted) return;
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const fallbackTitle = `Meeting ${pad(now.getDate())}_${pad(now.getMonth() + 1)}_${String(now.getFullYear()).slice(-2)}_${pad(now.getHours())}_${pad(now.getMinutes())}_${pad(now.getSeconds())}`;
        const requestedTitle = options?.title?.trim();
        const title = requestedTitle || fallbackTitle;
        setStatus(RecordingStatus.STARTING, 'Checking selected model and audio sources…');
        // The native command validates the configured engine/model, not an unrelated
        // Parakeet installation. This also keeps all three start routes consistent.
        setMeetingTitle(title);
        clearTranscripts();
        await recordingService.startRecordingWithDevices(
          capture.microphone,
          capture.systemAudio,
          title,
        );
        nativeStarted = true;
        setIsRecording(true);
        setIsMeetingActive(true);
        setStatus(RecordingStatus.RECORDING);
        // Notifications and telemetry must never turn successful capture into an error.
        try { await showRecordingNotification(); }
        catch { toast.info('Recording started', { description: 'The system notification could not be shown.' }); }
        void Promise.resolve(Analytics.trackButtonClick('start_recording', requestedTitle ? 'calendar_meeting' : 'unified_start')).catch(() => undefined);
      } catch (error) {
        if (!nativeStarted) {
          // A lost command response does not prove capture failed; reconcile before
          // reporting a stopped recorder or allowing another start.
          const active = await recordingService.isRecording().catch(() => null);
          if (active === true) {
            setIsRecording(true);
            setIsMeetingActive(true);
            setStatus(RecordingStatus.RECORDING);
            toast.warning('Recording is active', { description: 'The start response was interrupted. Check the live audio indicators.' });
            return;
          }
          const message = captureStartMessage(error);
          setStatus(RecordingStatus.ERROR, message);
          setIsRecording(false);
          if (/model|download/i.test(error instanceof Error ? error.message : String(error))) {
            showModal?.('modelSelector', message);
          }
          throw new Error(message);
        }
      } finally {
        activeStart.current = null;
        setIsAutoStarting(false);
      }
    });
  }, [isRecording, setIsRecording, setIsMeetingActive, setStatus, setMeetingTitle, clearTranscripts, selectedDevices, showModal]);

  useEffect(() => {
    if (sessionStorage.getItem('autoStartRecording') !== 'true' || isRecording || startGate.pending) return;
    sessionStorage.removeItem('autoStartRecording');
    void handleRecordingStart().catch((error: Error) => toast.error('Could not start recording', { description: error.message }));
  }, [handleRecordingStart, isRecording]);

  useEffect(() => {
    const start = () => { void handleRecordingStart().catch((error: Error) => toast.error('Could not start recording', { description: error.message })); };
    window.addEventListener('start-recording-from-sidebar', start);
    return () => window.removeEventListener('start-recording-from-sidebar', start);
  }, [handleRecordingStart]);

  return { handleRecordingStart, isAutoStarting };
}
