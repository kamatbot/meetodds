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
  totalSteps = 3,
  stepOffset = 0,
  hideProgress = false,
  className,
  showNavigation = false,
  onNext,
  onPrevious,
  canGoNext = true,
  canGoPrevious = true,
  footer,
}: OnboardingContainerProps & { footer?: React.ReactNode }) {
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-bg text-text"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif' }}
    >
      <div className={cn('flex h-full max-h-screen w-full max-w-[720px] flex-col px-4 py-4 sm:px-6 sm:py-5 md:px-8 md:py-6', className)}>
        {step && !hideProgress && (
          <div className="relative mb-3 shrink-0">
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
          <header className="mb-4 shrink-0 text-center">
            <div className="mx-auto mb-2 h-1 w-8 rounded-full bg-accent" aria-hidden="true" />
            <h1 className="text-xl font-semibold tracking-tight text-text sm:text-2xl">{title}</h1>
            {description && (
              <p className="mx-auto mt-1 max-w-lg text-ui leading-5 text-2">
                {description}
              </p>
            )}
          </header>
        ) : (
          hero
        )}

        <div
          className="min-h-0 flex-1 overflow-y-scroll pr-2 custom-scrollbar [scrollbar-gutter:stable] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-surface [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-text-3"
          style={{ scrollbarColor: 'var(--text-3) var(--surface)' }}
        >
          <div className="flex min-h-full flex-col pb-3">{children}</div>
        </div>
        {footer && <div className="shrink-0 border-t border-border pt-3">{footer}</div>}
      </div>
    </div>
  );
}
