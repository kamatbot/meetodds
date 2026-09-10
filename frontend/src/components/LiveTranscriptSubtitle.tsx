'use client';

import { X } from 'lucide-react';
import type { LiveTranscriptPreview } from '@/types';
import type { LiveTranslationEntry, TranslationDisplayMode } from '@/lib/live-translation';
import { getLiveTranslationLanguage } from '@/lib/live-translation';
import { resolveCaptionContent } from '@/lib/live-captions';

interface LiveTranscriptSubtitleProps {
  preview: LiveTranscriptPreview | null;
  translation?: LiveTranslationEntry;
  translationEnabled: boolean;
  /** Document preference only. Captions show the target language whenever translation is enabled. */
  translationDisplayMode: TranslationDisplayMode;
  translationTargetLanguage?: string;
  isPaused?: boolean;
  settled?: boolean;
  onDismiss: () => void;
}

/** Retained for secondary/legacy transcript surfaces. The live workspace uses the native caption window. */
export function LiveTranscriptSubtitle(props: LiveTranscriptSubtitleProps) {
  const caption = resolveCaptionContent({ ...props, targetLanguage: props.translationTargetLanguage });
  const language = getLiveTranslationLanguage(caption.language)?.name || caption.language;
  const placeholder = caption.phase === 'paused' ? 'Paused'
    : caption.phase === 'error' ? 'Translation unavailable. Check translation settings.'
    : caption.phase === 'translating' ? `Translating to ${language}…` : 'Listening…';
  return (
    <section className="mx-4 mb-4 shrink-0 rounded-2xl border border-white/10 bg-slate-950/85 px-5 py-3 text-white" aria-label="Live captions">
      <header className="mb-2 flex items-center justify-between gap-2 text-xs text-white/75">
        <span>{caption.speaker} · {caption.translated ? language : 'Original'}</span>
        <button type="button" onClick={props.onDismiss} aria-label="Hide live captions" className="rounded-md p-1 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"><X className="h-4 w-4" /></button>
      </header>
      <div className="max-h-40 overflow-y-auto">
        <p lang={caption.text ? caption.language : 'en'} dir="auto" className="whitespace-pre-wrap break-words text-lg font-medium leading-relaxed">{caption.text || placeholder}</p>
      </div>
    </section>
  );
}
