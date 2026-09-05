import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { PermissionWarning } from '@/components/PermissionWarning';
import { LiveTranslationControl } from '@/components/LiveTranslationControl';
import { LiveTranscriptSubtitle } from '@/components/LiveTranscriptSubtitle';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, GlobeIcon } from 'lucide-react';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { useLiveTranslation } from '@/hooks/useLiveTranslation';
import { liveTranslationSegmentKey } from '@/lib/live-translation';
import { ModalType } from '@/hooks/useModalState';
import { useIsLinux } from '@/hooks/usePlatform';
import { useMemo } from 'react';

/**
 * TranscriptPanel Component
 *
 * Displays transcript content with controls for copying, language settings,
 * and low-latency live translation.
 * Uses TranscriptContext, ConfigContext, and RecordingStateContext internally.
 */

interface TranscriptPanelProps {
  // indicates stop-processing state for transcripts; derived from backend statuses.
  isProcessingStop: boolean;
  isStopping: boolean;
  showModal: (name: ModalType, message?: string) => void;
}

export function TranscriptPanel({
  isProcessingStop,
  isStopping,
  showModal
}: TranscriptPanelProps) {
  // Contexts
  const { transcripts, livePreview, transcriptContainerRef, copyTranscript, captionsVisible, setCaptionsVisible, previewSettled } = useTranscripts();
  const { transcriptModelConfig } = useConfig();
  const { isRecording, isPaused } = useRecordingState();
  const { checkPermissions, isChecking, hasSystemAudio, hasMicrophone } = usePermissionCheck();
  const isLinux = useIsLinux();
  const liveTranslation = useLiveTranslation(transcripts, livePreview);

  // Convert transcripts to segments for virtualized view. Translation is merged
  // at render time so the original transcript pipeline remains completely independent.
  const segments = useMemo(() =>
    transcripts.map(t => {
      const translation = liveTranslation.translations[liveTranslationSegmentKey(t)];
      return {
        id: t.id,
        timestamp: t.audio_start_time ?? 0,
        endTime: t.audio_end_time,
        text: t.text,
        confidence: t.confidence,
        speaker: t.speaker,
        speaker_label: t.speaker_label,
        speaker_source: t.speaker_source,
        speaker_confidence: t.speaker_confidence,
        translated_text: translation?.translatedText,
        translation_status: translation?.status,
        translation_error: translation?.error,
        translation_latency_ms: translation?.latencyMs,
      };
    }),
    [transcripts, liveTranslation.translations]
  );

  return (
    <div ref={transcriptContainerRef} className="relative w-full border-r border-gray-200 bg-white flex flex-col overflow-y-auto">
      {/* Title area - Sticky header */}
      <div className="sticky top-0 z-10 bg-white p-4 border-gray-200">
        <div className="flex flex-col space-y-3">
          <div className="flex flex-col space-y-2">
            <div className="flex justify-center items-center space-x-2">
              <ButtonGroup>
                {transcripts?.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={copyTranscript}
                    title="Copy Transcript"
                  >
                    <Copy />
                    <span className='hidden md:inline'>
                      Copy
                    </span>
                  </Button>
                )}
                {transcriptModelConfig.provider === "localWhisper" &&
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => showModal('languageSettings')}
                    title="Transcription language"
                  >
                    <GlobeIcon />
                    <span className='hidden md:inline'>
                      Language
                    </span>
                  </Button>
                }
                <LiveTranslationControl
                  settings={liveTranslation.settings}
                  updateSettings={liveTranslation.updateSettings}
                  clearTranslations={liveTranslation.clearTranslations}
                  queuedCount={liveTranslation.queuedCount}
                  activeCount={liveTranslation.activeCount}
                  translatedCount={liveTranslation.translatedCount}
                  lastError={liveTranslation.lastError}
                  lastProvider={liveTranslation.lastProvider}
                  lastModel={liveTranslation.lastModel}
                  lastLatencyMs={liveTranslation.lastLatencyMs}
                  lastFirstWordLatencyMs={liveTranslation.lastFirstWordLatencyMs}
                  lastFallbackReason={liveTranslation.lastFallbackReason}
                />
              </ButtonGroup>
            </div>
          </div>
        </div>
      </div>

      {/* Permission Warning - Not needed on Linux */}
      {!isRecording && !isChecking && !isLinux && (
        <div className="flex justify-center px-4 pt-4">
          <PermissionWarning
            hasMicrophone={hasMicrophone}
            hasSystemAudio={hasSystemAudio}
            onRecheck={checkPermissions}
            isRechecking={isChecking}
          />
        </div>
      )}

      {/* Transcript content */}
      <div className="pb-20">
        <div className="flex justify-center">
          <div className="w-2/3 max-w-[750px]">
            <VirtualizedTranscriptView
              segments={segments}
              isRecording={isRecording}
              isPaused={isPaused}
              isProcessing={isProcessingStop}
              isStopping={isStopping}
              enableStreaming={isRecording}
              showConfidence={true}
              translationEnabled={liveTranslation.settings.enabled}
              translationDisplayMode={liveTranslation.settings.displayMode}
              translationTargetLanguage={liveTranslation.settings.targetLanguage}
            />
          </div>
        </div>
      </div>

      {isRecording && captionsVisible && (
        <LiveTranscriptSubtitle
          preview={livePreview}
          translation={liveTranslation.previewTranslation}
          translationEnabled={liveTranslation.settings.enabled}
          translationDisplayMode={liveTranslation.settings.displayMode}
          translationTargetLanguage={liveTranslation.settings.targetLanguage}
          isPaused={isPaused}
          settled={previewSettled}
          onDismiss={() => setCaptionsVisible(false)}
        />
      )}
    </div>
  );
}
