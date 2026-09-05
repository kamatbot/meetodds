'use client';

import { X } from 'lucide-react';
import { LiveTranscriptPreview } from '@/types';
import { LiveTranslationEntry, TranslationDisplayMode } from '@/lib/live-translation';

interface LiveTranscriptSubtitleProps {
  preview: LiveTranscriptPreview | null;
  translation?: LiveTranslationEntry;
  translationEnabled: boolean;
  translationDisplayMode: TranslationDisplayMode;
  translationTargetLanguage?: string;
  isPaused?: boolean;
  settled?: boolean;
  onDismiss: () => void;
}

export function LiveTranscriptSubtitle({
  preview,
  translation,
  translationEnabled,
  translationDisplayMode,
  translationTargetLanguage,
  isPaused = false,
  settled = false,
  onDismiss,
}: LiveTranscriptSubtitleProps) {
  const translated = translation?.translatedText?.trim();
  const showOriginal = !translationEnabled
    || translationDisplayMode === 'bilingual'
    || !translated;

  return (
    <div className="pointer-events-none sticky bottom-4 z-30 flex justify-center px-4 pb-4">
      <div
        className="pointer-events-auto w-fit max-w-[860px] rounded-2xl border border-white/10 bg-black/85 px-5 py-3 text-white shadow-2xl backdrop-blur-md"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-white/55">
          <span
            className={`h-1.5 w-1.5 rounded-full ${isPaused ? 'bg-amber-400' : 'bg-red-400 animate-pulse'}`}
          />
          <span>{preview?.speakerLabel ?? 'Live'}</span>
          <span>Live</span>
          {preview && !settled && (
            <span className="normal-case tracking-normal text-white/35">
              {preview.latencyMs < 1000 ? `${preview.latencyMs} ms` : `${(preview.latencyMs / 1000).toFixed(1)} s`}
            </span>
          )}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Hide live captions"
            className="ml-auto inline-grid h-6 w-6 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>

        {isPaused ? (
          <p className="text-lg font-medium leading-snug text-white/50 md:text-xl">Paused</p>
        ) : !preview ? (
          <p className="text-lg font-medium leading-snug text-white/50 md:text-xl">Listening…</p>
        ) : (
          <>
            {showOriginal && (
              <p className={`line-clamp-2 text-lg font-medium leading-snug md:text-xl ${settled ? 'text-white/60' : ''}`}>
                {preview.text}
                {!settled && <span className="ml-0.5 animate-pulse text-white/45">▍</span>}
              </p>
            )}

            {translationEnabled && translated && (
              <p
                lang={translationTargetLanguage}
                dir="auto"
                className={`${showOriginal ? 'mt-2 border-t border-white/10 pt-2' : ''} line-clamp-2 text-lg font-semibold leading-snug md:text-xl`}
              >
                {translated}
                {translation?.status === 'translating' && (
                  <span className="ml-0.5 animate-pulse text-white/45">▍</span>
                )}
              </p>
            )}

            {translationEnabled && !translated && (
              <div className="mt-1 text-xs text-white/40">Translating live caption…</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
