'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ONBOARDING_STATUS_VERSION,
  hasSavedSummaryApproval,
  readSummaryDestination,
  resolveOnboardingProgress,
  saveSummaryDestination,
  type SummaryDestination,
} from '@/lib/onboarding-setup';
import type { ModelConfig } from '@/services/configService';

const TOTAL_STEPS = 3;

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

interface OnboardingContextType {
  currentStep: number;
  summaryDestination: SummaryDestination;
  selectedLanguage: string;
  databaseExists: boolean;
  // Navigation
  goToStep: (step: number) => void;
  goNext: () => void;
  goPrevious: () => void;
  // Setters
  setSelectedLanguage: React.Dispatch<React.SetStateAction<string>>;
  setDatabaseExists: (value: boolean) => void;
  selectSummaryDestination: (destination: SummaryDestination) => void;
  completeOnboarding: (onTranscriptConfigSaved?: () => void) => Promise<void>;
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

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const [currentStep, setCurrentStep] = useState(1);
  const [summaryDestination, setSummaryDestination] = useState<SummaryDestination>(initialSummaryDestination);
  const [selectedLanguage, setSelectedLanguage] = useState('');
  const [completed, setCompleted] = useState(false);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [databaseExists, setDatabaseExists] = useState(false);

  const saveTimeoutRef = useRef<NodeJS.Timeout>();

  const selectSummaryDestination = useCallback((destination: SummaryDestination) => {
    setSummaryDestination(destination);
    if (typeof window !== 'undefined') saveSummaryDestination(window.localStorage, destination);
  }, []);

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

  // Auto-save progress on state change (debounced). Never runs once completed.
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
  }, [currentStep, summaryDestination, completed, statusLoaded]);

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
        setCurrentStep(progress.currentStep);
        setCompleted(progress.completed);
      }
      return true;
    } catch (error) {
      console.error('[OnboardingContext] Failed to load onboarding status:', error);
      return false;
    }
  };

  const saveOnboardingStatus = async () => {
    // Safety check: if we are in the process of completing, DO NOT save
    // This prevents a race condition where a late render triggers a save
    // that overwrites the "completed" status set by completeOnboarding
    if (isCompletingRef.current) {
      console.log('[OnboardingContext] Skipping saveOnboardingStatus because completion is in progress');
      return;
    }

    try {
      await invoke('save_onboarding_status_cmd', {
        status: {
          version: ONBOARDING_STATUS_VERSION,
          completed,
          current_step: Math.max(1, Math.min(currentStep, TOTAL_STEPS)),
          // Apple Intelligence and Apple Speech need no download, so there is
          // nothing to track here anymore; the fields are kept for schema
          // compatibility with previously saved onboarding status.
          model_status: {
            parakeet: 'not_applicable',
            summary: 'not_applicable',
            selected_summary_model: summaryDestination === 'chatgpt' ? 'openai-codex' : 'apple-intelligence',
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

      const expectedProvider = summaryDestination === 'local' ? 'apple-intelligence' : 'openai-codex';
      const savedConfig = await invoke<ModelConfig | null>('api_get_model_config');
      if (!savedConfig?.model?.trim() || savedConfig.provider !== expectedProvider) {
        throw new Error('Save the selected summary provider before finishing setup.');
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

      if (!selectedLanguage) {
        throw new Error('Choose a spoken language before finishing setup.');
      }

      await invoke('api_save_transcript_config', {
        provider: 'appleSpeech',
        model: selectedLanguage,
      });
      const savedTranscriptConfig = await invoke<{ provider?: string; model?: string } | null>('api_get_transcript_config');
      if (savedTranscriptConfig?.provider !== 'appleSpeech' || savedTranscriptConfig.model !== selectedLanguage) {
        throw new Error('The spoken language could not be verified after saving. Retry setup before continuing.');
      }
      onTranscriptConfigSaved?.();

      await invoke('save_onboarding_status_cmd', {
        status: {
          version: ONBOARDING_STATUS_VERSION,
          completed: true,
          current_step: TOTAL_STEPS,
          model_status: {
            parakeet: 'not_applicable',
            summary: 'not_applicable',
            selected_summary_model: expectedProvider,
          },
          last_updated: new Date().toISOString(),
        },
      });

      setCompleted(true);
      setCurrentStep(TOTAL_STEPS);
      console.log('[OnboardingContext] Onboarding completed with provider:', expectedProvider);

      // Reset the flag so subsequent state updates can be saved
      isCompletingRef.current = false;
    } catch (error) {
      console.error('[OnboardingContext] Failed to complete onboarding:', error);
      isCompletingRef.current = false; // Reset flag on error
      throw error; // Re-throw so PermissionsStep can handle it
    }
  };

  const goToStep = useCallback((step: number) => {
    setCurrentStep(Math.max(1, Math.min(step, TOTAL_STEPS)));
  }, []);

  const goNext = useCallback(() => {
    setCurrentStep((prev: number) => Math.min(prev + 1, TOTAL_STEPS));
  }, []);

  const goPrevious = useCallback(() => {
    setCurrentStep((prev: number) => Math.max(prev - 1, 1));
  }, []);

  return (
    <OnboardingContext.Provider
      value={{
        currentStep,
        summaryDestination,
        selectedLanguage,
        databaseExists,
        goToStep,
        goNext,
        goPrevious,
        setSelectedLanguage,
        setDatabaseExists,
        selectSummaryDestination,
        completeOnboarding,
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
