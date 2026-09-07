'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { Plus, LoaderCircle, NotebookPen } from 'lucide-react';
import { VirtualizedTranscriptView, type VirtualizedTranscriptViewProps } from '@/components/VirtualizedTranscriptView';
import { getManualNotes, openManualNotesWindow } from '@/services/manualNotesService';
import { formatTimestampLabel } from '@/types/moment-notes';
import type { Transcript, TranscriptSegmentData } from '@/types';

interface Props extends VirtualizedTranscriptViewProps {
  meetingId?: string | null;
  noteTranscripts: Transcript[];
  liveNotes?: boolean;
}
const realTime = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export default function NotedTranscriptView({ meetingId, noteTranscripts, liveNotes = false, ...view }: Props) {
  const [notesContent, setNotesContent] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const pending = useRef(false);
  const originals = useMemo(() => new Map(noteTranscripts.map(t => [t.id, t])), [noteTranscripts]);

  // Load manual notes text and keep in sync
  useEffect(() => {
    if (!meetingId) {
      setNotesContent('');
      return;
    }
    let unlistenSaved: (() => void) | undefined;
    let unlistenChanged: (() => void) | undefined;

    const load = () => {
      void getManualNotes(meetingId)
        .then(setNotesContent)
        .catch(() => {});
    };
    load();

    void listen('manual-notes:saved', load).then(fn => { unlistenSaved = fn; });
    void listen('manual-notes:changed', load).then(fn => { unlistenChanged = fn; });

    return () => {
      unlistenSaved?.();
      unlistenChanged?.();
    };
  }, [meetingId]);

  // Parse all timestamps in the document: <!-- [mm:ss] -->
  const notedTimestamps = useMemo(() => {
    const set = new Set<string>();
    if (!notesContent) return set;
    const matches = notesContent.matchAll(/<!--\s*\[([0-9:]+)\]\s*-->/g);
    for (const match of matches) {
      if (match[1]) set.add(match[1]);
    }
    return set;
  }, [notesContent]);

  const open = async (segment: TranscriptSegmentData) => {
    if (!meetingId || pending.current) return;
    const original = originals.get(segment.id);
    if (liveNotes && !original) return;
    pending.current = true;
    setOpening(segment.id);
    setOpenError(null);
    try {
      const rawTime = realTime(original?.audio_start_time ?? segment.timestamp);
      const label = formatTimestampLabel(rawTime);
      const timestampTag = label ? `<!-- [${label}] -->` : '<!-- [Note] -->';

      // If this moment already exists in the document, don't re-append a duplicate tag
      const alreadyNoted = Boolean(label && notedTimestamps.has(label));
      const tagToAppend = alreadyNoted ? null : timestampTag;

      await openManualNotesWindow(meetingId, null, tagToAppend);
      if (tagToAppend) {
        await emit('manual-notes:append', { meetingId, text: tagToAppend });
        if (label) {
          setNotesContent(prev => {
            const trimmed = prev.trimEnd();
            return trimmed ? `${trimmed}\n\n${tagToAppend}\n` : `${tagToAppend}\n`;
          });
        }
      }
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      setOpening(null);
    }
  };

  const renderAction = (segment: TranscriptSegmentData) => {
    if (!meetingId || (liveNotes && !originals.has(segment.id))) return null;
    const rawTime = realTime(originals.get(segment.id)?.audio_start_time ?? segment.timestamp);
    const label = formatTimestampLabel(rawTime);
    const hasNote = Boolean(label && notedTimestamps.has(label));
    const title = hasNote
      ? `View note · ${label}`
      : `Add note at ${label || 'this moment'}`;

    return (
      <button
        type="button"
        title={title}
        aria-label={title}
        disabled={opening !== null}
        onClick={() => void open(segment)}
        className={`relative inline-grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-35 ${
          hasNote
            ? 'border-accent bg-accent text-white shadow-xs'
            : 'border-accent/35 bg-accent-soft/60 text-accent hover:border-accent hover:bg-accent-soft'
        }`}
      >
        {opening === segment.id ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : hasNote ? (
          <NotebookPen className="h-3.5 w-3.5" />
        ) : (
          <Plus className="h-4 w-4" strokeWidth={1.75} />
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {meetingId && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs text-3">
          <span>Use + beside a transcript line to add a note at that moment</span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-accent hover:bg-accent-soft"
            onClick={() => void openManualNotesWindow(meetingId).catch(() => setOpenError('Could not open meeting notes. Retry.'))}
          >
            <NotebookPen className="h-3.5 w-3.5" /> Meeting notes
          </button>
        </div>
      )}
      {openError && (
        <div role="alert" className="shrink-0 px-4 py-2 text-xs text-danger">
          {openError}
          <button type="button" className="ml-2 underline" onClick={() => setOpenError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <VirtualizedTranscriptView {...view} renderSegmentAction={renderAction} />
      </div>
    </div>
  );
}
