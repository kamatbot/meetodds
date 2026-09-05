/** One start transaction across every recording entry point (including remounted views). */
export function createCaptureStartGate() {
  let starting = false;
  return {
    get pending() { return starting; },
    async run(start: () => Promise<void>): Promise<boolean> {
      if (starting) return false;
      starting = true;
      try { await start(); return true; }
      finally { starting = false; }
    },
  };
}

export interface ApprovedCaptureChoice {
  microphone: string;
  systemAudio: string | null;
}

interface CaptureApproval extends ApprovedCaptureChoice {
  selectedMicrophone: string | null;
  selectedSystemAudio: string | null;
}

const CAPTURE_APPROVAL_KEY = 'meetodds.capture-preflight.approval.v1';

/**
 * The confirmation is onboarding, not a per-meeting gate. Keep it tied to the
 * configured sources so changing a device deliberately asks for confirmation again.
 */
export function loadApprovedCapture(
  selectedMicrophone: string | null,
  selectedSystemAudio: string | null,
): ApprovedCaptureChoice | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(CAPTURE_APPROVAL_KEY) || 'null') as Partial<CaptureApproval> | null;
    if (!value
      || typeof value.microphone !== 'string'
      || (value.systemAudio !== null && typeof value.systemAudio !== 'string')
      || value.selectedMicrophone !== selectedMicrophone
      || value.selectedSystemAudio !== selectedSystemAudio) return null;
    return { microphone: value.microphone, systemAudio: value.systemAudio ?? null };
  } catch {
    return null;
  }
}

export function saveApprovedCapture(
  selectedMicrophone: string | null,
  selectedSystemAudio: string | null,
  capture: ApprovedCaptureChoice,
) {
  if (typeof window === 'undefined') return;
  const approval: CaptureApproval = { ...capture, selectedMicrophone, selectedSystemAudio };
  try { window.localStorage.setItem(CAPTURE_APPROVAL_KEY, JSON.stringify(approval)); }
  catch { /* A private or unavailable store should only restore the one-time check. */ }
}

export function captureStartMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|denied|not authorized/i.test(message)) return 'Audio permission was denied. Allow access in system settings, then retry.';
  if (/download/i.test(message)) return 'The selected transcription model is still downloading. Finish setup before recording.';
  if (/model/i.test(message)) return 'The selected transcription model is not ready. Open transcription settings to finish setup.';
  if (/space|disk|storage|directory|folder/i.test(message)) return 'Recording storage is unavailable. Check free space and the recordings folder, then retry.';
  if (/device|microphone|audio|stream/i.test(message)) return 'The selected audio source could not start. Check its connection and permissions, then retry.';
  return 'Recording could not start. Your saved meetings are unchanged. Check audio and transcription settings, then retry.';
}
