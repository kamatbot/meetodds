'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import AnalyticsConsentSwitch from '@/components/AnalyticsConsentSwitch';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConfig } from '@/contexts/ConfigContext';
import SettingRow from './SettingRow';

/** Model files downloaded by older versions (Whisper, Parakeet, built-in summary model). */
interface LegacyModelsUsage {
  bytes: number;
  items: { kind: string; path: string; bytes: number }[];
}

const formatSize = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

const openButtonClass = 'inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-bg px-2.5 text-ui font-medium text-text transition-colors duration-150 hover:bg-surface';

export default function PrivacyDataSettings() {
  const {
    storageLocations,
    isLoadingPreferences,
    loadPreferences,
  } = useConfig();

  const [legacyModels, setLegacyModels] = useState<LegacyModelsUsage | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletingLegacy, setDeletingLegacy] = useState(false);

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  const loadLegacyModels = useCallback(async () => {
    try {
      setLegacyModels(await invoke<LegacyModelsUsage>('api_legacy_models_usage'));
    } catch {
      setLegacyModels(null);
    }
  }, []);

  useEffect(() => {
    void loadLegacyModels();
  }, [loadLegacyModels]);

  const deleteLegacyModels = async () => {
    setDeletingLegacy(true);
    try {
      const freed = await invoke<number>('api_delete_legacy_models');
      toast.success(`Freed ${formatSize(freed)}`);
    } catch (error) {
      toast.error('Could not delete old models', { description: String(error) });
    } finally {
      setDeletingLegacy(false);
      setConfirmDelete(false);
      void loadLegacyModels();
    }
  };

  const openLocation = async (type: 'database' | 'recordings') => {
    if (type === 'database') await invoke('open_database_folder');
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

      {legacyModels && legacyModels.bytes > 0 && (
        <SettingRow
          label={`Downloaded models from older versions · ${formatSize(legacyModels.bytes)}`}
          description="Whisper, Parakeet and built-in summary model files are no longer used. Meetings, recordings and transcripts are not affected."
          control={(
            <button type="button" onClick={() => setConfirmDelete(true)} disabled={deletingLegacy} className={openButtonClass}>
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} /> Delete
            </button>
          )}
        />
      )}

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

      <Dialog open={confirmDelete} onOpenChange={(open) => { if (!deletingLegacy) setConfirmDelete(open); }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Delete old models?</DialogTitle>
            <DialogDescription>
              This permanently deletes {legacyModels ? formatSize(legacyModels.bytes) : ''} of model files downloaded by older versions. Meetings, recordings and transcripts are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={deletingLegacy}>Cancel</Button>
            <Button variant="destructive" onClick={() => void deleteLegacyModels()} disabled={deletingLegacy}>
              {deletingLegacy ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
