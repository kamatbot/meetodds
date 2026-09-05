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

export function captureStartMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|denied|not authorized/i.test(message)) return 'Audio permission was denied. Allow access in system settings, then retry.';
  if (/download/i.test(message)) return 'The selected transcription model is still downloading. Finish setup before recording.';
  if (/model/i.test(message)) return 'The selected transcription model is not ready. Open transcription settings to finish setup.';
  if (/space|disk|storage|directory|folder/i.test(message)) return 'Recording storage is unavailable. Check free space and the recordings folder, then retry.';
  if (/device|microphone|audio|stream/i.test(message)) return 'The selected audio source could not start. Check its connection and permissions, then retry.';
  return 'Recording could not start. Your saved meetings are unchanged. Check audio and transcription settings, then retry.';
}
