'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { ModelConfig, ModelSettingsModal } from '@/components/ModelSettingsModal';
import { SummaryLanguageSettings } from '@/components/SummaryLanguageSettings';
import SettingRow from '@/components/Settings/SettingRow';
import { Switch } from './ui/switch';
import { useConfig } from '@/contexts/ConfigContext';

interface SummaryModelSettingsProps {
  refetchTrigger?: number;
}

export function SummaryModelSettings({ refetchTrigger }: SummaryModelSettingsProps) {
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'ollama',
    model: 'llama3.2:latest',
    whisperModel: 'large-v3',
    apiKey: null,
    ollamaEndpoint: null,
  });
  const { isAutoSummary, toggleIsAutoSummary } = useConfig();

  const fetchModelConfig = useCallback(async () => {
    try {
      const data = await invoke('api_get_model_config') as any;
      if (data && data.provider !== null) {
        if (data.provider !== 'ollama' && data.provider !== 'builtin-ai' && !data.apiKey) {
          try {
            data.apiKey = await invoke('api_get_api_key', { provider: data.provider }) as string;
          } catch (error) {
            console.error('Failed to fetch API key:', error);
          }
        }
        if (data.provider === 'custom-openai') {
          try {
            const customConfig = await invoke('api_get_custom_openai_config') as any;
            if (customConfig) {
              data.customOpenAIDisplayName = customConfig.displayName || null;
              data.customOpenAIEndpoint = customConfig.endpoint || null;
              data.customOpenAIModel = customConfig.model || null;
              data.customOpenAIApiKey = customConfig.apiKey || null;
              data.maxTokens = customConfig.maxTokens || null;
              data.temperature = customConfig.temperature || null;
              data.topP = customConfig.topP || null;
              data.model = customConfig.model || data.model;
            }
          } catch (error) {
            console.error('Failed to fetch custom OpenAI config:', error);
          }
        }
        setModelConfig(data);
      }
    } catch (error) {
      console.error('Failed to fetch model config:', error);
      toast.error('Failed to load model settings');
    }
  }, []);

  useEffect(() => {
    void fetchModelConfig();
  }, [fetchModelConfig]);

  useEffect(() => {
    if (refetchTrigger !== undefined && refetchTrigger > 0) {
      void fetchModelConfig();
    }
  }, [fetchModelConfig, refetchTrigger]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      cleanup = await listen<ModelConfig>('model-config-updated', (event) => {
        setModelConfig(event.payload);
      });
    };
    void setupListener();
    return () => cleanup?.();
  }, []);

  const handleSaveModelConfig = async (config: ModelConfig) => {
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey,
        ollamaEndpoint: config.ollamaEndpoint,
      });
      setModelConfig(config);
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);
      toast.success('Model settings saved');
    } catch (error) {
      console.error('Error saving model config:', error);
      toast.error('Failed to save model settings');
    }
  };

  return (
    <div>
      <SettingRow
        label="Generate summary automatically"
        description="Start summary generation after a completed recording has been saved."
        control={<Switch checked={isAutoSummary} onCheckedChange={toggleIsAutoSummary} />}
      />

      <SummaryLanguageSettings />

      <SettingRow
        label="Summary model"
        description="Choose the provider, model, credentials, and advanced generation settings."
        align="start"
        control={(
          <span className="max-w-[260px] truncate text-caption text-3">
            {modelConfig.provider} · {modelConfig.model || 'No model selected'}
          </span>
        )}
      >
        <div className="mt-1 min-w-0 rounded-card border border-border bg-surface p-4">
          <ModelSettingsModal
            modelConfig={modelConfig}
            setModelConfig={setModelConfig}
            onSave={handleSaveModelConfig}
            skipInitialFetch={true}
          />
        </div>
      </SettingRow>
    </div>
  );
}
