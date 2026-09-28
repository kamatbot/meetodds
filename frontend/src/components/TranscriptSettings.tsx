'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AppleSpeechSettings } from './AppleSpeechSettings';
import SettingRow from '@/components/Settings/SettingRow';
import { getAppleSpeechCapabilities, type AppleSpeechCapabilities } from '@/lib/apple-speech';
import { useRecordingState } from '@/contexts/RecordingStateContext';

export interface TranscriptModelProps {
  /** Apple Speech is the only engine; `model` holds its locale (e.g. en_US). */
  provider: 'appleSpeech';
  model: string;
  apiKey?: string | null;
}

export interface TranscriptSettingsProps {
  transcriptModelConfig: TranscriptModelProps;
  setTranscriptModelConfig: (config: TranscriptModelProps) => void;
  onModelSelect?: () => void;
}

const messageFromError = (error: unknown, fallback: string) => error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;

export function TranscriptSettings({
  transcriptModelConfig,
  setTranscriptModelConfig,
}: TranscriptSettingsProps) {
  const [appleSpeechCapabilities, setAppleSpeechCapabilities] = useState<AppleSpeechCapabilities | null>(null);
  const [appleSpeechError, setAppleSpeechError] = useState<string | null>(null);
  const [loadingAppleSpeech, setLoadingAppleSpeech] = useState(true);
  const [preparingAppleSpeech, setPreparingAppleSpeech] = useState(false);
  const [transcriptSaveError, setTranscriptSaveError] = useState<string | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveRequestRef = useRef(0);
  const latestConfigRef = useRef(transcriptModelConfig);
  const { isRecording } = useRecordingState();

  const loadAppleSpeechCapabilities = useCallback(async () => {
    setLoadingAppleSpeech(true);
    setAppleSpeechError(null);
    try {
      setAppleSpeechCapabilities(await getAppleSpeechCapabilities());
    } catch (error) {
      setAppleSpeechCapabilities(null);
      setAppleSpeechError(messageFromError(error, 'Apple Speech is unavailable on this Mac.'));
    } finally {
      setLoadingAppleSpeech(false);
    }
  }, []);

  useEffect(() => {
    void loadAppleSpeechCapabilities();
  }, [loadAppleSpeechCapabilities]);

  useEffect(() => {
    latestConfigRef.current = transcriptModelConfig;
  }, [transcriptModelConfig]);

  const saveTranscriptConfig = useCallback((config: TranscriptModelProps) => {
    const request = ++saveRequestRef.current;
    setTranscriptSaveError(null);
    const save = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await invoke('api_save_transcript_config', {
          provider: config.provider,
          model: config.model,
        });
      });
    saveQueueRef.current = save.catch(() => undefined);
    void save.catch((error) => {
      if (request === saveRequestRef.current) {
        setTranscriptSaveError(messageFromError(error, 'Could not save the transcription setting.'));
      }
    });
  }, []);

  const updateTranscriptConfig = useCallback((config: TranscriptModelProps) => {
    setTranscriptModelConfig(config);
    saveTranscriptConfig(config);
  }, [saveTranscriptConfig, setTranscriptModelConfig]);

  const handleApplePrepared = useCallback((resolvedLocale: string, requestedLocale: string) => {
    const current = latestConfigRef.current;
    const normalizeLocale = (value: string) => value.replace('_', '-').toLowerCase();
    if (normalizeLocale(current.model) !== normalizeLocale(requestedLocale)) return;
    updateTranscriptConfig({ ...current, model: resolvedLocale, apiKey: null });
    void loadAppleSpeechCapabilities();
  }, [loadAppleSpeechCapabilities, updateTranscriptConfig]);

  return (
    <div>
      {transcriptSaveError && <p role="alert" className="-mt-1 text-caption leading-5 text-danger">The selection is shown for this session but was not saved: {transcriptSaveError}</p>}

      <SettingRow
        label="Live transcription"
        description="Apple Speech transcribes on this Mac. Choose the spoken language used for recordings, imports and re-transcription."
        align="start"
        control={(
          <span className="max-w-[260px] truncate text-caption text-3">
            {transcriptModelConfig.model || 'Choose below'}
          </span>
        )}
      >
        <div className="rounded-card border border-border bg-surface p-4">
          <fieldset disabled={isRecording || preparingAppleSpeech} className="min-w-0 disabled:opacity-60">
            <AppleSpeechSettings
              locale={transcriptModelConfig.model || 'en_US'}
              capabilities={appleSpeechCapabilities}
              loadingCapabilities={loadingAppleSpeech}
              capabilityError={appleSpeechError}
              disabled={isRecording}
              preparing={preparingAppleSpeech}
              onRetryCapabilities={() => void loadAppleSpeechCapabilities()}
              onLocaleChange={(locale) => updateTranscriptConfig({ provider: 'appleSpeech', model: locale, apiKey: null })}
              onPreparedLocale={handleApplePrepared}
              onPreparingChange={setPreparingAppleSpeech}
            />
          </fieldset>
        </div>
      </SettingRow>
    </div>
  );
}
