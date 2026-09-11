import { invoke } from '@tauri-apps/api/core';

export type CalendarPermission = 'notDetermined' | 'restricted' | 'denied' | 'authorized' | 'writeOnly' | 'unsupported' | 'unknown';

export interface CalendarPermissionStatus {
  supported: boolean;
  status: CalendarPermission;
}

export interface CalendarEvent {
  id: string;
  title: string;
  startAtMs: number;
  endAtMs: number;
  allDay: boolean;
  location?: string | null;
  calendarName?: string | null;
  conferenceUrl?: string | null;
  attendeeCount: number;
}

export const calendarService = {
  permissionStatus(): Promise<CalendarPermissionStatus> {
    return invoke<CalendarPermissionStatus>('calendar_get_permission_status');
  },
  requestAccess(): Promise<CalendarPermissionStatus> {
    return invoke<CalendarPermissionStatus>('calendar_request_access');
  },
  listEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    return invoke<CalendarEvent[]>('calendar_list_events', {
      start_ms: start.getTime(),
      end_ms: end.getTime(),
    });
  },
};
