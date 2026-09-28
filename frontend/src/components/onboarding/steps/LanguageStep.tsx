'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppleSpeechSettings } from '@/components/AppleSpeechSettings';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { getAppleSpeechCapabilities, type AppleSpeechCapabilities } from '@/lib/apple-speech';
import { defaultAppleSpeechLocale } from '@/lib/onboarding-setup';
import { OnboardingContainer } from '../OnboardingContainer';

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
}

export function LanguageStep() {
  const { selectedLanguage, setSelectedLanguage, goNext, goPrevious } = useOnboarding();
  const [capabilities, setCapabilities] = useState<AppleSpeechCapabilities | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(true);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);

  const loadCapabilities = useCallback(async () => {
    setLoadingCapabilities(true);
    setCapabilityError(null);
    try {
      const result = await getAppleSpeechCapabilities();
      setCapabilities(result);
      setSelectedLanguage((current) => current || defaultAppleSpeechLocale(navigator.language, result.locales));
    } catch (error) {
      setCapabilities(null);
      setCapabilityError(messageFromError(error, 'Apple Speech is unavailable on this Mac.'));
    } finally {
      setLoadingCapabilities(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Capabilities load once on mount (and on explicit retry); this never triggers a download.
  useEffect(() => {
    void loadCapabilities();
  }, [loadCapabilities]);

  return (
    <OnboardingContainer
      title="What language do you speak?"
      description="Live transcription runs on this Mac with Apple Speech. Choose the language you'll speak in meetings."
      step={2}
      totalSteps={3}
      className="max-w-[760px]"
    >
      <div className="mx-auto w-full max-w-[620px] space-y-5">
        <div className="rounded-2xl border border-border bg-surface p-4">
          <AppleSpeechSettings
            locale={selectedLanguage || 'en-US'}
            capabilities={capabilities}
            loadingCapabilities={loadingCapabilities}
            capabilityError={capabilityError}
            disabled={false}
            preparing={preparing}
            onLocaleChange={setSelectedLanguage}
            onRetryCapabilities={() => void loadCapabilities()}
            onPreparedLocale={(resolvedLocale) => setSelectedLanguage(resolvedLocale)}
            onPreparingChange={setPreparing}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <Button type="button" variant="ghost" onClick={goPrevious} disabled={preparing} className="text-2">
            <ArrowLeft className="mr-2 h-4 w-4" /> Back
          </Button>
          <span className="text-caption text-2">2 of 3 · You can change this later in Settings</span>
          <Button
            type="button"
            onClick={goNext}
            disabled={!selectedLanguage || preparing}
            className="h-11 min-w-[170px] rounded-xl bg-text px-5 text-ui font-semibold text-surface hover:opacity-90"
          >
            {preparing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Continue
            {!preparing && <ArrowRight className="ml-2 h-4 w-4" strokeWidth={1.8} />}
          </Button>
        </div>
      </div>
    </OnboardingContainer>
  );
}
