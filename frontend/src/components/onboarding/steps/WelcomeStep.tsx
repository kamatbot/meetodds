'use client';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import { Cpu, FileText, Lock, MessageSquareText, Sparkles } from 'lucide-react';
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

  const features = [
    { icon: Lock, title: 'Recordings stay on your device' },
    { icon: Sparkles, title: 'Local or cloud AI summaries' },
    { icon: Cpu, title: 'Offline, on-device transcription' },
  ];

  return (
    <OnboardingContainer
      title="Welcome to MeetOdds"
      step={1}
      totalSteps={4}
      hideProgress
      hero={null}
    >
      <div className="mx-auto flex w-full max-w-[600px] flex-1 flex-col justify-center gap-5">
        <header className="relative mb-1 shrink-0">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -top-24 h-72 bg-[radial-gradient(60%_60%_at_50%_0%,rgba(91,63,217,0.22),transparent_70%)]"
          />
          <div className="relative flex items-center justify-center gap-4">
            <Image
              src="/meetodds-icon.png"
              alt=""
              width={64}
              height={64}
              priority
              className="h-16 w-16 rounded-[18px] shadow-[0_10px_28px_rgba(59,110,246,0.28)]"
            />
            <div className="text-left">
              <h1 className="text-[28px] font-semibold leading-8 tracking-tight text-text">MeetOdds</h1>
              <p className="mt-0.5 text-body text-2">Private meeting notes, transcripts, and summaries on your Mac.</p>
            </div>
          </div>
          <p className="relative mx-auto mt-4 max-w-md text-center text-ui leading-5 text-3">
            Capture the conversation locally, then choose the intelligence layer that fits the meeting.
          </p>
        </header>

        <div className="grid grid-cols-3 gap-2">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div key={feature.title} className="flex items-center gap-2.5 rounded-card border border-border bg-surface px-3 py-2.5">
                <div className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-control bg-accent-soft text-accent">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </div>
                <p className="text-ui leading-4 text-text">{feature.title}</p>
              </div>
            );
          })}
        </div>

        <section aria-labelledby="meeting-style-title">
          <h2 id="meeting-style-title" className="text-ui font-semibold text-2">
            When a meeting starts, what should be in front of you?
          </h2>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => chooseFocus('notes')}
              aria-pressed={focusPreference === 'notes'}
              className={`rounded-card border p-3 text-left transition-colors duration-150 ${focusPreference === 'notes' ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-bg'}`}
            >
              <div className="flex items-center gap-2">
                <FileText className={`h-5 w-5 ${focusPreference === 'notes' ? 'text-accent' : 'text-2'}`} strokeWidth={1.75} />
                <span className="text-ui font-semibold text-text">I take notes while I talk</span>
              </div>
              <p className="mt-1 text-caption leading-4 text-3">Keep the live transcript available, but start with a quieter note-taking workspace.</p>
            </button>

            <button
              type="button"
              onClick={() => chooseFocus('transcript')}
              aria-pressed={focusPreference === 'transcript'}
              className={`rounded-card border p-3 text-left transition-colors duration-150 ${focusPreference === 'transcript' ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-bg'}`}
            >
              <div className="flex items-center gap-2">
                <MessageSquareText className={`h-5 w-5 ${focusPreference === 'transcript' ? 'text-accent' : 'text-2'}`} strokeWidth={1.75} />
                <span className="text-ui font-semibold text-text">I just want the transcript</span>
              </div>
              <p className="mt-1 text-caption leading-4 text-3">Open the live transcript drawer automatically while recording.</p>
            </button>
          </div>
        </section>

        <div className="mx-auto w-full max-w-xs">
          <Button onClick={goNext} className="h-10 w-full rounded-control bg-accent text-white hover:opacity-90">
            Get started
          </Button>
          <p className="mt-2 text-center text-caption text-3">Step 1 of 4 · about two minutes</p>
        </div>
      </div>
    </OnboardingContainer>
  );
}
