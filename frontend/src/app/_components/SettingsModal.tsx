'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, X } from 'lucide-react';
import { TranscriptSettings } from '@/components/TranscriptSettings';
import { Switch } from '@/components/ui/switch';
import { useConfig } from '@/contexts/ConfigContext';

type ModalType =
  | 'modelSettings'
  | 'deviceSettings'
  | 'languageSettings'
  | 'modelSelector'
  | 'errorAlert'
  | 'chunkDropWarning';

interface SettingsModalsProps {
  modals: {
    modelSettings: boolean;
    deviceSettings: boolean;
    languageSettings: boolean;
    modelSelector: boolean;
    errorAlert: boolean;
    chunkDropWarning: boolean;
  };
  messages: {
    errorAlert: string;
    chunkDropWarning: string;
    modelSelector: string;
  };
  onClose: (name: ModalType) => void;
}

export function SettingsModals({ modals, messages, onClose }: SettingsModalsProps) {
  const router = useRouter();
  const {
    transcriptModelConfig,
    setTranscriptModelConfig,
    showConfidenceIndicator,
    toggleConfidenceIndicator,
  } = useConfig();

  // Settings now has one canonical surface. Legacy callers are preserved, but their
  // modal intent is translated into the corresponding deep-linked settings section.
  useEffect(() => {
    if (modals.modelSettings) {
      onClose('modelSettings');
      router.push('/settings?section=summary');
      return;
    }
    if (modals.deviceSettings) {
      onClose('deviceSettings');
      router.push('/settings?section=recording');
      return;
    }
    if (modals.languageSettings) {
      onClose('languageSettings');
      router.push('/settings?section=transcription');
    }
  }, [modals.deviceSettings, modals.languageSettings, modals.modelSettings, onClose, router]);

  return (
    <>
      {modals.modelSelector && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[88vh] w-full max-w-[760px] flex-col overflow-hidden rounded-popover border border-border bg-surface shadow-popover">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div>
                <h3 className="text-title text-text">
                  {messages.modelSelector ? 'Speech recognition setup required' : 'Transcription model'}
                </h3>
                {messages.modelSelector && (
                  <p className="mt-1 text-caption text-3">{messages.modelSelector}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onClose('modelSelector')}
                className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-control text-2 hover:bg-bg hover:text-text"
                aria-label="Close model setup"
              >
                <X className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 custom-scrollbar">
              <TranscriptSettings
                transcriptModelConfig={transcriptModelConfig}
                setTranscriptModelConfig={setTranscriptModelConfig}
                onModelSelect={() => onClose('modelSelector')}
              />
            </div>

            <div className="flex shrink-0 items-center justify-between gap-4 border-t border-border px-5 py-3">
              <div>
                <p className="text-ui font-medium text-text">Confidence indicators</p>
                <p className="mt-0.5 text-caption text-3">Show transcription-confidence signals beside transcript segments.</p>
              </div>
              <Switch
                checked={showConfidenceIndicator}
                onCheckedChange={toggleConfidenceIndicator}
              />
            </div>
          </div>
        </div>
      )}

      {modals.errorAlert && (
        <div className="fixed inset-x-0 top-[52px] z-50 flex justify-center px-4 pt-3 pointer-events-none">
          <div className="pointer-events-auto flex w-full max-w-[720px] items-start gap-3 rounded-card border border-danger/30 bg-surface px-4 py-3 shadow-popover">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <p className="text-ui font-semibold text-text">Recording stopped</p>
              <p className="mt-0.5 text-caption leading-5 text-2">{messages.errorAlert}</p>
            </div>
            <button
              type="button"
              onClick={() => onClose('errorAlert')}
              className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-control text-3 hover:bg-bg hover:text-text"
              aria-label="Dismiss recording error"
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      )}

      {modals.chunkDropWarning && (
        <div className="fixed inset-x-0 top-[52px] z-50 flex justify-center px-4 pt-3 pointer-events-none">
          <div className="pointer-events-auto flex w-full max-w-[720px] items-start gap-3 rounded-card border border-warn/30 bg-surface px-4 py-3 shadow-popover">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <p className="text-ui font-semibold text-text">Transcription performance warning</p>
              <p className="mt-0.5 text-caption leading-5 text-2">{messages.chunkDropWarning}</p>
            </div>
            <button
              type="button"
              onClick={() => onClose('chunkDropWarning')}
              className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-control text-3 hover:bg-bg hover:text-text"
              aria-label="Dismiss transcription warning"
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
