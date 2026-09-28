import { readAutoSummaryApproval, saveAutoSummaryApproval } from './post-meeting-flow';
import { summaryTarget } from './summary-input';

export type SummaryDestination = 'local' | 'chatgpt';

/** The fixed model name saved for the on-device Apple Intelligence provider. */
export const APPLE_INTELLIGENCE_MODEL = 'system';

export const ONBOARDING_STATUS_VERSION = '3.0';
export const SUMMARY_DESTINATION_KEY = 'meetodds.onboarding.summaryDestination.v1';

export interface SavedOnboardingProgress {
  version?: string;
  completed: boolean;
  current_step: number;
}

export function resolveOnboardingProgress(status: SavedOnboardingProgress): {
  currentStep: 1 | 2 | 3;
  completed: boolean;
} {
  const savedStep = Number.isInteger(status.current_step) ? status.current_step : 1;

  // Older versions numbered their steps differently (the four-step wizard, then
  // the two-step Welcome/Permissions flow). Reusing a step number across an
  // incompatible version would land the user on the wrong screen, so any
  // version other than the current one safely resumes at the new first step.
  // `completed` always carries forward regardless of version.
  if (status.version === ONBOARDING_STATUS_VERSION) {
    return {
      currentStep: savedStep >= 1 && savedStep <= 3 ? (savedStep as 1 | 2 | 3) : 1,
      completed: status.completed,
    };
  }

  return {
    currentStep: 1,
    completed: status.completed,
  };
}

/**
 * Default Apple Speech locale for onboarding: the system locale when Apple
 * Speech supports it, otherwise en-US.
 */
export function defaultAppleSpeechLocale(
  systemLocale: string | null | undefined,
  locales: Array<{ id: string }>,
): string {
  const normalize = (value: string) => value.replace('_', '-').toLowerCase();
  const target = systemLocale ? normalize(systemLocale) : '';
  const match = target ? locales.find((candidate) => normalize(candidate.id) === target) : undefined;
  return match ? match.id : 'en-US';
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
    provider: 'apple-intelligence' | 'openai-codex',
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

  const provider = destination === 'local' ? 'apple-intelligence' : 'openai-codex';
  const preferredModel = model?.trim();
  // Apple Intelligence has one fixed on-device model; only ChatGPT needs a model choice.
  const selectedModel = destination === 'local'
    ? APPLE_INTELLIGENCE_MODEL
    : preferredModel && availableModels.some((available) => {
      const id = typeof available === 'string' ? available : available?.id;
      return typeof id === 'string' && id.trim() === preferredModel;
    })
      ? preferredModel
      : firstAvailableChatGPTModel(availableModels);
  if (!selectedModel) {
    throw new Error('ChatGPT has not reported an available summary model.');
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
