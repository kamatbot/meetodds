'use client';

import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ProgressIndicator } from './shared/ProgressIndicator';
import { useOnboarding } from '@/contexts/OnboardingContext';
import type { OnboardingContainerProps } from '@/types/onboarding';

export function OnboardingContainer({
  title,
  description,
  hero,
  children,
  step,
  totalSteps = 4,
  stepOffset = 0,
  hideProgress = false,
  className,
  showNavigation = false,
  onNext,
  onPrevious,
  canGoNext = true,
  canGoPrevious = true,
}: OnboardingContainerProps) {
  const { goToStep, goPrevious, goNext } = useOnboarding();

  const handlePrevious = () => {
    if (onPrevious) onPrevious();
    else goPrevious();
  };

  const handleNext = () => {
    if (onNext) onNext();
    else goNext();
  };

  const handleStepClick = (visibleStep: number) => {
    goToStep(visibleStep + stepOffset);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-bg text-text">
      <div className={cn('flex h-full max-h-screen w-full max-w-[720px] flex-col px-6 py-6 md:px-10 md:py-8', className)}>
        {step && !hideProgress && (
          <div className="relative mb-5 shrink-0">
            {showNavigation && (
              <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-between">
                <button
                  type="button"
                  onClick={handlePrevious}
                  disabled={!canGoPrevious || step === 1}
                  className={cn(
                    'pointer-events-auto inline-grid h-8 w-8 place-items-center rounded-full border border-border bg-surface text-2 shadow-sm transition-colors duration-150',
                    canGoPrevious && step !== 1
                      ? 'hover:bg-bg hover:text-text'
                      : 'pointer-events-none opacity-0',
                  )}
                  aria-label="Previous setup step"
                >
                  <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
                </button>

                <button
                  type="button"
                  onClick={handleNext}
                  disabled={!canGoNext || step === totalSteps}
                  className={cn(
                    'pointer-events-auto inline-grid h-8 w-8 place-items-center rounded-full border border-border bg-surface text-2 shadow-sm transition-colors duration-150',
                    canGoNext && step !== totalSteps
                      ? 'hover:bg-bg hover:text-text'
                      : 'pointer-events-none opacity-0',
                  )}
                  aria-label="Next setup step"
                >
                  <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </div>
            )}

            <ProgressIndicator current={step} total={totalSteps} onStepClick={handleStepClick} />
          </div>
        )}

        {/* hero === undefined -> default header; hero === null -> no header; otherwise render the given hero node */}
        {hero === undefined ? (
          <header className="mb-6 shrink-0 text-center">
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-accent" aria-hidden="true" />
            <h1 className="text-display text-text">{title}</h1>
            {description && (
              <p className="mx-auto mt-2 max-w-lg text-body leading-6 text-2">
                {description}
              </p>
            )}
          </header>
        ) : (
          hero
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1 custom-scrollbar">
          <div className="flex min-h-full flex-col pb-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
