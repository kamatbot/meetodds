'use client';

import { useMemo, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import SettingRow from '@/components/Settings/SettingRow';
import type { AppleSpeechCapabilities } from '@/lib/apple-speech';
import { prepareAppleSpeech } from '@/lib/apple-speech';

interface AppleSpeechSettingsProps {
  locale: string;
  capabilities: AppleSpeechCapabilities | null;
  loadingCapabilities: boolean;
  capabilityError: string | null;
  disabled: boolean;
  preparing: boolean;
  onLocaleChange: (locale: string) => void;
  onRetryCapabilities: () => void;
  onPreparedLocale: (resolvedLocale: string, requestedLocale: string) => void;
  onPreparingChange: (preparing: boolean) => void;
}

const selectClass = 'h-8 min-w-[220px] rounded-control border border-border bg-bg px-2.5 text-ui text-text outline-none focus:border-accent disabled:opacity-45';
const actionClass = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-control border border-border bg-bg px-2.5 text-ui font-medium text-text hover:bg-surface disabled:cursor-not-allowed disabled:opacity-45';
const messageFromError = (error: unknown, fallback: string) => error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;

export function AppleSpeechSettings({
  locale,
  capabilities,
  loadingCapabilities,
  capabilityError,
  disabled,
  preparing,
  onLocaleChange,
  onRetryCapabilities,
  onPreparedLocale,
  onPreparingChange,
}: AppleSpeechSettingsProps) {
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const preparingRef = useRef(false);
  const selectedLocale = useMemo(
    () => capabilities?.locales.find((candidate) => candidate.id === locale)
      ?? capabilities?.locales.find((candidate) => candidate.id.replace('_', '-') === locale.replace('_', '-')),
    [capabilities?.locales, locale],
  );
  const unavailableReason = capabilityError ?? capabilities?.reason ?? null;
  const canUseAppleSpeech = capabilities?.available === true;

  const prepare = async () => {
    if (disabled || preparingRef.current || !canUseAppleSpeech) return;
    const requestedLocale = locale;
    preparingRef.current = true;
    onPreparingChange(true);
    setPrepareError(null);
    try {
      const resolvedLocale = await prepareAppleSpeech(requestedLocale);
      onPreparedLocale(resolvedLocale, requestedLocale);
    } catch (error) {
      setPrepareError(messageFromError(error, 'Could not prepare this language. Try again.'));
    } finally {
      preparingRef.current = false;
      onPreparingChange(false);
    }
  };

  return (
    <>
      <SettingRow
        label="Apple Speech language"
        description="Choose the spoken language. It is used for live recordings, imports and re-transcription."
        control={(
          <select
            value={selectedLocale?.id ?? locale}
            aria-label="Apple Speech language"
            onChange={(event) => {
              setPrepareError(null);
              onLocaleChange(event.target.value);
            }}
            className={selectClass}
            disabled={disabled || preparing || loadingCapabilities || !canUseAppleSpeech}
          >
            {selectedLocale == null && <option value={locale}>{locale}</option>}
            {capabilities?.locales.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
            ))}
          </select>
        )}
      />

      <SettingRow
        label="Language readiness"
        description={unavailableReason
          ? unavailableReason
          : selectedLocale?.installed
            ? `${selectedLocale.name} is ready for live transcription.`
            : `${selectedLocale?.name ?? locale} needs Apple speech assets before a live recording can start.`}
        control={(
          unavailableReason ? (
            <button type="button" aria-label="Retry Apple Speech availability check" onClick={onRetryCapabilities} disabled={disabled || preparing || loadingCapabilities} className={actionClass}>
              {loadingCapabilities ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Retry
            </button>
          ) : (
            <button type="button" aria-label={selectedLocale?.installed ? 'Prepare Apple Speech language' : 'Download Apple Speech language'} onClick={() => void prepare()} disabled={disabled || loadingCapabilities || preparing || !canUseAppleSpeech} className={actionClass}>
              {preparing && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
              {selectedLocale?.installed ? 'Prepare language' : 'Download language'}
            </button>
          )
        )}
      >
        {loadingCapabilities && <p className="text-caption text-3">Checking Apple Speech availability…</p>}
        {prepareError && <p role="alert" className="text-caption leading-5 text-danger">{prepareError}</p>}
        {!unavailableReason && !loadingCapabilities && (
          <p className="text-caption leading-5 text-3">Downloads occur only when you choose Download language.</p>
        )}
      </SettingRow>
    </>
  );
}
