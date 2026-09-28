import { invoke } from '@tauri-apps/api/core';

export interface AppleIntelligenceStatus {
  available: boolean;
  reason: string | null;
}

const UNAVAILABLE_STATUS: AppleIntelligenceStatus = {
  available: false,
  reason: 'Apple Intelligence status is unavailable',
};

/**
 * Reads whether Apple Intelligence can summarize on this Mac. The native
 * command is owned by another workstream; until it ships (or if it ever
 * fails), this fails closed so ChatGPT remains the selectable alternative.
 */
export async function getAppleIntelligenceStatus(): Promise<AppleIntelligenceStatus> {
  try {
    return await invoke<AppleIntelligenceStatus>('api_apple_intelligence_status');
  } catch {
    return UNAVAILABLE_STATUS;
  }
}
