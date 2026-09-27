'use client';

import React from 'react';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { WelcomeStep, PermissionsStep } from './steps';

interface OnboardingFlowProps {
  onComplete: () => void;
}

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { currentStep } = useOnboarding();

  return (
    <div className="onboarding-flow">
      {currentStep === 1 && <WelcomeStep />}
      {currentStep === 2 && <PermissionsStep onComplete={onComplete} />}
    </div>
  );
}
