'use client';

import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowLeft, Check, Loader2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfig } from '@/contexts/ConfigContext';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { loadApprovedCapture, saveApprovedCapture } from '@/lib/capture-start';
import {
  resolveApprovedCaptureChoice,
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
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-ui font-semibold text-text">{title}</strong>
        <span className="inline-flex items-center gap-1.5 text-caption text-2">
          {source.status === 'signal' && <Check className="h-3.5 w-3.5 text-green-700" />}
          {statusLabel(source.status)}
        </span>
      </div>
      <p className="mt-1 break-all text-caption text-2">{source.deviceName || 'No device confirmed'}</p>
      <p className="mt-1 text-caption leading-5 text-2">{source.message}</p>
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

export function PermissionsStep({ onComplete }: PermissionsStepProps) {
  const { selectedLanguage, goPrevious, completeOnboarding } = useOnboarding();
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
        setTranscriptModelConfig({ provider: 'appleSpeech', model: selectedLanguage, apiKey: null });
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
  const needsAudioCheck = !preflight || !checkedSelectionMatches;
  const microphoneUsable = preflight
    && (preflight.microphone.status === 'signal' || preflight.microphone.status === 'silent')
    && Boolean(preflight.microphone.deviceName?.trim());
  const systemAudioUsable = !includeSystem || (preflight
    && (preflight.systemAudio.status === 'signal' || preflight.systemAudio.status === 'silent')
    && Boolean(preflight.systemAudio.deviceName?.trim()));
  const storageReady = preflight
    && preflight.storageWritable
    && Boolean(preflight.recordingFolder?.trim())
    && Boolean(preflight.storageMessage?.trim())
    && typeof preflight.audioRetained === 'boolean';
  const preflightFailureReason = !microphoneUsable
    ? 'Connect a working microphone, then check audio again.'
    : !systemAudioUsable
    ? 'Make system audio available, or choose microphone only, then check again.'
    : !storageReady
    ? 'Review the recording folder or retention setting, then check audio again.'
    : null;
  const finishBlockedReason = includeSystem === null
    ? 'Choose what to capture, then check audio.'
    : needsAudioCheck
    ? 'Run Check audio for these selected sources before finishing.'
    : preflightFailureReason
    ? preflightFailureReason
    : hasSilentSource && !acknowledgeSilence
    ? 'Acknowledge the silent source to continue.'
    : !participantsInformed
    ? 'Confirm that participants are informed to continue.'
    : !approvedCapture
    ? 'Resolve the audio or storage issue shown above, then check again.'
    : 'Audio, storage, and recording consent are ready.';

  const footer = (
    <div className="space-y-2">
      {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-caption text-danger">{error}</p>}
      <p className={`text-caption ${approvedCapture ? 'text-2' : 'text-text'}`} aria-live="polite">{finishBlockedReason}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="ghost" onClick={goPrevious} disabled={busy !== null} className="h-9 px-2 text-2">
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
        </Button>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant={needsAudioCheck ? 'default' : 'outline'}
            onClick={() => void checkAudio()}
            disabled={busy !== null || includeSystem === null}
            className="h-10 rounded-xl px-4"
          >
            {busy === 'check' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
            {busy === 'check' ? 'Checking…' : preflight ? 'Check again' : 'Check audio'}
          </Button>
          <Button
            type="button"
            onClick={() => void finishSetup()}
            disabled={!approvedCapture || busy !== null}
            className="h-10 min-w-[142px] rounded-xl bg-text px-4 text-ui font-semibold text-surface hover:opacity-90"
          >
            {busy === 'finish' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {busy === 'finish' ? 'Finishing…' : 'Finish setup'}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <OnboardingContainer
      title="Check your recording setup"
      description="Choose what to capture, then verify the real sources and recording folder."
      step={3}
      totalSteps={3}
      className="max-w-[760px]"
      footer={footer}
    >
      <div className="mx-auto w-full max-w-[620px] space-y-4">
        <section aria-labelledby="capture-choice-title" className="space-y-2">
          <h2 id="capture-choice-title" className="text-ui font-semibold text-text">What should a meeting include?</h2>
          <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${includeSystem === true ? 'border-text bg-bg' : 'border-border bg-surface'}`}>
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
          <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${includeSystem === false ? 'border-text bg-bg' : 'border-border bg-surface'}`}>
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

        <section aria-labelledby="audio-check-title" className="space-y-3 border-t border-border pt-4">
          <div>
            <h2 id="audio-check-title" className="text-ui font-semibold text-text">Audio and storage check</h2>
            <p className="mt-1 text-caption leading-5 text-2">This brief test discards its audio after checking the selected sources and recording folder.</p>
          </div>

          {preflight && (
            <div className="space-y-3" aria-live="polite">
              <div className="rounded-xl border border-border bg-bg px-3 py-2.5 text-caption text-2">
                <p className="font-semibold text-text">
                  Microphone: {statusLabel(preflight.microphone.status)}
                  {includeSystem && ` · System: ${statusLabel(preflight.systemAudio.status)}`}
                </p>
                <p className={`mt-1 ${preflight.storageWritable ? '' : 'text-danger'}`}>Storage: {preflight.storageMessage}</p>
                <p className="mt-1">{preflight.audioRetained ? 'Audio kept for playback and re-transcription.' : 'Transcript only—audio not saved.'}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer font-medium text-text">Show check details</summary>
                  <div className="mt-2 space-y-2">
                    <SourceResult title="Microphone" source={preflight.microphone} />
                    {includeSystem && <SourceResult title="System audio" source={preflight.systemAudio} />}
                    <p className="break-all">Recording folder: {preflight.recordingFolder || 'Unavailable'}</p>
                  </div>
                </details>
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
          {!preflight && <p className="text-caption text-2">Choose a capture mode, then use Check audio below.</p>}
        </section>
      </div>
    </OnboardingContainer>
  );
}
