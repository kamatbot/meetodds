import { invoke } from '@tauri-apps/api/core';

export async function getManualNotes(meetingId: string): Promise<string> {
  const response = await invoke<{ content: string }>('api_get_manual_notes', { meetingId });
  return response.content;
}

export async function saveManualNotes(meetingId: string, content: string, expectedContent?: string): Promise<void> {
  await invoke<void>('api_save_manual_notes_checked', { meetingId, content, expectedContent: expectedContent ?? null });
}

export async function linkManualNotes(draftMeetingId: string, meetingId: string): Promise<void> {
  await invoke<void>('api_link_manual_notes', { draftMeetingId, meetingId });
}

export async function openManualNotesWindow(
  _meetingId: string,
  _noteId: string | null = null,
  _appendText: string | null = null,
): Promise<void> {
  // Pop-out notes window is removed; notes live directly in the central meeting canvas.
}

export async function closeManualNotesWindow(): Promise<void> {
  await invoke<void>('close_manual_notes_window');
}
