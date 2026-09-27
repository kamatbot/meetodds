'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import type { PermissionStatus, OnboardingPermissions } from '@/types/onboarding';
import { DEFAULT_PARAKEET_MODEL } from '@/constants/modelDefaults';
import { resolveOnboardingSummaryModelStatus } from '@/lib/onboarding-summary-model';
import {
  ONBOARDING_STATUS_VERSION,
  createDownloadStartGate,
  hasSavedSummaryApproval,
  isExactModelAvailable,
  onboardingModelsReady,
  readSummaryDestination,
  resolveOnboardingProgress,
  saveSummaryDestination,
  type SummaryDestination,
} from '@/lib/onboarding-setup';
import type { ModelConfig } from '@/services/configService';

const PARAKEET_MODEL = DEFAULT_PARAKEET_MODEL;

interface OnboardingStatus {
  version: string;
  completed: boolean;
  current_step: number;
  model_status: {
    parakeet: string;
    summary: string;
    selected_summary_model?: string;
  };
  last_updated: string;
}

interface SummaryModelProgressInfo {
  percent: number;
  downloadedMb: number;
  totalMb: number;
  speedMbps: number;
  error?: string;
}

interface ParakeetProgressInfo {
  percent: number;
  downloadedMb: number;
  totalMb: number;
  speedMbps: number;
  error?: string;
}

interface OnboardingContextType {
  currentStep: number;
  summaryDestination: SummaryDestination;
  parakeetDownloaded: boolean;
  parakeetProgress: number;
  parakeetProgressInfo: ParakeetProgressInfo;
  summaryModelDownloaded: boolean;
  summaryModelProgress: number;
  summaryModelProgressInfo: SummaryModelProgressInfo;
  selectedSummaryModel: string;
  recommendedSummaryModel: string;
  databaseExists: boolean;
  isBackgroundDownloading: boolean;
  // Permissions
  permissions: OnboardingPermissions;
  permissionsSkipped: boolean;
  // Navigation
  goToStep: (step: number) => void;
  goNext: () => void;
  goPrevious: () => void;
  // Setters
  setParakeetDownloaded: (value: boolean) => void;
  setSummaryModelDownloaded: (value: boolean) => void;
  setSelectedSummaryModel: (value: string) => void;
  setDatabaseExists: (value: boolean) => void;
  setPermissionStatus: (permission: keyof OnboardingPermissions, status: PermissionStatus) => void;
  setPermissionsSkipped: (skipped: boolean) => void;
  selectSummaryDestination: (destination: SummaryDestination) => void;
  completeOnboarding: (onTranscriptConfigSaved?: () => void) => Promise<void>;
  startBackgroundDownloads: (options: StartBackgroundDownloadsOptions) => Promise<void>;
  retryParakeetDownload: () => Promise<void>;
  retrySummaryModelDownload: () => Promise<void>;
}

interface StartBackgroundDownloadsOptions {
  includeParakeet: boolean;
  includeSummary: boolean;
  summaryModel?: string;
}

const OnboardingContext = createContext<OnboardingContextType | undefined>(undefined);

function initialSummaryDestination(): SummaryDestination {
  if (typeof window === 'undefined') return 'local';
  try {
    return readSummaryDestination(window.localStorage) ?? 'local';
  } catch {
    return 'local';
  }
}

async function isParakeetModelReady(): Promise<boolean> {
  await invoke('parakeet_init');
  const models = await invoke<Array<{ name?: unknown; status?: unknown }>>('parakeet_get_available_models');
  return isExactModelAvailable(models, PARAKEET_MODEL);
}

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const [currentStep, setCurrentStep] = useState(1);
  const [summaryDestination, setSummaryDestination] = useState<SummaryDestination>(initialSummaryDestination);
  const [completed, setCompleted] = useState(false);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [parakeetDownloaded, setParakeetDownloaded] = useState(false);
  const [parakeetProgress, setParakeetProgress] = useState(0);
  const [parakeetProgressInfo, setParakeetProgressInfo] = useState<ParakeetProgressInfo>({
    percent: 0,
    downloadedMb: 0,
    totalMb: 0,
    speedMbps: 0,
  });
  const [summaryModelDownloaded, setSummaryModelDownloaded] = useState(false);
  const [summaryModelProgress, setSummaryModelProgress] = useState(0);
  const [summaryModelProgressInfo, setSummaryModelProgressInfo] = useState<SummaryModelProgressInfo>({
    percent: 0,
    downloadedMb: 0,
    totalMb: 0,
    speedMbps: 0,
  });
  const [selectedSummaryModel, setSelectedSummaryModel] = useState<string>('');
  const [recommendedSummaryModel, setRecommendedSummaryModel] = useState<string>('');
  const [databaseExists, setDatabaseExists] = useState(false);
  const [isBackgroundDownloading, setIsBackgroundDownloading] = useState(false);
  const parakeetDownloadRequestedRef = useRef(false);
  const summaryDownloadRequestedRef = useRef(new Set<string>());
  const downloadStartGateRef = useRef<ReturnType<typeof createDownloadStartGate> | null>(null);
  if (!downloadStartGateRef.current) downloadStartGateRef.current = createDownloadStartGate();

  // Permissions state
  const [permissions, setPermissions] = useState<OnboardingPermissions>({
    microphone: 'not_determined',
    systemAudio: 'not_determined',
    screenRecording: 'not_determined',
  });
  const [permissionsSkipped, setPermissionsSkipped] = useState(false);

  const saveTimeoutRef = useRef<NodeJS.Timeout>();

  const selectSummaryDestination = useCallback((destination: SummaryDestination) => {
    setSummaryDestination(destination);
    if (typeof window !== 'undefined') saveSummaryDestination(window.localStorage, destination);
  }, []);

  const initializeSummaryModelSelection = async (preferredModel = selectedSummaryModel) => {
    try {
      const recommendedModel = await invoke<string>('builtin_ai_get_recommended_model');
      setRecommendedSummaryModel(recommendedModel);
      const modelToCheck = preferredModel || recommendedModel;
      setSelectedSummaryModel(modelToCheck);

      const selectedModelReady = await invoke<boolean>('builtin_ai_is_model_ready', {
        modelName: modelToCheck,
        refresh: true,
      });
      const resolved = resolveOnboardingSummaryModelStatus({
        selectedModel: preferredModel,
        recommendedModel,
        selectedModelReady,
      });

      setSelectedSummaryModel(resolved.selectedSummaryModel);
      setSummaryModelDownloaded(resolved.summaryModelDownloaded);
      setSummaryModelProgressInfo((previous) => ({ ...previous, error: undefined }));
      console.log('[OnboardingContext] Set recommended model:', resolved.selectedSummaryModel);

      return resolved;
    } catch (error) {
      console.error('[OnboardingContext] Failed to initialize summary model:', error);
      return null;
    }
  };

  const requestSummaryModelDownload = useCallback(async (modelName: string) => {
    if (!modelName || summaryDownloadRequestedRef.current.has(modelName)) return;
    summaryDownloadRequestedRef.current.add(modelName);
    setSummaryModelProgressInfo((previous) => ({ ...previous, error: undefined }));
    console.log('[OnboardingContext] Starting Summary Model download');
    try {
      await invoke('builtin_ai_download_model', { modelName });
    } catch (err) {
      if (String(err).includes('Download already in progress')) return;
      summaryDownloadRequestedRef.current.delete(modelName);
      setSummaryModelProgressInfo((previous) => ({ ...previous, error: 'download_failed' }));
      console.error('[OnboardingContext] Summary Model download failed:', err);
      throw err;
    }
  }, []);

  const verifyParakeetReadiness = useCallback(async () => {
    try {
      const ready = await isParakeetModelReady();
      setParakeetDownloaded(ready);
      if (ready) {
        parakeetDownloadRequestedRef.current = false;
        setParakeetProgress(100);
        setParakeetProgressInfo((previous) => ({ ...previous, percent: 100, error: undefined }));
      } else {
        setParakeetProgressInfo((previous) => ({ ...previous, error: previous.error || 'model_not_ready' }));
      }
    } catch (error) {
      setParakeetDownloaded(false);
      setParakeetProgressInfo((previous) => ({ ...previous, error: previous.error || 'model_not_ready' }));
      console.warn('[OnboardingContext] Failed to verify Parakeet readiness:', error);
    }
  }, []);

  const verifySummaryModelReadiness = async (modelName: string) => {
    try {
      const ready = await invoke<boolean>('builtin_ai_is_model_ready', {
        modelName,
        refresh: true,
      });
      setSummaryModelDownloaded(ready);
      if (ready) {
        summaryDownloadRequestedRef.current.delete(modelName);
        setSummaryModelProgress(100);
        setSummaryModelProgressInfo((previous) => ({ ...previous, percent: 100, error: undefined }));
      } else {
        setSummaryModelProgressInfo((previous) => ({ ...previous, error: previous.error || 'model_not_ready' }));
      }
    } catch (error) {
      setSummaryModelDownloaded(false);
      setSummaryModelProgressInfo((previous) => ({ ...previous, error: previous.error || 'model_not_ready' }));
      console.warn('[OnboardingContext] Failed to verify summary model readiness:', error);
    }
  };

  // Load status on mount and initialize database
  useEffect(() => {
    void loadOnboardingStatus().then((loaded) => setStatusLoaded(loaded));
    checkDatabaseStatus();
    initializeDatabaseInBackground();
  }, []);

  // Initialize database silently in background (moved from SetupOverviewStep)
  const initializeDatabaseInBackground = async () => {
    try {
      console.log('[OnboardingContext] Starting background database initialization');
      const isFirstLaunch = await invoke<boolean>('check_first_launch');

      if (!isFirstLaunch) {
        console.log('[OnboardingContext] Database exists, skipping initialization');
        setDatabaseExists(true);
        return;
      }

      // First launch - attempt auto-detection and import
      await performAutoDetection();
    } catch (error) {
      console.error('[OnboardingContext] Database initialization failed:', error);
      // Don't throw - database init failure shouldn't block onboarding
    }
  };

  const performAutoDetection = async () => {
    // Check Homebrew (macOS only)
    if (typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('mac')) {
      const homebrewDbPath = '/usr/local/var/meetily/meeting_minutes.db';
      try {
        const homebrewCheck = await invoke<{ exists: boolean; size: number } | null>(
          'check_homebrew_database',
          { path: homebrewDbPath }
        );

        if (homebrewCheck?.exists) {
          console.log('[OnboardingContext] Found Homebrew database, importing');
          await invoke('import_and_initialize_database', { legacyDbPath: homebrewDbPath });
          setDatabaseExists(true);
          return;
        }
      } catch (e) {
        console.log('[OnboardingContext] Homebrew check failed, continuing:', e);
      }
    }

    // Check default legacy database location
    try {
      const legacyPath = await invoke<string | null>('check_default_legacy_database');
      if (legacyPath) {
        console.log('[OnboardingContext] Found legacy database, importing');
        await invoke('import_and_initialize_database', { legacyDbPath: legacyPath });
        setDatabaseExists(true);
        return;
      }
    } catch (e) {
      console.log('[OnboardingContext] Legacy check failed, continuing:', e);
    }

    // No legacy database found - initialize fresh
    console.log('[OnboardingContext] No legacy database found, initializing fresh');
    await invoke('initialize_fresh_database');
    setDatabaseExists(true);
  };

  const isCompletingRef = useRef(false);

  // Auto-save on state change (debounced)
  useEffect(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    // A delayed native read must never be overwritten by the initial empty state.
    if (!statusLoaded) return;
    // Don't auto-save if completed (to avoid overwriting completion status)
    // Also don't auto-save if we are currently in the process of completing
    if (completed || isCompletingRef.current) return;

    saveTimeoutRef.current = setTimeout(() => {
      saveOnboardingStatus();
    }, 1000);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [currentStep, parakeetDownloaded, summaryModelDownloaded, completed, statusLoaded]);

  // Listen to Parakeet download progress
  useEffect(() => {
    const unlisten = listen<{
      modelName: string;
      progress: number;
      downloaded_mb?: number;
      total_mb?: number;
      speed_mbps?: number;
      status?: string;
    }>(
      'parakeet-model-download-progress',
      (event) => {
        const { modelName, progress, downloaded_mb, total_mb, speed_mbps, status } = event.payload;
        if (modelName === PARAKEET_MODEL) {
          setParakeetProgress(progress);
          setParakeetProgressInfo({
            percent: progress,
            downloadedMb: downloaded_mb ?? 0,
            totalMb: total_mb ?? 0,
            speedMbps: speed_mbps ?? 0,
            error: status === 'error' ? 'download_failed' : undefined,
          });
          if (status === 'completed' || progress >= 100) {
            void verifyParakeetReadiness();
          }
        }
      }
    );

    const unlistenComplete = listen<{ modelName: string }>(
      'parakeet-model-download-complete',
      (event) => {
        const { modelName } = event.payload;
        if (modelName === PARAKEET_MODEL) {
          void verifyParakeetReadiness();
        }
      }
    );

    const unlistenError = listen<{ modelName: string; error: string }>(
      'parakeet-model-download-error',
      (event) => {
        const { modelName } = event.payload;
        if (modelName === PARAKEET_MODEL) {
          parakeetDownloadRequestedRef.current = false;
          setParakeetProgressInfo((previous) => ({ ...previous, error: 'download_failed' }));
          console.error('Parakeet download error:', event.payload.error);
        }
      }
    );

    return () => {
      unlisten.then(fn => fn());
      unlistenComplete.then(fn => fn());
      unlistenError.then(fn => fn());
    };
  }, [verifyParakeetReadiness]);

  // Listen to summary model (Built-in AI) download progress
  useEffect(() => {
    const unlisten = listen<{
      model: string;
      progress: number;
      downloaded_mb?: number;
      total_mb?: number;
      speed_mbps?: number;
      status: string;
    }>(
      'builtin-ai-download-progress',
      (event) => {
        const { model, progress, downloaded_mb, total_mb, speed_mbps, status } = event.payload;
        if (selectedSummaryModel && model === selectedSummaryModel) {
          setSummaryModelProgress(progress);
          setSummaryModelProgressInfo({
            percent: progress,
            downloadedMb: downloaded_mb ?? 0,
            totalMb: total_mb ?? 0,
            speedMbps: speed_mbps ?? 0,
            error: status === 'error' ? 'download_failed' : undefined,
          });
          if (status === 'completed' || progress >= 100) {
            void verifySummaryModelReadiness(model);
          }
        }
      }
    );

    return () => {
      unlisten.then(fn => fn());
    };
  }, [selectedSummaryModel]);

  const checkDatabaseStatus = async () => {
    try {
      const isFirstLaunch = await invoke<boolean>('check_first_launch');
      setDatabaseExists(!isFirstLaunch);
      console.log('[OnboardingContext] Database exists:', !isFirstLaunch);
    } catch (error) {
      console.error('[OnboardingContext] Failed to check database status:', error);
      setDatabaseExists(false);
    }
  };

  const loadOnboardingStatus = async (): Promise<boolean> => {
    try {
      const status = await invoke<OnboardingStatus | null>('get_onboarding_status');
      if (!readSummaryDestination(window.localStorage)) {
        try {
          const savedConfig = await invoke<ModelConfig | null>('api_get_model_config');
          if (savedConfig?.provider === 'openai-codex') {
            setSummaryDestination('chatgpt');
            saveSummaryDestination(window.localStorage, 'chatgpt');
          }
        } catch {
          // Provider choice remains local by default until the user selects it.
        }
      }
      if (status) {
        console.log('[OnboardingContext] Loaded saved status:', status);
        const progress = resolveOnboardingProgress(status);

        if (status.completed) {
          setCurrentStep(progress.currentStep);
          setCompleted(true);
          setParakeetDownloaded(status.model_status.parakeet === 'downloaded');
          setSummaryModelDownloaded(status.model_status.summary === 'downloaded');
          if (status.model_status.selected_summary_model) {
            setSelectedSummaryModel(status.model_status.selected_summary_model);
          }
          console.log('[OnboardingContext] Restored completed onboarding status without model verification');
          return true;
        }

        // Don't trust saved status - verify actual model status on disk
        const verifiedStatus = await verifyModelStatus(status);

        setCurrentStep(verifiedStatus.currentStep);
        setCompleted(verifiedStatus.completed);
        setParakeetDownloaded(verifiedStatus.parakeetDownloaded);
        setSummaryModelDownloaded(verifiedStatus.summaryModelDownloaded);
        if (verifiedStatus.selectedSummaryModel) {
          setSelectedSummaryModel(verifiedStatus.selectedSummaryModel);
        }

        console.log('[OnboardingContext] Verified status:', verifiedStatus);

        // Check if any downloads are active to restore isBackgroundDownloading state
        await checkActiveDownloads();
      } else {
        await initializeSummaryModelSelection();
      }
      return true;
    } catch (error) {
      console.error('[OnboardingContext] Failed to load onboarding status:', error);
      return false;
    }
  };

  // Verify that models actually exist on disk, not just trust saved JSON
  const verifyModelStatus = async (savedStatus: OnboardingStatus) => {
    let parakeetDownloaded = false;
    let summaryModelDownloaded = false;
    let selectedSummaryModel = '';

    // Verify Parakeet model exists on disk
    try {
      parakeetDownloaded = await isParakeetModelReady();
      console.log('[OnboardingContext] Parakeet verified on disk:', parakeetDownloaded);
    } catch (error) {
      console.warn('[OnboardingContext] Failed to verify Parakeet:', error);
      parakeetDownloaded = false;
    }

    // Verify the selected/recommended Summary model exists on disk.
    try {
      const recommendedModel = await invoke<string>('builtin_ai_get_recommended_model');
      setRecommendedSummaryModel(recommendedModel);
      // New onboarding uses the built-in recommendation, not an obsolete
      // selection left behind by the four-step wizard.
      const modelToCheck = recommendedModel;
      const selectedModelReady = await invoke<boolean>('builtin_ai_is_model_ready', {
        modelName: modelToCheck,
        refresh: true,
      });
      const resolved = resolveOnboardingSummaryModelStatus({
        selectedModel: modelToCheck,
        recommendedModel,
        selectedModelReady,
      });
      selectedSummaryModel = resolved.selectedSummaryModel;
      summaryModelDownloaded = resolved.summaryModelDownloaded;
      console.log('[OnboardingContext] Summary model verified on disk:', summaryModelDownloaded, 'model:', selectedSummaryModel);
    } catch (error) {
      console.warn('[OnboardingContext] Failed to verify Summary model:', error);
      summaryModelDownloaded = false;
    }

    const progress = resolveOnboardingProgress(savedStatus);

    // Trust the completed status - don't revert based on model downloads
    // Downloads continue in background; user stays in main app regardless
    return {
      currentStep: progress.currentStep,
      completed: progress.completed,
      parakeetDownloaded,
      summaryModelDownloaded,
      selectedSummaryModel,
    };
  };

  const saveOnboardingStatus = async () => {
    // Safety check: if we are in the process of completing, DO NOT save
    // This prevents a race condition where a download completion event triggers a save
    // that overwrites the "completed" status set by completeOnboarding
    if (isCompletingRef.current) {
      console.log('[OnboardingContext] Skipping saveOnboardingStatus because completion is in progress');
      return;
    }

    try {
      await invoke('save_onboarding_status_cmd', {
        status: {
          version: ONBOARDING_STATUS_VERSION,
          completed: completed,
          current_step: Math.max(1, Math.min(currentStep, 2)),
          model_status: {
            parakeet: parakeetDownloaded ? 'downloaded' : 'not_downloaded',
            summary: summaryModelDownloaded ? 'downloaded' : 'not_downloaded',
            selected_summary_model: selectedSummaryModel || undefined,
          },
          last_updated: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error('[OnboardingContext] Failed to save onboarding status:', error);
    }
  };

  const completeOnboarding = async (onTranscriptConfigSaved?: () => void) => {
    try {
      // Set completion flag to prevent race conditions with auto-save
      isCompletingRef.current = true;

      // Clear any pending auto-saves
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = undefined;
      }

      const expectedProvider = summaryDestination === 'local' ? 'builtin-ai' : 'openai-codex';
      const savedConfig = await invoke<ModelConfig | null>('api_get_model_config');
      if (!savedConfig?.model?.trim() || savedConfig.provider !== expectedProvider) {
        throw new Error('Save the selected summary provider before finishing setup.');
      }

      const modelToCheck = summaryDestination === 'local'
        ? recommendedSummaryModel || selectedSummaryModel
        : savedConfig.model;
      if (!modelToCheck || (summaryDestination === 'local' && savedConfig.model !== modelToCheck)) {
        throw new Error('The saved summary model no longer matches your choice. Go back and confirm your summary setup.');
      }

      let hasExplicitApproval = false;
      try {
        hasExplicitApproval = typeof window !== 'undefined' && hasSavedSummaryApproval(
          window.localStorage,
          savedConfig.provider,
          savedConfig.model,
          savedConfig.ollamaEndpoint,
        );
      } catch {
        hasExplicitApproval = false;
      }
      if (!hasExplicitApproval) {
        throw new Error('Confirm your summary destination on the first step before finishing setup.');
      }

      let selectedModelReady = false;
      if (summaryDestination === 'local') {
        try {
          selectedModelReady = await invoke<boolean>('builtin_ai_is_model_ready', {
            modelName: savedConfig.model,
            refresh: true,
          });
        } catch {
          selectedModelReady = false;
        }
        setSummaryModelDownloaded(selectedModelReady);
        setSummaryModelProgressInfo((previous) => ({
          ...previous,
          error: selectedModelReady ? undefined : 'model_not_ready',
        }));
        if (!selectedModelReady) {
          throw new Error(`The selected local summary model (${savedConfig.model}) is not ready yet. Wait for it to finish or retry its download.`);
        }
      }

      let transcriptionModelReady = false;
      try {
        transcriptionModelReady = await isParakeetModelReady();
      } catch {
        transcriptionModelReady = false;
      }
      setParakeetDownloaded(transcriptionModelReady);
      setParakeetProgressInfo((previous) => ({
        ...previous,
        error: transcriptionModelReady ? undefined : 'model_not_ready',
      }));
      if (!onboardingModelsReady(summaryDestination, transcriptionModelReady, selectedModelReady)) {
        throw new Error(`The selected transcription model (${PARAKEET_MODEL}) is not ready yet. Wait for it to finish or retry its download.`);
      }

      await invoke('api_save_transcript_config', {
        provider: 'parakeet',
        model: PARAKEET_MODEL,
      });
      const savedTranscriptConfig = await invoke<{ provider?: string; model?: string } | null>('api_get_transcript_config');
      if (savedTranscriptConfig?.provider !== 'parakeet' || savedTranscriptConfig.model !== PARAKEET_MODEL) {
        throw new Error('The transcription model could not be verified after saving. Retry setup before continuing.');
      }
      onTranscriptConfigSaved?.();

      await invoke('save_onboarding_status_cmd', {
        status: {
          version: ONBOARDING_STATUS_VERSION,
          completed: true,
          current_step: 2,
          model_status: {
            parakeet: transcriptionModelReady ? 'downloaded' : 'not_downloaded',
            summary: summaryDestination === 'local' && selectedModelReady ? 'downloaded' : 'not_downloaded',
            selected_summary_model: modelToCheck || undefined,
          },
          last_updated: new Date().toISOString(),
        },
      });

      setCompleted(true);
      setCurrentStep(2);
      console.log('[OnboardingContext] Onboarding completed with provider:', expectedProvider);

      // Reset the flag so subsequent state updates can be saved
      isCompletingRef.current = false;
    } catch (error) {
      console.error('[OnboardingContext] Failed to complete onboarding:', error);
      isCompletingRef.current = false; // Reset flag on error
      throw error; // Re-throw so PermissionsStep can handle it
    }
  };

  // Start background downloads at most once for each concrete model target.
  // Failures remain visible but cannot make a render-driven effect retry itself.
  const startBackgroundDownloads = useCallback(async ({
    includeParakeet,
    includeSummary,
    summaryModel,
  }: StartBackgroundDownloadsOptions) => {
    console.log('[OnboardingContext] Starting background downloads:', {
      includeParakeet,
      includeSummary,
      summaryModel,
    });

    if (includeParakeet && !parakeetDownloaded && !parakeetDownloadRequestedRef.current) {
      const start = downloadStartGateRef.current!.startOnce(`parakeet:${PARAKEET_MODEL}`, async () => {
        parakeetDownloadRequestedRef.current = true;
        setParakeetProgressInfo((previous) => ({ ...previous, error: undefined }));
        console.log('[OnboardingContext] Starting Parakeet download');
        try {
          await invoke('parakeet_download_model', { modelName: PARAKEET_MODEL });
        } catch (err) {
          parakeetDownloadRequestedRef.current = false;
          setParakeetProgressInfo((previous) => ({ ...previous, error: 'download_failed' }));
          console.error('[OnboardingContext] Parakeet download failed:', err);
          throw err;
        }
      });
      if (start) {
        setIsBackgroundDownloading(true);
        void start.catch(() => undefined);
      }
    }

    if (includeSummary && !summaryModelDownloaded && summaryModel) {
      const start = downloadStartGateRef.current!.startOnce(`builtin-ai:${summaryModel}`, () => requestSummaryModelDownload(summaryModel));
      if (start) {
        setIsBackgroundDownloading(true);
        void start.catch(() => undefined);
      }
    } else if (includeSummary && !summaryModelDownloaded && !summaryModel) {
      console.warn('[OnboardingContext] Summary Model download skipped until recommendation is loaded');
    }
  }, [parakeetDownloaded, requestSummaryModelDownload, summaryModelDownloaded]);

  // Check if any models are currently downloading (for re-entry)
  const checkActiveDownloads = async () => {
    try {
      const models = await invoke<any[]>('parakeet_get_available_models');
      const isDownloading = models.some(m => m.status && (typeof m.status === 'object' ? 'Downloading' in m.status : m.status === 'Downloading'));
      
      if (isDownloading) {
        console.log('[OnboardingContext] Detected active background downloads on mount');
        setIsBackgroundDownloading(true);
      }
      
      // Also check for Built-in AI downloads if possible (though less critical as Parakeet is the main blocker)
      
    } catch (error) {
      console.warn('[OnboardingContext] Failed to check active downloads:', error);
    }
  };

  const retryParakeetDownload = async () => {
    console.log('[OnboardingContext] Retrying Parakeet download');
    parakeetDownloadRequestedRef.current = true;
    setParakeetProgressInfo((previous) => ({ ...previous, error: undefined }));
    try {
      await downloadStartGateRef.current!.retry(() => invoke('parakeet_retry_download', { modelName: PARAKEET_MODEL }));
    } catch (error) {
      parakeetDownloadRequestedRef.current = false;
      setParakeetProgressInfo((previous) => ({ ...previous, error: 'download_failed' }));
      console.error('[OnboardingContext] Retry failed:', error);
      throw error;
    }
  };

  const retrySummaryModelDownload = async () => {
    const modelName = recommendedSummaryModel || selectedSummaryModel;
    if (!modelName) throw new Error('The recommended summary model is not available yet.');
    summaryDownloadRequestedRef.current.delete(modelName);
    setSummaryModelProgressInfo((previous) => ({ ...previous, error: undefined }));
    try {
      await downloadStartGateRef.current!.retry(() => requestSummaryModelDownload(modelName));
    } catch (error) {
      throw error;
    }
  };

  const setPermissionStatus = useCallback((permission: keyof OnboardingPermissions, status: PermissionStatus) => {
    setPermissions((prev: OnboardingPermissions) => ({
      ...prev,
      [permission]: status,
    }));
  }, []);

  const goToStep = useCallback((step: number) => {
    setCurrentStep(Math.max(1, Math.min(step, 2)));
  }, []);

  const goNext = useCallback(() => {
    setCurrentStep((prev: number) => {
      const next = prev + 1;
      return Math.min(next, 2);
    });
  }, []);

  const goPrevious = useCallback(() => {
    setCurrentStep((prev: number) => {
      const previous = prev - 1;
      // Don't go below step 1
      return Math.max(previous, 1);
    });
  }, []);

  return (
    <OnboardingContext.Provider
      value={{
        currentStep,
        summaryDestination,
        parakeetDownloaded,
        parakeetProgress,
        parakeetProgressInfo,
        summaryModelDownloaded,
        summaryModelProgress,
        summaryModelProgressInfo,
        selectedSummaryModel,
        recommendedSummaryModel,
        databaseExists,
        isBackgroundDownloading,
        permissions,
        permissionsSkipped,
        goToStep,
        goNext,
        goPrevious,
        setParakeetDownloaded,
        setSummaryModelDownloaded,
        setSelectedSummaryModel,
        setDatabaseExists,
        setPermissionStatus,
        setPermissionsSkipped,
        selectSummaryDestination,
        completeOnboarding,
        startBackgroundDownloads,
        retryParakeetDownload,
        retrySummaryModelDownload,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error('useOnboarding must be used within OnboardingProvider');
  }
  return context;
}
