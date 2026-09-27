'use client';

import React, { useState } from 'react';
import { ArrowRight, Check, Cloud, LaptopMinimal, Loader2, LockKeyhole } from 'lucide-react';
import { emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { OpenAICodexSettings } from '@/components/OpenAICodexSettings';
import { useConfig } from '@/contexts/ConfigContext';
import { useOnboarding } from '@/contexts/OnboardingContext';
import type { ModelConfig } from '@/services/configService';
import { getSummaryModelSizeLabel } from '@/lib/onboarding-summary-model';
import { commitSummaryDestination, firstAvailableChatGPTModel, type PersistedSummaryConfiguration, type SummaryDestination } from '@/lib/onboarding-setup';
import { OnboardingContainer } from '../OnboardingContainer';

interface CodexAuthStatus {
  loggedIn: boolean;
}

interface CodexModel {
  id: string;
}

async function persistAndReadSummaryConfiguration(
  provider: 'builtin-ai' | 'openai-codex',
  model: string,
): Promise<PersistedSummaryConfiguration> {
  const previous = await invoke<ModelConfig | null>('api_get_model_config');
  await invoke('api_save_model_config', {
    provider,
    model,
    whisperModel: previous?.whisperModel || 'large-v3',
    apiKey: null,
    ollamaEndpoint: null,
  });

  const saved = await invoke<ModelConfig>('api_get_model_config');
  if (saved.provider !== provider || saved.model !== model) {
    throw new Error('MeetOdds could not verify the saved summary provider and model.');
  }

  await emit('model-config-updated', saved);
  return {
    provider: saved.provider,
    model: saved.model,
    endpoint: saved.ollamaEndpoint,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Could not save this summary setup. Check your connection and try again.';
}

export function WelcomeStep() {
  const {
    summaryDestination,
    selectSummaryDestination,
    selectedSummaryModel,
    recommendedSummaryModel,
    summaryModelDownloaded,
    summaryModelProgress,
    summaryModelProgressInfo,
    startBackgroundDownloads,
    goNext,
  } = useOnboarding();
  const { toggleIsAutoSummary } = useConfig();
  const [isCodexConnected, setIsCodexConnected] = useState(false);
  const [availableChatGPTModels, setAvailableChatGPTModels] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const localModel = recommendedSummaryModel || selectedSummaryModel;
  const modelSize = localModel ? getSummaryModelSizeLabel(localModel) : '';
  const chatGPTModel = firstAvailableChatGPTModel(availableChatGPTModels);

  const chooseDestination = (destination: SummaryDestination) => {
    setError(null);
    setSelectionError(null);
    try {
      selectSummaryDestination(destination);
    } catch {
      setSelectionError('Your choice could not be saved on this device. Continue only if you can finish setup now.');
    }
  };

  const refreshChatGPTModels = async () => {
    try {
      const models = await invoke<CodexModel[]>('openai_codex_get_models');
      setAvailableChatGPTModels(models.map((model) => model.id));
    } catch {
      setAvailableChatGPTModels([]);
      setError('ChatGPT models could not be checked. Try again or reconnect your account.');
    }
  };

  const handleContinue = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setError(null);

    try {
      let authenticated = false;
      let availableModels: string[] = [];
      let modelToCommit = localModel;
      if (summaryDestination === 'chatgpt') {
        const auth = await invoke<CodexAuthStatus>('openai_codex_get_auth_status');
        authenticated = auth.loggedIn;
        if (!authenticated) throw new Error('ChatGPT sign-in is not complete. Sign in, then try again.');

        const models = await invoke<CodexModel[]>('openai_codex_get_models');
        availableModels = models.map((model) => model.id);
        if (!firstAvailableChatGPTModel(availableModels)) {
          throw new Error('ChatGPT has not reported an available summary model. Refresh the model list and retry.');
        }
        const savedConfig = await invoke<ModelConfig | null>('api_get_model_config');
        const savedModel = savedConfig?.provider === 'openai-codex'
          && availableModels.includes(savedConfig.model)
          ? savedConfig.model
          : firstAvailableChatGPTModel(availableModels);
        modelToCommit = savedModel ?? '';
        setAvailableChatGPTModels([modelToCommit, ...availableModels.filter((item) => item !== modelToCommit)]);
      }

      const committed = await commitSummaryDestination({
        storage: window.localStorage,
        destination: summaryDestination,
        authenticated,
        availableModels,
        model: modelToCommit,
        persistAndReadConfiguration: persistAndReadSummaryConfiguration,
        setAutoSummary: toggleIsAutoSummary,
      });

      if (summaryDestination === 'local' && !summaryModelDownloaded) {
        await startBackgroundDownloads({
          includeParakeet: false,
          includeSummary: true,
          summaryModel: committed.model,
        });
      }
      goNext();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setIsSaving(false);
    }
  };

  const isChatGPTReady = isCodexConnected && Boolean(chatGPTModel);

  return (
    <OnboardingContainer
      title="How would you like your summaries?"
      description="Recording and transcription stay on your Mac. Choose where each meeting summary is written."
      step={1}
      totalSteps={2}
      className="max-w-[760px]"
    >
      <div className="mx-auto w-full max-w-[620px] space-y-3">
        <button
          type="button"
          onClick={() => chooseDestination('local')}
          aria-pressed={summaryDestination === 'local'}
          className={`flex w-full items-start gap-4 rounded-2xl border p-5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${summaryDestination === 'local' ? 'border-text bg-bg' : 'border-border bg-surface hover:bg-bg'}`}
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-bg text-text">
            <LaptopMinimal className="h-5 w-5" strokeWidth={1.7} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-ui font-semibold text-text">
              Local AI
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-2">On this Mac</span>
            </span>
            <span className="mt-1 block text-caption leading-5 text-2">
              Your audio, transcript, meeting notes and summaries stay on this Mac. MeetOdds uses its recommended built-in model.
            </span>
            {summaryDestination === 'local' && (
              <span className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-2">
                <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
                {localModel
                  ? `Recommended model · ${localModel}${modelSize ? ` · ${modelSize}` : ''}`
                  : 'Checking the recommended local model…'}
                <span className="font-medium text-text">
                  {summaryModelDownloaded
                    ? 'Ready on this Mac'
                    : summaryModelProgressInfo.error
                    ? 'Download needs attention'
                    : summaryModelProgress > 0
                    ? `Downloading · ${Math.round(summaryModelProgress)}%`
                    : 'Not downloaded yet'}
                </span>
              </span>
            )}
          </span>
          <span className={`mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${summaryDestination === 'local' ? 'border-text bg-text text-white' : 'border-border text-transparent'}`} aria-hidden="true">
            {summaryDestination === 'local' && <Check className="h-3 w-3" strokeWidth={2.5} />}
          </span>
        </button>

        <button
          type="button"
          onClick={() => chooseDestination('chatgpt')}
          aria-pressed={summaryDestination === 'chatgpt'}
          className={`flex w-full items-start gap-4 rounded-2xl border p-5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${summaryDestination === 'chatgpt' ? 'border-text bg-bg' : 'border-border bg-surface hover:bg-bg'}`}
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-bg text-text">
            <Cloud className="h-5 w-5" strokeWidth={1.7} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-ui font-semibold text-text">ChatGPT</span>
            <span className="mt-1 block text-caption leading-5 text-2">
              After each meeting, MeetOdds sends the transcript and your meeting notes to ChatGPT for a summary. Audio stays on your Mac.
            </span>
            {summaryDestination === 'chatgpt' && chatGPTModel && (
              <span className="mt-3 block text-caption text-2">Available model · <span className="font-medium text-text">{chatGPTModel}</span></span>
            )}
          </span>
          <span className={`mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${summaryDestination === 'chatgpt' ? 'border-text bg-text text-white' : 'border-border text-transparent'}`} aria-hidden="true">
            {summaryDestination === 'chatgpt' && <Check className="h-3 w-3" strokeWidth={2.5} />}
          </span>
        </button>

        {summaryDestination === 'chatgpt' && (
          <div className="space-y-3 rounded-2xl border border-border bg-surface p-4">
            <OpenAICodexSettings
              onConnectionChange={setIsCodexConnected}
              onModelsChange={setAvailableChatGPTModels}
            />
            {isCodexConnected && !chatGPTModel && (
              <div className="flex flex-wrap items-center justify-between gap-3 text-caption text-2">
                <span>No available ChatGPT summary model has been confirmed.</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void refreshChatGPTModels()}>
                  Refresh model list
                </Button>
              </div>
            )}
          </div>
        )}

        {selectionError && <p role="alert" className="text-caption text-danger">{selectionError}</p>}
        {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-caption text-danger">{error}</p>}

        <div className="flex flex-wrap items-center justify-between gap-4 pt-3">
          <span className="text-caption text-2">1 of 2 · You can change this later</span>
          <Button
            type="button"
            onClick={() => void handleContinue()}
            disabled={isSaving || (summaryDestination === 'chatgpt' && !isChatGPTReady) || (summaryDestination === 'local' && !localModel)}
            className="h-11 min-w-[190px] rounded-xl bg-text px-5 text-ui font-semibold text-surface hover:opacity-90"
          >
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {isSaving
              ? 'Saving setup…'
              : summaryDestination === 'chatgpt'
              ? 'Connect & allow summaries'
              : 'Continue'}
            {!isSaving && <ArrowRight className="ml-2 h-4 w-4" strokeWidth={1.8} />}
          </Button>
        </div>
        {summaryDestination === 'chatgpt' && !isChatGPTReady && (
          <p className="text-right text-caption text-2">
            Sign in and confirm an available model before continuing.
          </p>
        )}
      </div>
    </OnboardingContainer>
  );
}
