'use client';

import React, { useEffect, useState } from 'react';
import { ArrowRight, Check, Cloud, Loader2, LockKeyhole, Sparkles } from 'lucide-react';
import { emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { OpenAICodexSettings } from '@/components/OpenAICodexSettings';
import { useConfig } from '@/contexts/ConfigContext';
import { useOnboarding } from '@/contexts/OnboardingContext';
import type { ModelConfig } from '@/services/configService';
import { getAppleIntelligenceStatus, type AppleIntelligenceStatus } from '@/lib/apple-intelligence';
import { commitSummaryDestination, firstAvailableChatGPTModel, readSummaryDestination, type PersistedSummaryConfiguration, type SummaryDestination } from '@/lib/onboarding-setup';
import { OnboardingContainer } from '../OnboardingContainer';

interface CodexAuthStatus {
  loggedIn: boolean;
}

interface CodexModel {
  id: string;
}

async function persistAndReadSummaryConfiguration(
  provider: 'apple-intelligence' | 'openai-codex',
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
    goNext,
  } = useOnboarding();
  const { toggleIsAutoSummary } = useConfig();
  const [isCodexConnected, setIsCodexConnected] = useState(false);
  const [availableChatGPTModels, setAvailableChatGPTModels] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [appleIntelligence, setAppleIntelligence] = useState<AppleIntelligenceStatus | null>(null);
  const [loadingAppleIntelligence, setLoadingAppleIntelligence] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingAppleIntelligence(true);
    void getAppleIntelligenceStatus().then((status) => {
      if (cancelled) return;
      setAppleIntelligence(status);
      setLoadingAppleIntelligence(false);
      // Never leave a fresh user stranded on a disabled default; an explicit
      // prior choice (saved to storage) is always left alone.
      if (!status.available && !readSummaryDestination(window.localStorage)) {
        selectSummaryDestination('chatgpt');
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const appleIntelligenceAvailable = appleIntelligence?.available === true;
  const chatGPTModel = firstAvailableChatGPTModel(availableChatGPTModels);

  const chooseDestination = (destination: SummaryDestination) => {
    if (destination === 'local' && !appleIntelligenceAvailable) return;
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
      if (summaryDestination === 'local' && !appleIntelligenceAvailable) {
        throw new Error('Apple Intelligence is not available on this Mac. Choose ChatGPT instead.');
      }

      let authenticated = false;
      let availableModels: string[] = [];
      let modelToCommit: string | undefined;
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

      await commitSummaryDestination({
        storage: window.localStorage,
        destination: summaryDestination,
        authenticated,
        availableModels,
        model: modelToCommit,
        persistAndReadConfiguration: persistAndReadSummaryConfiguration,
        setAutoSummary: toggleIsAutoSummary,
      });

      goNext();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setIsSaving(false);
    }
  };

  const isChatGPTReady = isCodexConnected && Boolean(chatGPTModel);
  const continueHint = summaryDestination === 'chatgpt' && !isChatGPTReady
    ? 'Sign in and confirm an available ChatGPT model to continue.'
    : summaryDestination === 'local' && !appleIntelligenceAvailable
    ? 'Apple Intelligence is unavailable on this Mac. Choose ChatGPT to continue.'
    : summaryDestination === 'chatgpt'
    ? 'Continuing confirms that ChatGPT may receive transcripts and meeting notes for summaries.'
    : 'Summaries stay on this Mac.';
  const footer = (
    <div className="space-y-2">
      {(selectionError || error) && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-caption text-danger">{selectionError || error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-caption text-2">{continueHint}</p>
        <Button
          type="button"
          onClick={() => void handleContinue()}
          disabled={isSaving || (summaryDestination === 'chatgpt' && !isChatGPTReady) || (summaryDestination === 'local' && !appleIntelligenceAvailable)}
          className="h-10 min-w-[168px] rounded-xl bg-text px-4 text-ui font-semibold text-surface hover:opacity-90"
        >
          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {isSaving
            ? 'Saving…'
            : summaryDestination === 'chatgpt'
            ? 'Continue with ChatGPT'
            : 'Continue'}
          {!isSaving && <ArrowRight className="ml-2 h-4 w-4" strokeWidth={1.8} />}
        </Button>
      </div>
    </div>
  );

  return (
    <OnboardingContainer
      title="Choose where summaries run"
      description="Recordings and transcription stay on your Mac. Pick where meeting summaries are created."
      step={1}
      totalSteps={3}
      className="max-w-[760px]"
      footer={footer}
    >
      <div className="mx-auto w-full max-w-[620px] space-y-2">
        <button
          type="button"
          onClick={() => chooseDestination('local')}
          aria-pressed={summaryDestination === 'local'}
          disabled={!appleIntelligenceAvailable}
          className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60 ${summaryDestination === 'local' ? 'border-text bg-bg' : 'border-border bg-surface hover:bg-bg'}`}
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-bg text-text">
            <Sparkles className="h-5 w-5" strokeWidth={1.7} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-ui font-semibold text-text">
              Apple Intelligence
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-2">On this Mac</span>
            </span>
            <span className="mt-1 block text-caption leading-5 text-2">
              Your audio, transcript, meeting notes and summaries stay on this Mac.
            </span>
            <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-2">
              <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
              {loadingAppleIntelligence
                ? 'Checking Apple Intelligence availability…'
                : appleIntelligenceAvailable
                ? 'Ready on this Mac'
                : appleIntelligence?.reason ?? 'Apple Intelligence status is unavailable'}
            </span>
          </span>
          <span className={`mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${summaryDestination === 'local' ? 'border-text bg-text text-white' : 'border-border text-transparent'}`} aria-hidden="true">
            {summaryDestination === 'local' && <Check className="h-3 w-3" strokeWidth={2.5} />}
          </span>
        </button>

        <button
          type="button"
          onClick={() => chooseDestination('chatgpt')}
          aria-pressed={summaryDestination === 'chatgpt'}
          className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${summaryDestination === 'chatgpt' ? 'border-text bg-bg' : 'border-border bg-surface hover:bg-bg'}`}
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
              <span className="mt-2 block text-caption text-2">Available model · <span className="font-medium text-text">{chatGPTModel}</span></span>
            )}
          </span>
          <span className={`mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${summaryDestination === 'chatgpt' ? 'border-text bg-text text-white' : 'border-border text-transparent'}`} aria-hidden="true">
            {summaryDestination === 'chatgpt' && <Check className="h-3 w-3" strokeWidth={2.5} />}
          </span>
        </button>

        {summaryDestination === 'chatgpt' && (
          <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
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

      </div>
    </OnboardingContainer>
  );
}
