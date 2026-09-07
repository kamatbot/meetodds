'use client';

import { useMemo, useRef, useState } from 'react';
import { Plus, LoaderCircle, NotebookPen } from 'lucide-react';
import { VirtualizedTranscriptView, type VirtualizedTranscriptViewProps } from '@/components/VirtualizedTranscriptView';
import { useMomentNotes } from '@/hooks/useMomentNotes';
import { createMomentNote } from '@/services/momentNotesService';
import { openManualNotesWindow } from '@/services/manualNotesService';
import { momentLabel } from '@/types/moment-notes';
import type { Transcript, TranscriptSegmentData } from '@/types';

interface Props extends VirtualizedTranscriptViewProps {
  meetingId?: string | null;
  noteTranscripts: Transcript[];
  liveNotes?: boolean;
}
const realTime = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** The note affordance is outside the audio/ASR path. Only finalized turns can
 * be annotated; speculative live captions are not evidence and have no +.
 */
export default function NotedTranscriptView({ meetingId, noteTranscripts, liveNotes = false, ...view }: Props) {
  const { notebook, error, loading, refresh } = useMomentNotes(meetingId);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const pending = useRef(false);
  const originals = useMemo(() => new Map(noteTranscripts.map(t => [t.id, t])), [noteTranscripts]);
  const notesBySegment = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const note of notebook?.notes ?? []) {
      // Both IDs are useful while a live view coexists with the just-saved meeting.
      for (const id of new Set([note.segmentId, note.resolvedSegmentId].filter((id): id is string => Boolean(id)))) {
        map.set(id, [...(map.get(id) ?? []), note.id]);
      }
    }
    return map;
  }, [notebook]);
  const open = async (segment: TranscriptSegmentData) => {
    if (!meetingId || pending.current) return;
    const original = originals.get(segment.id);
    if (liveNotes && (!original || original.is_partial)) return;
    pending.current = true; setOpening(segment.id); setOpenError(null);
    try {
      const existing = notesBySegment.get(segment.id)?.[0];
      const noteId = existing ?? (await createMomentNote(meetingId, {
        segmentId: segment.id,
        // Never turn missing timing into a fabricated 00:00 anchor.
        audioStartTime: realTime(original?.audio_start_time),
        audioEndTime: realTime(original?.audio_end_time),
        sourceText: original?.text ?? segment.text,
        sourceSpeaker: original?.speaker_label ?? segment.speaker_label ?? null,
        live: liveNotes,
      })).id;
      await openManualNotesWindow(meetingId, noteId);
      await refresh();
    } catch (e) { setOpenError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; setOpening(null); }
  };
  const renderAction = (segment: TranscriptSegmentData) => {
    if (!meetingId || (liveNotes && (!originals.get(segment.id) || originals.get(segment.id)?.is_partial))) return null;
    const count = notesBySegment.get(segment.id)?.length ?? 0;
    const timestamp = originals.get(segment.id)?.audio_start_time;
    const label = `${count ? 'View personal note' : 'Add personal note'} · ${timestamp == null ? 'this transcript moment' : momentLabel(timestamp)}`;
    return <button type="button" title={label} aria-label={label} disabled={loading || Boolean(error) || opening !== null}
      onClick={() => void open(segment)}
      className={`relative inline-grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-35 ${count ? 'border-accent/40 bg-accent-soft text-accent' : 'border-border bg-surface text-3 hover:border-accent hover:text-accent'}`}>
      {opening === segment.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" strokeWidth={1.75} />}
      {count > 0 && <span aria-hidden="true" className="absolute -right-1 -top-1 grid h-3.5 min-w-[14px] place-items-center rounded-full bg-accent px-0.5 text-[9px] font-semibold text-white">{count}</span>}
    </button>;
  };
  return <div className="flex h-full min-h-0 flex-col">
    {meetingId && <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs text-3">
      <span>“+” adds a note at this moment</span>
      <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-accent hover:bg-accent-soft"
        onClick={() => void openManualNotesWindow(meetingId).catch(() => setOpenError('Could not open the notebook. Retry.'))}>
        <NotebookPen className="h-3.5 w-3.5" />{notebook ? `${notebook.notes.length} linked notes` : 'Notebook'}
      </button>
    </div>}
    {(error || openError) && <div role="alert" className="shrink-0 px-4 py-2 text-xs text-danger">{openError || error}<button type="button" className="ml-2 underline" onClick={() => { setOpenError(null); void refresh(); }}>Retry</button></div>}
    <div className="min-h-0 flex-1"><VirtualizedTranscriptView {...view} renderSegmentAction={renderAction} /></div>
  </div>;
}
