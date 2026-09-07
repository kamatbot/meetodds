import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import type { MomentNote, NoteAnchor, Notebook, NotesWindowTarget, NoteValue } from '@/types/moment-notes';

export const NOTES_CHANGED = 'meetodds:moment-notes-changed';
export const listMomentNotes = (meetingId: string) => invoke<Notebook>('api_list_moment_notes', { meetingId });
export const createMomentNote = (meetingId: string, anchor: NoteAnchor | null) =>
  invoke<MomentNote>('api_create_moment_note', { meetingId, anchor });
export const saveMomentNote = (noteId: string, expected: NoteValue, next: NoteValue) =>
  invoke<MomentNote>('api_save_moment_note', { noteId, expectedRevision: expected.revision, markdown: next.markdown, includeInSummary: next.includeInSummary });
export const getNotesWindowTarget = () => invoke<NotesWindowTarget | null>('get_manual_notes_window_target');
export const getMomentNotesSummary = (meetingId: string) => invoke<{ content: string; count: number }>('api_get_moment_notes_summary', { meetingId });

/** Flush the open writer before assembling a summary. No meeting content is emitted.
 * A lost/failed acknowledgment blocks generation instead of silently dropping notes.
 */
export async function flushOpenNotes(): Promise<void> {
  const target = await getNotesWindowTarget();
  if (!target) return;
  const requestId = crypto.randomUUID();
  let dispose: (() => void) | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('NOTES_NOT_SAVED: Save the open notes window, then retry the summary. Its latest edits could not be confirmed.')), 5000);
      void listen<{ requestId: string; ok: boolean }>('manual-notes:flushed', event => {
        if (event.payload.requestId !== requestId) return;
        if (event.payload.ok) resolve();
        else reject(new Error('NOTES_NOT_SAVED: Your note could not be saved. Resolve the error in the notes window before generating a summary.'));
      }).then(unlisten => {
        if (closed) { unlisten(); return; }
        dispose = unlisten;
        return emitTo('manual-notes', 'manual-notes:flush', { requestId });
      }).catch(reject);
    });
  } finally {
    closed = true;
    if (timer) clearTimeout(timer);
    dispose?.();
  }
}
