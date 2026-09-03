'use client';

import { useEffect, useMemo, useState } from 'react';
import { Moon, Monitor, Sun } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useConfig, type NotificationSettings } from '@/contexts/ConfigContext';
import SettingRow from './SettingRow';

export type AppearancePreference = 'system' | 'light' | 'dark';
const APPEARANCE_KEY = 'meetodds.appearance';

function readAppearance(): AppearancePreference {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(APPEARANCE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function applyAppearance(preference: AppearancePreference) {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
  window.localStorage.setItem(APPEARANCE_KEY, preference);
}

const appearanceOptions: Array<{
  value: AppearancePreference;
  label: string;
  icon: typeof Monitor;
}> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

export default function GeneralSettings() {
  const {
    notificationSettings,
    isLoadingPreferences,
    loadPreferences,
    updateNotificationSettings,
  } = useConfig();
  const [appearance, setAppearance] = useState<AppearancePreference>('system');
  const [updatingNotifications, setUpdatingNotifications] = useState(false);

  useEffect(() => {
    setAppearance(readAppearance());
    void loadPreferences();
  }, [loadPreferences]);

  const notificationsEnabled = useMemo(() => {
    if (!notificationSettings) return true;
    const preferences = notificationSettings.notification_preferences;
    return preferences.show_recording_started && preferences.show_recording_stopped;
  }, [notificationSettings]);

  const changeAppearance = (next: AppearancePreference) => {
    setAppearance(next);
    applyAppearance(next);
  };

  const setNotifications = async (enabled: boolean) => {
    if (!notificationSettings || updatingNotifications) return;
    setUpdatingNotifications(true);
    const next: NotificationSettings = {
      ...notificationSettings,
      notification_preferences: {
        ...notificationSettings.notification_preferences,
        show_recording_started: enabled,
        show_recording_stopped: enabled,
      },
    };
    try {
      await updateNotificationSettings(next);
    } finally {
      setUpdatingNotifications(false);
    }
  };

  return (
    <div>
      <SettingRow
        label="Appearance"
        description="Follow macOS automatically, or keep MeetOdds in a fixed light or dark appearance."
        control={(
          <div className="inline-flex rounded-control border border-border bg-bg p-0.5">
            {appearanceOptions.map((option) => {
              const Icon = option.icon;
              const selected = appearance === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => changeAppearance(option.value)}
                  aria-pressed={selected}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-caption font-medium transition-colors duration-150 ${selected ? 'bg-surface text-text shadow-sm' : 'text-3 hover:text-text'}`}
                >
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {option.label}
                </button>
              );
            })}
          </div>
        )}
      />

      <SettingRow
        label="Meeting notifications"
        description="Show desktop notifications when recording starts and when a meeting stops."
        control={(
          <Switch
            checked={notificationsEnabled}
            onCheckedChange={(checked) => void setNotifications(checked)}
            disabled={isLoadingPreferences || updatingNotifications || !notificationSettings}
          />
        )}
      />

      <SettingRow
        label="Keep running in the menu bar"
        description="Closing the main window keeps MeetOdds available from the menu bar. This is currently always on."
        control={<Switch checked disabled />}
      />
    </div>
  );
}
