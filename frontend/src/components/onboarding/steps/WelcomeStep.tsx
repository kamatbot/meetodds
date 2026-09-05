'use client';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import { ArrowRight, Check, FileText, Lock, MessageSquareText, Sparkles, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';

const NEW_MEETING_FOCUS_KEY = 'meetodds.newMeetingFocus';
const TRANSCRIPT_DRAWER_VISIBLE_KEY = 'meetodds.meeting.transcriptDrawer.visible';

type NewMeetingFocus = 'notes' | 'transcript';

export function WelcomeStep() {
  const { goNext } = useOnboarding();
  const [focusPreference, setFocusPreference] = useState<NewMeetingFocus>('notes');

  useEffect(() => {
    const stored = window.localStorage.getItem(NEW_MEETING_FOCUS_KEY);
    if (stored === 'transcript' || stored === 'notes') {
      setFocusPreference(stored);
    }
  }, []);

  const chooseFocus = (preference: NewMeetingFocus) => {
    setFocusPreference(preference);
    window.localStorage.setItem(NEW_MEETING_FOCUS_KEY, preference);
    // Until the recorder has a canonical SQLite meeting route at start, this preference
    // maps directly to whether the live transcript drawer begins visible. The value is
    // stored separately so the future live Notes screen can adopt it without migration.
    window.localStorage.setItem(
      TRANSCRIPT_DRAWER_VISIBLE_KEY,
      String(preference === 'transcript'),
    );
  };

  const highlights = [
    { icon: Lock, label: 'Stays on your device' },
    { icon: Sparkles, label: 'Local or cloud AI' },
    { icon: WifiOff, label: 'Works offline' },
  ];

  return (
    <OnboardingContainer title="Welcome to MeetOdds" step={1} totalSteps={4} hideProgress hero={null}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[460px] overflow-hidden"
      >
        <div className="absolute left-1/2 top-[-160px] h-[440px] w-[760px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(91,63,217,0.18),rgba(59,110,246,0.08)_55%,transparent_78%)] blur-2xl" />
      </div>

      <div className="relative mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center">
        <div className="flex flex-col items-center text-center animate-fade-in-up motion-reduce:animate-none">
          <div className="relative mb-5">
            <Image
              src="/meetodds-icon.png"
              alt=""
              width={80}
              height={80}
              priority
              className="h-20 w-20 rounded-[22px] shadow-[0_18px_40px_-12px_rgba(59,110,246,0.45)] animate-float motion-reduce:animate-none"
            />
            <span className="absolute -right-3 -top-2 inline-flex items-center rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-semibold text-2 shadow-sm">
              Private
            </span>
          </div>
          <h1 className="text-[34px] font-semibold leading-[40px] tracking-[-0.02em] text-text">
            Meeting notes, done for you.
          </h1>
          <p className="mt-3 max-w-[460px] text-[15px] leading-6 text-2">
            MeetOdds records on your Mac, transcribes on-device, and turns the conversation into notes you can share. Nothing leaves your computer unless you say so.
          </p>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2 animate-fade-in-up delay-75 motion-reduce:animate-none">
          {highlights.map((item) => {
            const Icon = item.icon;
            return (
              <span
                key={item.label}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-caption font-medium text-2 shadow-sm"
              >
                <Icon className="h-3.5 w-3.5 text-accent" strokeWidth={2} />
                {item.label}
              </span>
            );
          })}
        </div>

        <section aria-labelledby="meeting-style-title" className="mt-7 animate-fade-in-up delay-100 motion-reduce:animate-none">
          <h2 id="meeting-style-title" className="text-center text-ui font-medium text-3">
            When a meeting starts, what should be in front of you?
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {(
              [
                {
                  key: 'notes' as const,
                  icon: FileText,
                  title: 'I take notes while I talk',
                  body: 'Keep the live transcript available, but start with a quieter note-taking workspace.',
                },
                {
                  key: 'transcript' as const,
                  icon: MessageSquareText,
                  title: 'I just want the transcript',
                  body: 'Open the live transcript drawer automatically while recording.',
                },
              ]
            ).map((option) => {
              const Icon = option.icon;
              const selected = focusPreference === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => chooseFocus(option.key)}
                  aria-pressed={selected}
                  className={`group relative rounded-2xl border p-4 text-left transition-all duration-200 ${
                    selected
                      ? 'border-accent bg-accent-soft shadow-[0_0_0_3px_rgba(59,110,246,0.14)]'
                      : 'border-border bg-surface hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-16px_rgba(27,27,27,0.28)]'
                  }`}
                >
                  <span
                    className={`inline-grid h-9 w-9 place-items-center rounded-xl transition-colors duration-200 ${
                      selected ? 'bg-accent text-white' : 'bg-bg text-2 group-hover:text-text'
                    }`}
                  >
                    <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                  </span>
                  {selected && (
                    <span className="absolute right-3 top-3 inline-grid h-5 w-5 place-items-center rounded-full bg-accent text-white">
                      <Check className="h-3 w-3" strokeWidth={2.5} />
                    </span>
                  )}
                  <div className="mt-3 text-[15px] font-semibold leading-5 text-text">{option.title}</div>
                  <p className="mt-1 text-caption leading-4 text-3">{option.body}</p>
                </button>
              );
            })}
          </div>
        </section>

        <div className="mt-7 flex flex-col items-center animate-fade-in-up delay-150 motion-reduce:animate-none">
          <Button
            onClick={goNext}
            className="h-11 w-full max-w-[300px] rounded-xl bg-accent text-[15px] font-semibold text-white shadow-[0_10px_24px_-10px_rgba(59,110,246,0.65)] transition-all duration-200 hover:-translate-y-0.5 hover:opacity-95 active:translate-y-0"
          >
            Get started
            <ArrowRight className="ml-1.5 h-4 w-4" strokeWidth={2} />
          </Button>
          <p className="mt-3 text-caption text-3">Step 1 of 4 · about two minutes · no account needed</p>
        </div>
      </div>
    </OnboardingContainer>
  );
}
