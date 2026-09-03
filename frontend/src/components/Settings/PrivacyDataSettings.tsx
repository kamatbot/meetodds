'use client';

import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen } from 'lucide-react';
import AnalyticsConsentSwitch from '@/components/AnalyticsConsentSwitch';
import { useConfig } from '@/contexts/ConfigContext';
import SettingRow from './SettingRow';

const openButtonClass = 'inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-bg px-2.5 text-ui font-medium text-text transition-colors duration-150 hover:bg-surface';

export default function PrivacyDataSettings() {
  const {
    storageLocations,
    isLoadingPreferences,
    loadPreferences,
  } = useConfig();

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  const openLocation = async (type: 'database' | 'models' | 'recordings') => {
    if (type === 'database') await invoke('open_database_folder');
    if (type === 'models') await invoke('open_models_folder');
    if (type === 'recordings') await invoke('open_recordings_folder');
  };

  return (
    <div>
      <SettingRow
        label="Database"
        description={storageLocations?.database || (isLoadingPreferences ? 'Loading storage location…' : 'Application database and local metadata')}
        control={(
          <button type="button" onClick={() => void openLocation('database')} className={openButtonClass}>
            <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.75} /> Open
          </button>
        )}
      />

      <SettingRow
        label="Models"
        description={storageLocations?.models || (isLoadingPreferences ? 'Loading storage location…' : 'Downloaded transcription and local AI models')}
        control={(
          <button type="button" onClick={() => void openLocation('models')} className={openButtonClass}>
            <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.75} /> Open
          </button>
        )}
      />

      <SettingRow
        label="Recordings"
        description={storageLocations?.recordings || (isLoadingPreferences ? 'Loading storage location…' : 'Saved meeting audio files')}
        control={(
          <button type="button" onClick={() => void openLocation('recordings')} className={openButtonClass}>
            <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.75} /> Open
          </button>
        )}
      />

      <div className="border-b border-border py-4 last:border-b-0">
        <AnalyticsConsentSwitch />
      </div>
    </div>
  );
}
