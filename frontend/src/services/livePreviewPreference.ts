import { invoke } from '@tauri-apps/api/core';

export const LIVE_CAPTIONS_VISIBLE_KEY = 'meetodds.liveCaptions.visible';

let hydration: Promise<boolean> | null = null;
let syncChain: Promise<void> = Promise.resolve();
let latestOperation: Promise<unknown> = Promise.resolve();

function readLegacyPreference(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(LIVE_CAPTIONS_VISIBLE_KEY);
    return value === null ? null : value !== 'false';
  } catch {
    return null;
  }
}

function persistPreference(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LIVE_CAPTIONS_VISIBLE_KEY, String(enabled));
  } catch {
    // Local storage is only a legacy migration source; native state remains usable.
  }
}

/** Queue every native operation, including recovery, behind its predecessors. */
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = syncChain.then(operation, operation);
  latestOperation = result;
  // Later work must still run after a failed operation, but the operation's caller
  // keeps its error and can present a recovery action.
  syncChain = result.then(() => undefined, () => undefined);
  return result;
}

async function setOrReadActual(enabled: boolean): Promise<boolean> {
  try {
    await invoke('set_live_preview_enabled', { enabled });
    persistPreference(enabled);
    return enabled;
  } catch {
    const actual = await invoke<boolean>('get_live_preview_enabled');
    persistPreference(actual);
    return actual;
  }
}

/**
 * Reads the old local preference once. A migrated value wins; without one, retain
 * the native default/state so a newly opened main window never resets it to true.
 */
export function hydrateLivePreviewPreference(): Promise<boolean> {
  if (!hydration) {
    hydration = enqueue(async () => {
      const legacyPreference = readLegacyPreference();
      if (legacyPreference !== null) {
        return setOrReadActual(legacyPreference);
      }
      return invoke<boolean>('get_live_preview_enabled');
    });
  }
  return hydration;
}

/** Retry only after an actionable hydration/synchronization failure. */
export function retryLivePreviewPreferenceHydration(): Promise<boolean> {
  hydration = null;
  return hydrateLivePreviewPreference();
}

/** Serializes toggle writes and is also the recording-start barrier. */
export function setLivePreviewPreference(enabled: boolean): Promise<boolean> {
  const initialHydration = hydrateLivePreviewPreference();
  persistPreference(enabled);
  return enqueue(async () => {
    await initialHydration;
    return setOrReadActual(enabled);
  });
}

export async function ensureLivePreviewPreferenceSynced(): Promise<void> {
  const initialHydration = hydrateLivePreviewPreference();
  // Snapshot after hydration has been queued: this includes every toggle that was
  // requested before the recording start call, even if it was awaiting hydration.
  const barrier = latestOperation;
  await initialHydration;
  await barrier;
}
