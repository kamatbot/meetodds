'use client';

import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { DeviceSelection, type SelectedDevices } from '@/components/DeviceSelection';
import SettingRow from '@/components/Settings/SettingRow';
import Analytics from '@/lib/analytics';

export interface RecordingPreferences {
  save_folder: string;
  auto_save: boolean;
  file_format: string;
  preferred_mic_device: string | null;
  preferred_system_device: string | null;
}

interface RecordingSettingsProps {
  onSave?: (preferences: RecordingPreferences) => void;
}

export function RecordingSettings({ onSave }: RecordingSettingsProps) {
  const [preferences, setPreferences] = useState<RecordingPreferences>({
    save_folder: '',
    auto_save: true,
    file_format: 'mp4',
    preferred_mic_device: null,
    preferred_system_device: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showRecordingNotification, setShowRecordingNotification] = useState(true);

  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
        setPreferences(prefs);
      } catch (error) {
        console.error('Failed to load recording preferences:', error);
        try {
          const defaultPath = await invoke<string>('get_default_recordings_folder_path');
          setPreferences((current) => ({ ...current, save_folder: defaultPath }));
        } catch (defaultError) {
          console.error('Failed to get default folder path:', defaultError);
        }
      } finally {
        setLoading(false);
      }
    };

    void loadPreferences();
  }, []);

  useEffect(() => {
    const loadNotificationPref = async () => {
      try {
        const { Store } = await import('@tauri-apps/plugin-store');
        const store = await Store.load('preferences.json');
        const show = await store.get<boolean>('show_recording_notification') ?? true;
        setShowRecordingNotification(show);
      } catch (error) {
        console.error('Failed to load notification preference:', error);
      }
    };
    void loadNotificationPref();
  }, []);

  const savePreferences = async (next: RecordingPreferences, successToast = false) => {
    setSaving(true);
    try {
      await invoke('set_recording_preferences', { preferences: next });
      onSave?.(next);
      if (successToast) toast.success('Recording preferences saved');
    } catch (error) {
      console.error('Failed to save recording preferences:', error);
      toast.error('Failed to save recording preferences', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleAutoSaveToggle = async (enabled: boolean) => {
    const next = { ...preferences, auto_save: enabled };
    setPreferences(next);
    await savePreferences(next);
    await Analytics.track('auto_save_recording_toggled', { enabled: enabled.toString() });
  };

  const handleDeviceChange = async (devices: SelectedDevices) => {
    const next = {
      ...preferences,
      preferred_mic_device: devices.micDevice,
      preferred_system_device: devices.systemDevice,
    };
    setPreferences(next);
    await savePreferences(next);
    await Analytics.track('default_devices_changed', {
      has_preferred_microphone: (!!devices.micDevice).toString(),
      has_preferred_system_audio: (!!devices.systemDevice).toString(),
    });
  };

  const handleOpenFolder = async () => {
    try {
      await invoke('open_recordings_folder');
    } catch (error) {
      console.error('Failed to open recordings folder:', error);
      toast.error('Could not open recordings folder');
    }
  };

  const handleNotificationToggle = async (enabled: boolean) => {
    try {
      setShowRecordingNotification(enabled);
      const { Store } = await import('@tauri-apps/plugin-store');
      const store = await Store.load('preferences.json');
      await store.set('show_recording_notification', enabled);
      await store.save();
      await Analytics.track('recording_notification_preference_changed', {
        enabled: enabled.toString(),
      });
    } catch (error) {
      console.error('Failed to save notification preference:', error);
      setShowRecordingNotification((current) => !current);
      toast.error('Failed to save preference');
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 py-2" aria-label="Loading recording settings">
        <div className="h-12 animate-pulse rounded-control bg-surface" />
        <div className="h-12 animate-pulse rounded-control bg-surface" />
        <div className="h-24 animate-pulse rounded-control bg-surface" />
      </div>
    );
  }

  return (
    <div>
      <SettingRow
        label="Save audio recordings"
        description="Keep the final meeting recording after transcription."
        control={(
          <Switch
            checked={preferences.auto_save}
            onCheckedChange={(checked) => void handleAutoSaveToggle(checked)}
            disabled={saving}
          />
        )}
      />

      <SettingRow
        label="Recording folder"
        description={preferences.auto_save
          ? (preferences.save_folder || 'Default recording folder')
          : 'Audio saving is currently off.'}
        control={(
          <button
            type="button"
            onClick={() => void handleOpenFolder()}
            disabled={!preferences.auto_save}
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-bg px-2.5 text-ui font-medium text-text hover:bg-surface disabled:opacity-40"
          >
            <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.75} /> Open
          </button>
        )}
      />

      <SettingRow
        label="Recording format"
        description="Final saved-audio container used for meeting playback and export."
        control={(
          <span className="inline-flex h-8 items-center rounded-control border border-border bg-bg px-2.5 font-mono text-caption uppercase text-2">
            {preferences.file_format}
          </span>
        )}
      />

      <SettingRow
        label="Participant reminder"
        description="Show the existing recording-start reminder used to help inform participants."
        control={(
          <Switch
            checked={showRecordingNotification}
            onCheckedChange={(checked) => void handleNotificationToggle(checked)}
          />
        )}
      />

      <SettingRow
        label="Audio devices"
        description="Choose the preferred microphone and system-audio source for new recordings."
        align="start"
        control={<span className="text-caption text-3">Changes save immediately</span>}
      >
        <div className="rounded-card border border-border bg-surface p-3">
          <DeviceSelection
            selectedDevices={{
              micDevice: preferences.preferred_mic_device,
              systemDevice: preferences.preferred_system_device,
            }}
            onDeviceChange={(devices) => void handleDeviceChange(devices)}
            disabled={saving}
          />
        </div>
      </SettingRow>
    </div>
  );
}
