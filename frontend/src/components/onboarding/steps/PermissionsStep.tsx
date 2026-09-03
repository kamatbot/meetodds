'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Mic, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { PermissionRow } from '../shared';
import { useOnboarding } from '@/contexts/OnboardingContext';

interface PermissionsStepProps {
  onComplete: () => void;
}

export function PermissionsStep({ onComplete }: PermissionsStepProps) {
  const {
    setPermissionStatus,
    setPermissionsSkipped,
    permissions,
    completeOnboarding,
  } = useOnboarding();
  const [isPending, setIsPending] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);

  const checkPermissions = useCallback(async () => {
    console.log('[PermissionsStep] Current permission states:');
    console.log(`  - Microphone: ${permissions.microphone}`);
    console.log(`  - System Audio: ${permissions.systemAudio}`);
  }, [permissions.microphone, permissions.systemAudio]);

  useEffect(() => {
    void checkPermissions();
  }, [checkPermissions]);

  const handleMicrophoneAction = async () => {
    if (permissions.microphone === 'denied') {
      try {
        await invoke('open_system_settings');
      } catch {
        alert('Please enable microphone access in System Settings → Privacy & Security → Microphone');
      }
      return;
    }

    setIsPending(true);
    try {
      const granted = await invoke<boolean>('trigger_microphone_permission');
      setPermissionStatus('microphone', granted ? 'authorized' : 'denied');
    } catch (error) {
      console.error('[PermissionsStep] Failed to request microphone permission:', error);
      setPermissionStatus('microphone', 'denied');
    } finally {
      setIsPending(false);
    }
  };

  const handleSystemAudioAction = async () => {
    if (permissions.systemAudio === 'denied') {
      try {
        await invoke('open_system_settings');
      } catch {
        alert('Please enable Audio Capture in System Settings → Privacy & Security → Audio Capture');
      }
      return;
    }

    setIsPending(true);
    try {
      const granted = await invoke<boolean>('trigger_system_audio_permission_command');
      setPermissionStatus('systemAudio', granted ? 'authorized' : 'denied');
    } catch (error) {
      console.error('[PermissionsStep] Failed to request system audio permission:', error);
      setPermissionStatus('systemAudio', 'denied');
    } finally {
      setIsPending(false);
    }
  };

  const handleFinish = async () => {
    if (isFinishing) return;
    setIsFinishing(true);
    try {
      await completeOnboarding();
      onComplete();
    } catch (error) {
      console.error('Failed to complete onboarding:', error);
      setIsFinishing(false);
    }
  };

  const handleSkip = async () => {
    setPermissionsSkipped(true);
    await handleFinish();
  };

  const allPermissionsGranted =
    permissions.microphone === 'authorized' &&
    permissions.systemAudio === 'authorized';

  return (
    <OnboardingContainer
      title="Allow meeting capture"
      description="MeetOdds needs microphone and system-audio access to capture both sides of a meeting."
      step={4}
      totalSteps={4}
      hideProgress={false}
    >
      <div className="mx-auto max-w-lg space-y-6">
        <div className="overflow-hidden rounded-card border border-border bg-surface">
          <div className="border-b border-border p-4">
            <PermissionRow
              icon={<Mic className="h-5 w-5" />}
              title="Microphone"
              description="Capture your voice during meetings."
              status={permissions.microphone}
              isPending={isPending}
              onAction={handleMicrophoneAction}
            />
          </div>
          <div className="p-4">
            <PermissionRow
              icon={<Volume2 className="h-5 w-5" />}
              title="System audio"
              description="Capture audio from calls, videos, and conferencing apps."
              status={permissions.systemAudio}
              isPending={isPending}
              onAction={handleSystemAudioAction}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 pt-1">
          <Button
            onClick={() => void handleFinish()}
            disabled={!allPermissionsGranted || isFinishing}
            className="h-10 w-full rounded-control bg-accent text-white hover:opacity-90"
          >
            {isFinishing ? 'Finishing…' : 'Go to Home'}
          </Button>

          <button
            type="button"
            onClick={() => void handleSkip()}
            disabled={isFinishing}
            className="text-ui text-3 transition-colors duration-150 hover:text-text disabled:opacity-40"
          >
            Set up permissions later
          </button>

          {!allPermissionsGranted && (
            <p className="text-center text-caption text-3">
              You can finish setup now; Home will show anything that still needs attention.
            </p>
          )}
        </div>
      </div>
    </OnboardingContainer>
  );
}
