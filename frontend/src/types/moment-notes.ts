export interface NoteAnchor {
  segmentId: string | null;
  audioStartTime: number | null;
  audioEndTime: number | null;
  sourceText: string;
  sourceSpeaker: string | null;
  live: boolean;
}

export interface MomentNote {
  id: string;
  /** The original live/draft ID can survive after a meeting is saved. */
  meetingId: string;
  segmentId: string | null;
  resolvedSegmentId: string | null;
  audioStartTime: number | null;
  audioEndTime: number | null;
  sourceText: string;
  sourceSpeaker: string | null;
  anchorState: 'exact' | 'changed' | 'unresolved' | 'general';
  markdown: string;
  includeInSummary: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface Notebook {
  meetingId: string;
  savedMeetingId: string | null;
  title: string;
  notes: MomentNote[];
}
export interface NotesWindowTarget {
  meetingId: string;
  noteId: string | null;
  appendText?: string | null;
  version: number;
}
export interface NoteValue { markdown: string; includeInSummary: boolean; revision: number }
export interface StoredNoteDraft { version: 1; base: NoteValue; value: NoteValue }

export function formatTimestampLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function momentLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 'No audio timestamp';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(total % 60).padStart(2, '0')}`;
}
export function noteTitle(markdown: string): string {
  const first = markdown.split('\n').map(line => line.replace(/^\s*(?:#{1,6}\s+|[-*>]\s*|\d+\.\s*)/, '').trim()).find(Boolean);
  return first?.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '').slice(0, 100) || 'New personal note';
}
export function sameNoteValue(a: NoteValue, b: NoteValue): boolean {
  return a.markdown === b.markdown && a.includeInSummary === b.includeInSummary;
}
