'use client';

import React, { useEffect, useState } from 'react';
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
    {
      icon: Lock,
      title: 'Recordings and transcripts stay on your device',
    },
    {
      icon: Sparkles,
      title: 'Choose local or cloud AI for summaries and analysis',
    },
    {
      icon: Cpu,
      title: 'Use on-device transcription and work offline',
    },
  ];

  return (
    <OnboardingContainer
      title="Welcome to MeetOdds"
      description="Capture the conversation locally, then choose the intelligence layer that fits the meeting."
      step={1}
      totalSteps={4}
      hideProgress={false}
    >
      <div className="mx-auto max-w-[560px] space-y-6">
        <div className="overflow-hidden rounded-card border border-border bg-surface">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <div
                key={feature.title}
                className={`flex items-start gap-3 px-4 py-3 ${index < features.length - 1 ? 'border-b border-border' : ''}`}
              >
                <div className="mt-0.5 inline-grid h-7 w-7 shrink-0 place-items-center rounded-control bg-bg text-2">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </div>
                <p className="pt-1 text-ui leading-5 text-text">{feature.title}</p>
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
              className={`rounded-card border p-4 text-left transition-colors duration-150 ${focusPreference === 'notes' ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-bg'}`}
            >
              <FileText className={`h-5 w-5 ${focusPreference === 'notes' ? 'text-accent' : 'text-2'}`} strokeWidth={1.75} />
              <div className="mt-3 text-ui font-semibold text-text">I take notes while I talk</div>
              <p className="mt-1 text-caption leading-5 text-3">Keep the live transcript available, but start with a quieter note-taking workspace.</p>
            </button>

            <button
              type="button"
              onClick={() => chooseFocus('transcript')}
              aria-pressed={focusPreference === 'transcript'}
              className={`rounded-card border p-4 text-left transition-colors duration-150 ${focusPreference === 'transcript' ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-bg'}`}
            >
              <MessageSquareText className={`h-5 w-5 ${focusPreference === 'transcript' ? 'text-accent' : 'text-2'}`} strokeWidth={1.75} />
              <div className="mt-3 text-ui font-semibold text-text">I just want the transcript</div>
              <p className="mt-1 text-caption leading-5 text-3">Open the live transcript drawer automatically while recording.</p>
            </button>
          </div>
        </section>

        <div className="mx-auto max-w-xs pt-1">
          <Button
            onClick={goNext}
            className="h-10 w-full rounded-control bg-accent text-white hover:opacity-90"
          >
            Get started
          </Button>
          <p className="mt-2 text-center text-caption text-3">Four short setup steps</p>
        </div>
      </div>
    </OnboardingContainer>
  );
}
