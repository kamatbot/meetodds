import { invoke } from '@tauri-apps/api/core';

export async function getManualNotes(meetingId: string): Promise<string> {
  const response = await invoke<{ content: string }>('api_get_manual_notes', { meetingId });
  return response.content;
}

export async function saveManualNotes(meetingId: string, content: string, expectedContent?: string): Promise<void> {
  if (expectedContent !== undefined) {
    await invoke<void>('api_save_manual_notes_checked', { meetingId, content, expectedContent });
  } else {
    await invoke<void>('api_save_manual_notes', { meetingId, content });
  }
}

export async function linkManualNotes(draftMeetingId: string, meetingId: string): Promise<void> {
  await invoke<void>('api_link_manual_notes', { draftMeetingId, meetingId });
}

export async function openManualNotesWindow(meetingId: string, noteId: string | null = null): Promise<void> {
  await invoke<void>('open_manual_notes_window', { meetingId, noteId });
}

export async function closeManualNotesWindow(): Promise<void> {
  await invoke<void>('close_manual_notes_window');
}
