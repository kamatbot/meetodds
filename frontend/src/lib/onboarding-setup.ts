import { readAutoSummaryApproval, saveAutoSummaryApproval } from './post-meeting-flow';
import { summaryTarget } from './summary-input';

export type SummaryDestination = 'local' | 'chatgpt';

export const ONBOARDING_STATUS_VERSION = '2.0';
export const SUMMARY_DESTINATION_KEY = 'meetodds.onboarding.summaryDestination.v1';

export interface SavedOnboardingProgress {
  version?: string;
  completed: boolean;
  current_step: number;
}

export function resolveOnboardingProgress(status: SavedOnboardingProgress): {
  currentStep: 1 | 2;
  completed: boolean;
} {
  const savedStep = Number.isInteger(status.current_step) ? status.current_step : 1;

  if (status.version === ONBOARDING_STATUS_VERSION) {
    return {
      currentStep: savedStep >= 2 ? 2 : 1,
      completed: status.completed,
    };
  }

  // In the old four-step flow, step 4 was the permissions screen. Steps 1–3
  // still need a summary destination, so they safely resume at the new first step.
  return {
    currentStep: savedStep >= 4 ? 2 : 1,
    completed: status.completed,
  };
}

export function readSummaryDestination(storage: Pick<Storage, 'getItem'>): SummaryDestination | null {
  try {
    const value = storage.getItem(SUMMARY_DESTINATION_KEY);
    return value === 'local' || value === 'chatgpt' ? value : null;
  } catch {
    return null;
  }
}

export function saveSummaryDestination(
  storage: Pick<Storage, 'setItem'>,
  destination: SummaryDestination,
): void {
  storage.setItem(SUMMARY_DESTINATION_KEY, destination);
}

export function firstAvailableChatGPTModel(models: Array<string | { id?: string | null }>): string | null {
  for (const model of models) {
    const id = typeof model === 'string' ? model : model?.id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return null;
}

export function hasSavedSummaryApproval(
  storage: Pick<Storage, 'getItem'>,
  provider: string,
  model: string,
  endpoint?: string | null,
): boolean {
  try {
    return readAutoSummaryApproval(storage, summaryTarget(provider, model, endpoint)) !== null;
  } catch {
    return false;
  }
}

export function isExactModelAvailable(
  models: Array<{ name?: unknown; status?: unknown }>,
  modelName: string,
): boolean {
  return Boolean(modelName && models.some((model) => model.name === modelName && model.status === 'Available'));
}

export function onboardingModelsReady(
  destination: SummaryDestination,
  transcriptionReady: boolean,
  localSummaryReady: boolean,
): boolean {
  return transcriptionReady && (destination !== 'local' || localSummaryReady);
}

export function createDownloadStartGate() {
  const attempted = new Set<string>();
  return {
    startOnce<T>(key: string, start: () => Promise<T>): Promise<T> | null {
      if (attempted.has(key)) return null;
      attempted.add(key);
      return Promise.resolve().then(start);
    },
    retry<T>(start: () => Promise<T>): Promise<T> {
      return Promise.resolve().then(start);
    },
  };
}

export interface PersistedSummaryConfiguration {
  provider: string;
  model: string;
  endpoint?: string | null;
}

interface CommitSummaryDestinationOptions {
  storage: Pick<Storage, 'setItem'>;
  destination: SummaryDestination;
  authenticated: boolean;
  availableModels?: Array<string | { id?: string | null }>;
  model?: string;
  persistAndReadConfiguration: (
    provider: 'builtin-ai' | 'openai-codex',
    model: string,
  ) => Promise<PersistedSummaryConfiguration>;
  setAutoSummary: (enabled: boolean) => void;
}

/** Persist the selected target first; bind consent only to the verified saved target. */
export async function commitSummaryDestination({
  storage,
  destination,
  authenticated,
  availableModels = [],
  model,
  persistAndReadConfiguration,
  setAutoSummary,
}: CommitSummaryDestinationOptions) {
  if (destination === 'chatgpt' && !authenticated) {
    throw new Error('Connect your ChatGPT account before allowing automatic summaries.');
  }

  const provider = destination === 'local' ? 'builtin-ai' : 'openai-codex';
  const preferredModel = model?.trim();
  const selectedModel = destination === 'local'
    ? preferredModel
    : preferredModel && availableModels.some((available) => {
      const id = typeof available === 'string' ? available : available?.id;
      return typeof id === 'string' && id.trim() === preferredModel;
    })
      ? preferredModel
      : firstAvailableChatGPTModel(availableModels);
  if (!selectedModel) {
    throw new Error(destination === 'local'
      ? 'The recommended local summary model is not ready yet.'
      : 'ChatGPT has not reported an available summary model.');
  }

  const saved = await persistAndReadConfiguration(provider, selectedModel);
  if (saved.provider !== provider || saved.model !== selectedModel) {
    throw new Error('The saved summary destination did not match the selected provider and model.');
  }

  const target = summaryTarget(saved.provider, saved.model, saved.endpoint);
  if (target.local !== (destination === 'local')) {
    throw new Error('The saved summary destination could not be verified.');
  }

  saveAutoSummaryApproval(storage, target, true);
  setAutoSummary(true);
  return { model: selectedModel, target };
}

interface PreflightSource {
  deviceName?: string | null;
  status: string;
}

export interface CapturePreflightResult {
  microphone: PreflightSource;
  systemAudio: PreflightSource;
  storageWritable: boolean;
  recordingFolder: string;
  storageMessage: string;
  audioRetained: boolean;
}

export interface ApprovedCaptureChoice {
  microphone: string;
  systemAudio: string | null;
}

export interface CaptureSelection {
  microphone: string | null;
  systemAudio: string | null;
  includeSystem: boolean;
}

export function sameCaptureSelection(a: CaptureSelection, b: CaptureSelection): boolean {
  return a.microphone === b.microphone
    && a.systemAudio === b.systemAudio
    && a.includeSystem === b.includeSystem;
}

function usableSource(source: PreflightSource | undefined): source is PreflightSource & { deviceName: string } {
  return (source?.status === 'signal' || source?.status === 'silent')
    && typeof source.deviceName === 'string'
    && source.deviceName.trim().length > 0;
}

export function resolveApprovedCaptureChoice(
  result: CapturePreflightResult,
  includeSystem: boolean,
  acknowledgeSilence: boolean,
  participantsInformed: boolean,
): ApprovedCaptureChoice | null {
  if (typeof result.storageWritable !== 'boolean'
    || !result.storageWritable
    || typeof result.recordingFolder !== 'string'
    || !result.recordingFolder.trim()
    || typeof result.storageMessage !== 'string'
    || !result.storageMessage.trim()
    || typeof result.audioRetained !== 'boolean'
    || !participantsInformed
    || !usableSource(result.microphone)) return null;
  if (result.microphone.status === 'silent' && !acknowledgeSilence) return null;

  let systemAudio: string | null = null;
  if (includeSystem) {
    const systemSource = result.systemAudio;
    if (!usableSource(systemSource)) return null;
    if (systemSource.status === 'silent' && !acknowledgeSilence) return null;
    systemAudio = systemSource.deviceName;
  }

  return {
    microphone: result.microphone.deviceName,
    systemAudio,
  };
}
