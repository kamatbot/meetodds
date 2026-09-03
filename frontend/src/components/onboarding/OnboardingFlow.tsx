'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useOnboarding } from '@/contexts/OnboardingContext';
import {
  WelcomeStep,
  PermissionsStep,
  DownloadProgressStep,
  SetupOverviewStep,
} from './steps';

interface OnboardingFlowProps {
  onComplete: () => void;
}

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { currentStep, completeOnboarding } = useOnboarding();
  const [isMac, setIsMac] = useState<boolean | null>(null);
  const completingNonMacRef = useRef(false);

  useEffect(() => {
    const checkPlatform = async () => {
      try {
        const { platform } = await import('@tauri-apps/plugin-os');
        setIsMac(platform() === 'macos');
      } catch (error) {
        console.error('Failed to detect platform:', error);
        setIsMac(navigator.userAgent.includes('Mac'));
      }
    };
    void checkPlatform();
  }, []);

  // On non-macOS platforms there is no permission-specific fourth screen in the
  // current flow. Complete the existing native onboarding contract and enter Home
  // rather than leaving the user on a blank step.
  useEffect(() => {
    if (currentStep !== 4 || isMac !== false || completingNonMacRef.current) return;
    completingNonMacRef.current = true;
    void completeOnboarding()
      .then(onComplete)
      .catch((error) => {
        completingNonMacRef.current = false;
        console.error('Failed to complete onboarding:', error);
      });
  }, [completeOnboarding, currentStep, isMac, onComplete]);

  return (
    <div className="onboarding-flow">
      {currentStep === 1 && <WelcomeStep />}
      {currentStep === 2 && <SetupOverviewStep />}
      {currentStep === 3 && <DownloadProgressStep />}
      {currentStep === 4 && isMac === true && <PermissionsStep onComplete={onComplete} />}
      {currentStep === 4 && isMac === null && (
        <div className="fixed inset-0 grid place-items-center bg-bg text-ui text-3">
          Preparing permissions…
        </div>
      )}
    </div>
  );
}
