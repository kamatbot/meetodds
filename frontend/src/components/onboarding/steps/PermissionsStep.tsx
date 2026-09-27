'use client';

import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowLeft, Check, Loader2, Mic, RotateCw, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DEFAULT_PARAKEET_MODEL } from '@/constants/modelDefaults';
import { useConfig } from '@/contexts/ConfigContext';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { loadApprovedCapture, saveApprovedCapture } from '@/lib/capture-start';
import {
  resolveApprovedCaptureChoice,
  onboardingModelsReady,
  sameCaptureSelection,
  type CapturePreflightResult,
  type CaptureSelection,
} from '@/lib/onboarding-setup';
import { OnboardingContainer } from '../OnboardingContainer';

interface SourceCheck {
  deviceName: string | null;
  source: string;
  status: string;
  samplesReceived: number;
  rms: number;
  peak: number;
  message: string;
}

interface CapturePreflight extends CapturePreflightResult {
  microphone: SourceCheck;
  systemAudio: SourceCheck;
  audioRetained: boolean;
  recordingFolder: string;
  storageMessage: string;
}

interface PermissionsStepProps {
  onComplete: () => void;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'signal': return 'Signal received';
    case 'silent': return 'Open, but silent';
    case 'permission_denied': return 'Permission needed';
    case 'no_frames': return 'No audio received';
    case 'unavailable': return 'Unavailable';
    case 'disabled': return 'Not included';
    default: return 'Not verified';
  }
}

function SourceResult({ title, source }: { title: string; source: SourceCheck }) {
  const hasSamples = source.samplesReceived > 0;
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-ui font-semibold text-text">{title}</strong>
        <span className="inline-flex items-center gap-1.5 text-caption text-2">
          {source.status === 'signal' && <Check className="h-3.5 w-3.5 text-green-700" />}
          {statusLabel(source.status)}
        </span>
      </div>
      <p className="mt-1 break-all text-caption text-2">{source.deviceName || 'No device confirmed'}</p>
      <p className="mt-2 text-caption leading-5 text-2">{source.message}</p>
      {hasSamples && (
        <meter
          aria-label={`${title} measured level`}
          min={0}
          max={1}
          value={Math.min(1, Math.max(0, source.rms))}
          className="mt-3 h-2 w-full"
        />
      )}
    </div>
  );
}

function ModelReadiness({
  title,
  model,
  ready,
  progress,
  error,
  onRetry,
}: {
  title: string;
  model: string;
  ready: boolean;
  progress: number;
  error?: string;
  onRetry: () => void;
}) {
  const message = ready
    ? 'Ready on this Mac'
    : error
    ? 'Download needs attention'
    : progress >= 100
    ? 'Checking model availability…'
    : progress > 0
    ? `Downloading · ${Math.round(progress)}%`
    : 'Preparing in the background';

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-bg text-text">
        {title === 'Transcription' ? <Mic className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-caption font-semibold text-text">{title}</span>
        <span className="block truncate text-[11px] text-2">{model || 'Recommended model is loading'}</span>
      </span>
      <span className="text-right text-[11px] text-2">{message}</span>
      {error && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Retry
        </Button>
      )}
      {!ready && progress > 0 && progress < 100 && (
        <div className="h-1.5 basis-full overflow-hidden rounded-full bg-bg" aria-label={`${title} download progress`}>
          <div className="h-full rounded-full bg-text transition-[width]" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      )}
    </div>
  );
}

export function PermissionsStep({ onComplete }: PermissionsStepProps) {
  const {
    summaryDestination,
    selectedSummaryModel,
    recommendedSummaryModel,
    summaryModelDownloaded,
    summaryModelProgress,
    summaryModelProgressInfo,
    parakeetDownloaded,
    parakeetProgress,
    parakeetProgressInfo,
    startBackgroundDownloads,
    retryParakeetDownload,
    retrySummaryModelDownload,
    goPrevious,
    completeOnboarding,
  } = useOnboarding();
  const { selectedDevices, setTranscriptModelConfig } = useConfig();
  const [includeSystem, setIncludeSystem] = useState<boolean | null>(null);
  const [preflight, setPreflight] = useState<CapturePreflight | null>(null);
  const [testedSelection, setTestedSelection] = useState<CaptureSelection | null>(null);
  const [acknowledgeSilence, setAcknowledgeSilence] = useState(false);
  const [participantsInformed, setParticipantsInformed] = useState(false);
  const [busy, setBusy] = useState<'check' | 'finish' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selection: CaptureSelection = {
    microphone: selectedDevices?.micDevice || null,
    systemAudio: selectedDevices?.systemDevice || null,
    includeSystem: includeSystem === true,
  };
  const currentSelection = selection;
  const checkedSelectionMatches = Boolean(
    preflight && testedSelection && sameCaptureSelection(testedSelection, currentSelection),
  );
  const activeSources = preflight
    ? [preflight.microphone, ...(includeSystem ? [preflight.systemAudio] : [])]
    : [];
  const hasSilentSource = activeSources.some((source) => source.status === 'silent');
  const approvedCapture = preflight && checkedSelectionMatches && includeSystem !== null
    ? resolveApprovedCaptureChoice(preflight, includeSystem, acknowledgeSilence, participantsInformed)
    : null;
  const localModel = recommendedSummaryModel || selectedSummaryModel;
  const modelsReady = onboardingModelsReady(summaryDestination, parakeetDownloaded, summaryModelDownloaded);

  useEffect(() => {
    void startBackgroundDownloads({
      includeParakeet: true,
      includeSummary: summaryDestination === 'local',
      summaryModel: summaryDestination === 'local' ? localModel : undefined,
    }).catch((failure) => {
      setError(failure instanceof Error ? failure.message : 'Model preparation could not start.');
    });
  }, [summaryDestination, localModel, startBackgroundDownloads]);

  useEffect(() => {
    setPreflight(null);
    setTestedSelection(null);
    setAcknowledgeSilence(false);
    setParticipantsInformed(false);
    setError(null);
  }, [selectedDevices?.micDevice, selectedDevices?.systemDevice, includeSystem]);

  const checkAudio = async () => {
    if (busy) return;
    if (includeSystem === null) {
      setError('Choose system audio or microphone-only before checking your setup.');
      return;
    }

    setBusy('check');
    setPreflight(null);
    setTestedSelection(null);
    setAcknowledgeSilence(false);
    setParticipantsInformed(false);
    setError(null);
    try {
      const result = await invoke<CapturePreflight>('run_capture_preflight', {
        micDeviceName: currentSelection.microphone,
        systemDeviceName: currentSelection.systemAudio,
        includeSystem,
      });
      setPreflight(result);
      setTestedSelection(currentSelection);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(/preferences/i.test(message)
        ? 'Recording preferences could not be read. Review recording and retention settings, then check again.'
        : 'The audio check could not finish. Check permissions and selected devices, then retry.');
    } finally {
      setBusy(null);
    }
  };

  const openSystemSettings = async () => {
    try {
      await invoke('open_system_settings');
      setError('Allow the required access in System Settings, then run Check audio again.');
    } catch {
      setError('System Settings could not be opened. Open Privacy & Security manually, then check audio again.');
    }
  };

  const finishSetup = async () => {
    if (!approvedCapture || !preflight || !testedSelection || busy) return;
    if (!modelsReady) {
      setError(summaryDestination === 'local' && !summaryModelDownloaded
        ? `Wait until the selected summary model (${localModel || 'recommended model'}) is ready, or retry its download.`
        : 'Wait until the selected transcription model is ready, or retry its download.');
      return;
    }
    setBusy('finish');
    setError(null);
    try {
      saveApprovedCapture(
        selectedDevices?.micDevice || null,
        selectedDevices?.systemDevice || null,
        approvedCapture,
      );
      const savedApproval = loadApprovedCapture(
        selectedDevices?.micDevice || null,
        selectedDevices?.systemDevice || null,
      );
      if (!savedApproval
        || savedApproval.microphone !== approvedCapture.microphone
        || savedApproval.systemAudio !== approvedCapture.systemAudio) {
        throw new Error('The checked audio setup could not be saved on this device. Retry before continuing.');
      }

      await completeOnboarding(() => {
        setTranscriptModelConfig({ provider: 'parakeet', model: DEFAULT_PARAKEET_MODEL, apiKey: null });
      });
      onComplete();
    } catch (failure) {
      setError(failure instanceof Error && failure.message
        ? failure.message
        : 'Setup could not be completed. Your checked audio results are still shown; retry when ready.');
    } finally {
      setBusy(null);
    }
  };

  const canOpenSettings = activeSources.some((source) =>
    source.status === 'permission_denied' || source.status === 'no_frames',
  );

  return (
    <OnboardingContainer
      title="Let MeetOdds listen."
      description="Choose what to capture, then check the real audio sources and recording folder before finishing setup."
      step={2}
      totalSteps={2}
      className="max-w-[760px]"
    >
      <div className="mx-auto w-full max-w-[620px] space-y-5">
        <section aria-labelledby="capture-choice-title" className="space-y-3">
          <h2 id="capture-choice-title" className="text-ui font-semibold text-text">What should a meeting include?</h2>
          <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors ${includeSystem === true ? 'border-text bg-bg' : 'border-border bg-surface'}`}>
            <input
              type="radio"
              name="capture-mode"
              className="mt-1 accent-[var(--accent)]"
              checked={includeSystem === true}
              onChange={() => setIncludeSystem(true)}
              disabled={busy !== null}
            />
            <span>
              <span className="block text-ui font-medium text-text">Microphone and system audio</span>
              <span className="mt-1 block text-caption leading-5 text-2">Capture your voice and the other people on the call.</span>
            </span>
          </label>
          <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors ${includeSystem === false ? 'border-text bg-bg' : 'border-border bg-surface'}`}>
            <input
              type="radio"
              name="capture-mode"
              className="mt-1 accent-[var(--accent)]"
              checked={includeSystem === false}
              onChange={() => setIncludeSystem(false)}
              disabled={busy !== null}
            />
            <span>
              <span className="block text-ui font-medium text-text">Microphone only</span>
              <span className="mt-1 block text-caption leading-5 text-2">A deliberate choice. Remote participants may not be included.</span>
            </span>
          </label>
          <p className="text-caption text-2">
            Microphone: {currentSelection.microphone || 'Default microphone'}
            {includeSystem && <> · System audio: {currentSelection.systemAudio || 'Default output'}</>}
          </p>
        </section>

        <section aria-labelledby="model-setup-title" className="space-y-3">
          <h2 id="model-setup-title" className="text-ui font-semibold text-text">Local models</h2>
          <ModelReadiness
            title="Transcription"
            model="Parakeet · local speech recognition"
            ready={parakeetDownloaded}
            progress={parakeetProgress}
            error={parakeetProgressInfo.error}
            onRetry={() => void retryParakeetDownload().catch(() => setError('The transcription download could not be retried.'))}
          />
          {summaryDestination === 'local' && (
            <ModelReadiness
              title="Summary"
              model={localModel}
              ready={summaryModelDownloaded}
              progress={summaryModelProgress}
              error={summaryModelProgressInfo.error}
              onRetry={() => void retrySummaryModelDownload().catch(() => setError('The summary model download could not be retried.'))}
            />
          )}
          <p className="text-caption leading-5 text-2">Transcription stays on this Mac with either summary choice. Finish setup becomes available when the exact required models are ready.</p>
        </section>

        <section aria-labelledby="audio-check-title" className="space-y-3 border-t border-border pt-5">
          <div>
            <h2 id="audio-check-title" className="text-ui font-semibold text-text">Check your audio and storage</h2>
            <p className="mt-1 text-caption leading-5 text-2">The test listens briefly to the selected sources, writes a temporary file in your recording folder, and discards the audio. It is not saved or transcribed.</p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void checkAudio()}
            disabled={busy !== null || includeSystem === null}
            className="h-10 rounded-xl px-4"
          >
            {busy === 'check' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
            {busy === 'check' ? 'Checking actual sources…' : preflight ? 'Check audio again' : 'Check audio'}
          </Button>

          {preflight && (
            <div className="space-y-3" aria-live="polite">
              <SourceResult title="Microphone" source={preflight.microphone} />
              {includeSystem && <SourceResult title="System audio" source={preflight.systemAudio} />}
              <div className="rounded-xl border border-border bg-bg px-4 py-3 text-caption text-2">
                <p className="font-semibold text-text">
                  {preflight.audioRetained ? 'Audio will be kept on this Mac' : 'Transcript only · audio will not be retained'}
                </p>
                <p className="mt-1">{preflight.audioRetained
                  ? 'Saved audio supports playback and re-transcription.'
                  : 'There will be no saved audio for playback, repair or re-transcription.'}</p>
                <p className="mt-2 break-all">Recording folder: {preflight.recordingFolder || 'Unavailable'}</p>
                <p className={`mt-1 ${preflight.storageWritable ? '' : 'text-danger'}`}>{preflight.storageMessage}</p>
              </div>
              {hasSilentSource && (
                <label className="flex items-start gap-2 text-caption leading-5 text-2">
                  <input
                    type="checkbox"
                    className="mt-1 accent-[var(--accent)]"
                    checked={acknowledgeSilence}
                    onChange={(event) => setAcknowledgeSilence(event.target.checked)}
                    disabled={busy !== null}
                  />
                  I understand a selected source was silent during testing and choose to continue.
                </label>
              )}
              <label className="flex items-start gap-2 text-caption leading-5 text-2">
                <input
                  type="checkbox"
                  className="mt-1 accent-[var(--accent)]"
                  checked={participantsInformed}
                  onChange={(event) => setParticipantsInformed(event.target.checked)}
                  disabled={busy !== null}
                />
                I have informed participants and am ready to record with these capture and retention settings.
              </label>
              {canOpenSettings && (
                <Button type="button" variant="outline" onClick={() => void openSystemSettings()}>
                  Open System Settings
                </Button>
              )}
            </div>
          )}
          {!preflight && <p className="text-caption text-2">No audio or storage check has been run yet.</p>}
        </section>

        {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-caption text-danger">{error}</p>}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <Button type="button" variant="ghost" onClick={goPrevious} disabled={busy !== null} className="text-2">
            <ArrowLeft className="mr-2 h-4 w-4" /> Back
          </Button>
          <span className="text-right text-caption text-2">2 of 2 · Your checked choices are saved for the first meeting</span>
          <Button
            type="button"
            onClick={() => void finishSetup()}
            disabled={!approvedCapture || !modelsReady || busy !== null}
            className="h-11 min-w-[170px] rounded-xl bg-text px-5 text-ui font-semibold text-surface hover:opacity-90"
          >
            {busy === 'finish' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {busy === 'finish' ? 'Finishing setup…' : 'Finish setup'}
          </Button>
        </div>
      </div>
    </OnboardingContainer>
  );
}
