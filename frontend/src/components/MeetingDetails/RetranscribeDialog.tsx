import React, { useState, useEffect, useRef } from 'react';
import { RefreshCw, Globe, Loader2, AlertCircle, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { useAppleSpeechLocales } from '@/hooks/useAppleSpeechLocales';
import Analytics from '@/lib/analytics';

interface RetranscribeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  meetingFolderPath: string | null;
  onComplete?: () => void;
}

interface RetranscriptionProgress {
  meeting_id: string;
  stage: string;
  progress_percentage: number;
  message: string;
}

interface RetranscriptionResult {
  meeting_id: string;
  segments_count: number;
  duration_seconds: number;
  language: string | null;
}

interface RetranscriptionError {
  meeting_id: string;
  error: string;
}

export function RetranscribeDialog({
  open,
  onOpenChange,
  meetingId,
  meetingFolderPath,
  onComplete,
}: RetranscribeDialogProps) {
  const { transcriptModelConfig } = useConfig();
  const configuredLocale = transcriptModelConfig.model || 'en_US';
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<RetranscriptionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedLang, setSelectedLang] = useState(configuredLocale);
  const { locales, loadingLocales, fetchLocales } = useAppleSpeechLocales();

  // Stable refs for callbacks to avoid listener re-registration
  const onCompleteRef = useRef(onComplete);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);

  // Track previous open state to only reset on closed→open transition
  const prevOpenRef = useRef(false);

  // Reset state only when dialog transitions from closed to open
  // This prevents re-initialization when config changes while dialog is already open
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !wasOpen) {
      setIsProcessing(false);
      setProgress(null);
      setError(null);
      setSelectedLang(configuredLocale);
      fetchLocales();
    }
  }, [open, configuredLocale, fetchLocales]);

  // Listen for retranscription events
  useEffect(() => {
    if (!open) return;

    const unlisteners: UnlistenFn[] = [];
    const cleanedUpRef = { current: false };

    const setupListeners = async () => {
      // Progress events
      const unlistenProgress = await listen<RetranscriptionProgress>(
        'retranscription-progress',
        (event) => {
          if (event.payload.meeting_id === meetingId) {
            setProgress(event.payload);
          }
        }
      );
      if (cleanedUpRef.current) {
        unlistenProgress();
        return;
      }
      unlisteners.push(unlistenProgress);

      // Completion event
      const unlistenComplete = await listen<RetranscriptionResult>(
        'retranscription-complete',
        async (event) => {
          if (event.payload.meeting_id === meetingId) {
            await Analytics.track('enhance_transcript_completed', {
              success: 'true',
              duration_seconds: event.payload.duration_seconds.toString(),
              segments_count: event.payload.segments_count.toString()
            });

            setIsProcessing(false);
            toast.success(
              `Retranscription complete! ${event.payload.segments_count} segments created.`
            );
            onCompleteRef.current?.();
            onOpenChangeRef.current(false);
          }
        }
      );
      if (cleanedUpRef.current) {
        unlistenComplete();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenComplete);

      // Error event
      const unlistenError = await listen<RetranscriptionError>(
        'retranscription-error',
        async (event) => {
          if (event.payload.meeting_id === meetingId) {
            await Analytics.trackError('enhance_transcript_failed', event.payload.error);

            setIsProcessing(false);
            setError(event.payload.error);
          }
        }
      );
      if (cleanedUpRef.current) {
        unlistenError();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenError);
    };

    setupListeners();

    return () => {
      cleanedUpRef.current = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [open, meetingId]);

  const handleStartRetranscription = async () => {
    if (!meetingFolderPath) {
      setError('Meeting folder path not available');
      return;
    }

    setIsProcessing(true);
    setError(null);
    setProgress(null);

    try {
      await Analytics.track('enhance_transcript_started', {
        language: selectedLang,
        model_provider: 'appleSpeech',
        model_name: selectedLang
      });

      await invoke('start_retranscription_command', {
        meetingId,
        meetingFolderPath,
        language: selectedLang,
      });
    } catch (err: any) {
      setIsProcessing(false);
      const errorMsg = typeof err === 'string' ? err : (err?.message || String(err));
      setError(errorMsg);

      await Analytics.trackError('enhance_transcript_failed', errorMsg);
    }
  };

  const handleCancel = async () => {
    if (isProcessing) {
      try {
        await invoke('cancel_retranscription_command');
        setIsProcessing(false);
        setProgress(null);
        toast.info('Retranscription cancelled');
      } catch (err) {
        console.error('Failed to cancel retranscription:', err);
      }
    }
    onOpenChange(false);
  };

  // Prevent closing during processing
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && isProcessing) {
      return;
    }
    onOpenChange(newOpen);
  };

  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    if (isProcessing) {
      event.preventDefault();
    }
  };

  const handleInteractOutside = (event: Event) => {
    if (isProcessing) {
      event.preventDefault();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[450px]"
        onEscapeKeyDown={handleEscapeKeyDown}
        onInteractOutside={handleInteractOutside}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isProcessing ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                Retranscribing...
              </>
            ) : error ? (
              <>
                <AlertCircle className="h-5 w-5 text-red-600" />
                Retranscription Failed
              </>
            ) : (
              <>
                <RefreshCw className="h-5 w-5 text-blue-600" />
                Retranscribe Meeting
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {isProcessing
              ? progress?.message || 'Processing audio...'
              : error
                ? 'An error occurred during retranscription'
                : 'Re-process the audio with different language settings'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!isProcessing && !error && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Language</span>
              </div>
              <Select value={selectedLang} onValueChange={setSelectedLang} disabled={loadingLocales}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select language" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {!locales.some((locale) => locale.id === selectedLang) && (
                    <SelectItem value={selectedLang}>{selectedLang}</SelectItem>
                  )}
                  {locales.map((locale) => (
                    <SelectItem key={locale.id} value={locale.id}>
                      {locale.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Spoken language for Apple Speech. Add languages in Settings → Transcription.
              </p>
            </div>
          )}

          {isProcessing && progress && (
            <div className="space-y-2">
              <div className="relative">
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div
                    className="bg-blue-600 h-3 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(progress.progress_percentage, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-gray-600 mt-1">
                  <span>{progress.stage}</span>
                  <span>{Math.round(progress.progress_percentage)}%</span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground text-center">
                {progress.message}
              </p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {!isProcessing && !error && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleStartRetranscription}
                className="bg-blue-600 hover:bg-blue-700"
                disabled={!meetingFolderPath}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Start Retranscription
              </Button>
            </>
          )}
          {isProcessing && (
            <Button variant="outline" onClick={handleCancel}>
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
          )}
          {error && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  setError(null);
                  setProgress(null);
                }}
                variant="outline"
              >
                Try Again
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
