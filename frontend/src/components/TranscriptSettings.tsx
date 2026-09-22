'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Eye, EyeOff, Lock, Unlock } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ModelManager } from './WhisperModelManager';
import { ParakeetModelManager } from './ParakeetModelManager';
import { AppleSpeechSettings } from './AppleSpeechSettings';
import SettingRow from '@/components/Settings/SettingRow';
import { DEFAULT_WHISPER_MODEL, DEFAULT_PARAKEET_MODEL } from '@/constants/modelDefaults';
import { getAppleSpeechCapabilities, type AppleSpeechCapabilities } from '@/lib/apple-speech';
import { useRecordingState } from '@/contexts/RecordingStateContext';

export interface TranscriptModelProps {
  provider: 'localWhisper' | 'parakeet' | 'appleSpeech' | 'deepgram' | 'elevenLabs' | 'groq' | 'openai';
  model: string;
  apiKey?: string | null;
}

export interface TranscriptSettingsProps {
  transcriptModelConfig: TranscriptModelProps;
  setTranscriptModelConfig: (config: TranscriptModelProps) => void;
  onModelSelect?: () => void;
}

const selectClass = 'h-8 min-w-[220px] rounded-control border border-border bg-bg px-2.5 text-ui text-text outline-none focus:border-accent';
const messageFromError = (error: unknown, fallback: string) => error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;

export function TranscriptSettings({
  transcriptModelConfig,
  setTranscriptModelConfig,
  onModelSelect,
}: TranscriptSettingsProps) {
  const [apiKey, setApiKey] = useState<string | null>(transcriptModelConfig.apiKey || null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [isApiKeyLocked, setIsApiKeyLocked] = useState(true);
  const [uiProvider, setUiProvider] = useState<TranscriptModelProps['provider']>(transcriptModelConfig.provider);
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
    setUiProvider(transcriptModelConfig.provider);
  }, [transcriptModelConfig.provider]);

  useEffect(() => {
    latestConfigRef.current = transcriptModelConfig;
  }, [transcriptModelConfig]);

  useEffect(() => {
    if (transcriptModelConfig.provider === 'localWhisper' || transcriptModelConfig.provider === 'parakeet' || transcriptModelConfig.provider === 'appleSpeech') {
      setApiKey(null);
    }
  }, [transcriptModelConfig.provider]);

  const fetchApiKey = async (provider: string) => {
    try {
      const data = await invoke<string>('api_get_transcript_api_key', { provider });
      setApiKey(data || '');
    } catch (error) {
      console.error('Error fetching transcript API key:', error);
      setApiKey(null);
    }
  };

  const saveTranscriptConfig = useCallback((config: TranscriptModelProps) => {
    const request = ++saveRequestRef.current;
    setTranscriptSaveError(null);
    const save = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await invoke('api_save_transcript_config', {
          provider: config.provider,
          model: config.model,
          apiKey: config.apiKey ?? null,
        });
      });
    saveQueueRef.current = save.catch(() => undefined);
    void save.catch((error) => {
      if (request === saveRequestRef.current) {
        setTranscriptSaveError(messageFromError(error, 'Could not save the transcription setting.'));
      }
    });
  }, []);

  const updateTranscriptConfig = useCallback((config: TranscriptModelProps, persist = false) => {
    setTranscriptModelConfig(config);
    if (persist) saveTranscriptConfig(config);
  }, [saveTranscriptConfig, setTranscriptModelConfig]);

  const handleProviderChange = (provider: TranscriptModelProps['provider']) => {
    if (isRecording || preparingAppleSpeech || (provider === 'appleSpeech' && (loadingAppleSpeech || appleSpeechCapabilities?.available === false))) return;
    setUiProvider(provider);
    if (provider !== 'localWhisper' && provider !== 'parakeet' && provider !== 'appleSpeech') {
      void fetchApiKey(provider);
    }
    const defaultModel = provider === 'localWhisper'
      ? DEFAULT_WHISPER_MODEL
      : provider === 'parakeet'
        ? DEFAULT_PARAKEET_MODEL
        : provider === 'appleSpeech'
          ? 'en-US'
          : '';
    updateTranscriptConfig({
      ...transcriptModelConfig,
      provider,
      model: defaultModel,
      apiKey: provider === 'localWhisper' || provider === 'parakeet' || provider === 'appleSpeech' ? null : transcriptModelConfig.apiKey,
    }, true);
  };

  const handleWhisperModelSelect = (modelName: string) => {
    updateTranscriptConfig({
      ...transcriptModelConfig,
      provider: 'localWhisper',
      model: modelName,
    });
    onModelSelect?.();
  };

  const handleParakeetModelSelect = (modelName: string) => {
    updateTranscriptConfig({
      ...transcriptModelConfig,
      provider: 'parakeet',
      model: modelName,
    });
    onModelSelect?.();
  };

  const requiresApiKey = ['deepgram', 'elevenLabs', 'openai', 'groq'].includes(uiProvider);
  const appleSpeechUnavailable = appleSpeechCapabilities?.available === false || appleSpeechError != null;
  const appleSpeechReason = appleSpeechError ?? appleSpeechCapabilities?.reason;
  const engineDescription = appleSpeechUnavailable
    ? `Whisper and Parakeet support imports and re-transcription. Apple Speech is unavailable: ${appleSpeechReason ?? 'This Mac does not support it.'}`
    : 'Whisper and Parakeet support imports and re-transcription. Apple Speech is an on-device option for live recordings.';

  const handleApplePrepared = useCallback((resolvedLocale: string, requestedLocale: string) => {
    const current = latestConfigRef.current;
    const normalizeLocale = (value: string) => value.replace('_', '-').toLowerCase();
    if (current.provider !== 'appleSpeech' || normalizeLocale(current.model) !== normalizeLocale(requestedLocale)) return;
    updateTranscriptConfig({ ...current, model: resolvedLocale, apiKey: null }, true);
    void loadAppleSpeechCapabilities();
  }, [loadAppleSpeechCapabilities, updateTranscriptConfig]);

  return (
    <div>
      <SettingRow
        label="Engine"
        description={engineDescription}
        control={(
          <select
            value={uiProvider}
            aria-label="Transcription engine"
            onChange={(event) => handleProviderChange(event.target.value as TranscriptModelProps['provider'])}
            className={selectClass}
            disabled={isRecording || preparingAppleSpeech}
          >
            <option value="localWhisper">Whisper · recommended (on-device)</option>
            <option value="parakeet">Parakeet · fast (on-device)</option>
            <option value="appleSpeech" disabled={loadingAppleSpeech || appleSpeechUnavailable}>Apple Speech (on-device){loadingAppleSpeech ? ' · checking availability' : appleSpeechUnavailable ? ' · unavailable' : ''}</option>
          </select>
        )}
      />

      {transcriptSaveError && <p role="alert" className="-mt-1 text-caption leading-5 text-danger">The selection is shown for this session but was not saved: {transcriptSaveError}</p>}

      <SettingRow
        label={uiProvider === 'appleSpeech' ? 'Live transcription' : 'Model'}
        description={uiProvider === 'appleSpeech' ? 'Configure the language used by Apple Speech during live recordings.' : 'Download, remove, and select the model used by the active transcription engine.'}
        align="start"
        control={(
          <span className="max-w-[260px] truncate text-caption text-3">
            {transcriptModelConfig.provider === uiProvider && transcriptModelConfig.model
              ? transcriptModelConfig.model
              : 'Choose below'}
          </span>
        )}
      >
        <div className="rounded-card border border-border bg-surface p-4">
          <fieldset disabled={isRecording || preparingAppleSpeech} className="min-w-0 disabled:opacity-60">
          {uiProvider === 'localWhisper' && (
            <ModelManager
              selectedModel={transcriptModelConfig.provider === 'localWhisper' ? transcriptModelConfig.model : undefined}
              onModelSelect={handleWhisperModelSelect}
              autoSave={true}
            />
          )}
          {uiProvider === 'parakeet' && (
            <ParakeetModelManager
              selectedModel={transcriptModelConfig.provider === 'parakeet' ? transcriptModelConfig.model : undefined}
              onModelSelect={handleParakeetModelSelect}
              autoSave={true}
            />
          )}
          {uiProvider === 'appleSpeech' && (
            <AppleSpeechSettings
              locale={transcriptModelConfig.provider === 'appleSpeech' ? transcriptModelConfig.model || 'en-US' : 'en-US'}
              capabilities={appleSpeechCapabilities}
              loadingCapabilities={loadingAppleSpeech}
              capabilityError={appleSpeechError}
              disabled={isRecording}
              preparing={preparingAppleSpeech}
              onRetryCapabilities={() => void loadAppleSpeechCapabilities()}
              onLocaleChange={(locale) => updateTranscriptConfig({ ...transcriptModelConfig, provider: 'appleSpeech', model: locale, apiKey: null }, true)}
              onPreparedLocale={handleApplePrepared}
              onPreparingChange={setPreparingAppleSpeech}
            />
          )}
          </fieldset>
        </div>
      </SettingRow>

      {requiresApiKey && (
        <SettingRow
          label="API key"
          description="Credential for the selected cloud transcription provider."
          control={(
            <div className="relative w-full min-w-[240px]">
              <Input
                type={showApiKey ? 'text' : 'password'}
                className={`h-8 bg-bg pr-20 text-ui ${isApiKeyLocked ? 'opacity-60' : ''}`}
                value={apiKey || ''}
                onChange={(event) => setApiKey(event.target.value)}
                disabled={isApiKeyLocked}
                placeholder="Enter API key"
              />
              <div className="absolute inset-y-0 right-0 flex items-center pr-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsApiKeyLocked((locked) => !locked)}
                  className="h-7 w-7"
                  title={isApiKeyLocked ? 'Unlock to edit' : 'Lock API key'}
                >
                  {isApiKeyLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowApiKey((show) => !show)}
                  className="h-7 w-7"
                >
                  {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          )}
        />
      )}
    </div>
  );
}
