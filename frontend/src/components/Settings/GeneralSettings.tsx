'use client';

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CalendarDays, ChevronRight, LoaderCircle, Moon, Monitor, Sun } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useCalendarAwareness } from '@/contexts/CalendarAwarenessContext';
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
  const calendar = useCalendarAwareness();
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

  const calendarStatus = calendar.permission?.status;
  const calendarControl = !calendar.permission || calendar.isLoading ? (
    <span className="inline-flex h-8 items-center gap-2 text-caption text-3"><LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />Checking…</span>
  ) : calendarStatus === 'unsupported' ? (
    <span className="text-caption text-3">macOS only</span>
  ) : calendarStatus === 'authorized' ? (
    <Switch checked={calendar.enabled} onCheckedChange={calendar.setEnabled} />
  ) : calendarStatus === 'notDetermined' ? (
    <button type="button" onClick={() => void calendar.requestAccess()} className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-3 text-caption font-medium text-text hover:bg-bg"><CalendarDays className="h-3.5 w-3.5" />Connect</button>
  ) : (
    <button type="button" onClick={() => void invoke('open_system_settings', { preference_pane: 'Privacy_Calendars' })} className="inline-flex h-8 items-center gap-1 rounded-control border border-border bg-surface px-3 text-caption font-medium text-text hover:bg-bg">System Settings <ChevronRight className="h-3 w-3" /></button>
  );

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
        label="Calendar awareness"
        description="Read nearby Apple Calendar events on this Mac to surface the next meeting, use its title, and remind you when MeetOdds is ready. MeetOdds never starts recording automatically."
        control={calendarControl}
      >
        {calendar.error && <p role="alert" className="text-caption text-danger">{calendar.error}</p>}
        {calendarStatus === 'authorized' && <p className="text-caption leading-5 text-3">Calendar details remain local. Starting a detected meeting is still an explicit click so recording consent stays under your control.</p>}
      </SettingRow>

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
