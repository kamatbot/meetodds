'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Eye, EyeOff, Lock, Unlock } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ModelManager } from './WhisperModelManager';
import { ParakeetModelManager } from './ParakeetModelManager';
import SettingRow from '@/components/Settings/SettingRow';
import { DEFAULT_WHISPER_MODEL, DEFAULT_PARAKEET_MODEL } from '@/constants/modelDefaults';

export interface TranscriptModelProps {
  provider: 'localWhisper' | 'parakeet' | 'deepgram' | 'elevenLabs' | 'groq' | 'openai';
  model: string;
  apiKey?: string | null;
}

export interface TranscriptSettingsProps {
  transcriptModelConfig: TranscriptModelProps;
  setTranscriptModelConfig: (config: TranscriptModelProps) => void;
  onModelSelect?: () => void;
}

const selectClass = 'h-8 min-w-[220px] rounded-control border border-border bg-bg px-2.5 text-ui text-text outline-none focus:border-accent';

export function TranscriptSettings({
  transcriptModelConfig,
  setTranscriptModelConfig,
  onModelSelect,
}: TranscriptSettingsProps) {
  const [apiKey, setApiKey] = useState<string | null>(transcriptModelConfig.apiKey || null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [isApiKeyLocked, setIsApiKeyLocked] = useState(true);
  const [uiProvider, setUiProvider] = useState<TranscriptModelProps['provider']>(transcriptModelConfig.provider);

  useEffect(() => {
    setUiProvider(transcriptModelConfig.provider);
  }, [transcriptModelConfig.provider]);

  useEffect(() => {
    if (transcriptModelConfig.provider === 'localWhisper' || transcriptModelConfig.provider === 'parakeet') {
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

  const handleProviderChange = (provider: TranscriptModelProps['provider']) => {
    setUiProvider(provider);
    if (provider !== 'localWhisper' && provider !== 'parakeet') {
      void fetchApiKey(provider);
    }
    const defaultModel = provider === 'localWhisper'
      ? DEFAULT_WHISPER_MODEL
      : provider === 'parakeet'
        ? DEFAULT_PARAKEET_MODEL
        : '';
    setTranscriptModelConfig({
      ...transcriptModelConfig,
      provider,
      model: defaultModel,
    });
  };

  const handleWhisperModelSelect = (modelName: string) => {
    setTranscriptModelConfig({
      ...transcriptModelConfig,
      provider: 'localWhisper',
      model: modelName,
    });
    onModelSelect?.();
  };

  const handleParakeetModelSelect = (modelName: string) => {
    setTranscriptModelConfig({
      ...transcriptModelConfig,
      provider: 'parakeet',
      model: modelName,
    });
    onModelSelect?.();
  };

  const requiresApiKey = ['deepgram', 'elevenLabs', 'openai', 'groq'].includes(uiProvider);

  return (
    <div>
      <SettingRow
        label="Engine"
        description="Whisper prioritizes broader model choice and accuracy; Parakeet is optimized for real-time on-device transcription."
        control={(
          <select
            value={uiProvider}
            onChange={(event) => handleProviderChange(event.target.value as TranscriptModelProps['provider'])}
            className={selectClass}
          >
            <option value="localWhisper">Whisper · recommended (on-device)</option>
            <option value="parakeet">Parakeet · fast (on-device)</option>
          </select>
        )}
      />

      <SettingRow
        label="Model"
        description="Download, remove, and select the model used by the active transcription engine."
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
