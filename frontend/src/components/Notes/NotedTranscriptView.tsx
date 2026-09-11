'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { Plus, LoaderCircle, NotebookPen } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { VirtualizedTranscriptView, type VirtualizedTranscriptViewProps } from '@/components/VirtualizedTranscriptView';
import { getManualNotes, saveManualNotes } from '@/services/manualNotesService';
import { LIVE_NOTE_REQUEST_EVENT } from '@/components/Meeting/LiveMeetingNotes';
import { formatTimestampLabel } from '@/types/moment-notes';
import type { Transcript, TranscriptSegmentData } from '@/types';

interface Props extends VirtualizedTranscriptViewProps {
  meetingId?: string | null;
  noteTranscripts: Transcript[];
  liveNotes?: boolean;
}
const realTime = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const speakerName = (transcript?: Transcript, segment?: TranscriptSegmentData) =>
  transcript?.speaker_label || transcript?.speaker || segment?.speaker_label || segment?.speaker || 'Speaker';

export default function NotedTranscriptView({ meetingId, noteTranscripts, liveNotes = false, ...view }: Props) {
  const router = useRouter();
  const [notesContent, setNotesContent] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const pending = useRef(false);
  const originals = useMemo(() => new Map(noteTranscripts.map(t => [t.id, t])), [noteTranscripts]);

  // Load manual notes text and keep timestamp indicators in sync with saved edits.
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

  const notedTimestamps = useMemo(() => {
    const set = new Set<string>();
    if (!notesContent) return set;
    const matches = notesContent.matchAll(/<!--\s*\[([0-9:]+)\]\s*-->/g);
    for (const match of matches) {
      if (match[1]) set.add(match[1]);
    }
    return set;
  }, [notesContent]);

  const requestEmbeddedNotes = useCallback((appendText?: string | null) => {
    if (!meetingId) return;
    window.dispatchEvent(new CustomEvent(LIVE_NOTE_REQUEST_EVENT, {
      detail: { meetingId, appendText: appendText ?? null },
    }));
  }, [meetingId]);

  const open = useCallback(async (segment: TranscriptSegmentData) => {
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
      const alreadyNoted = Boolean(label && notedTimestamps.has(label));
      const speaker = speakerName(original, segment);
      const visibleAnchor = label ? `**${label} · ${speaker}** — ` : `**${speaker}** — `;
      const blockToAppend = alreadyNoted ? null : `${timestampTag}\n${visibleAnchor}`;

      if (liveNotes) {
        // In the live notebook, + means “capture my thought at this moment”. The
        // transcript remains evidence at the side; do not copy raw transcript text
        // into the user's notes or manufacture an action before the AI summary.
        requestEmbeddedNotes(blockToAppend);
      } else {
        if (blockToAppend) {
          const prev = await getManualNotes(meetingId);
          const trimmed = prev.trimEnd();
          const next = trimmed ? `${trimmed}\n\n${blockToAppend}\n` : `${blockToAppend}\n`;
          await saveManualNotes(meetingId, next, prev);
          await emit('manual-notes:saved', { meetingId }).catch(() => undefined);
        }
        router.push(`/meeting?id=${encodeURIComponent(meetingId)}&tab=notes`);
      }

      if (blockToAppend && label) {
        setNotesContent(prev => {
          const trimmed = prev.trimEnd();
          return trimmed ? `${trimmed}\n\n${blockToAppend}\n` : `${blockToAppend}\n`;
        });
      }
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      setOpening(null);
    }
  }, [meetingId, originals, liveNotes, notedTimestamps, requestEmbeddedNotes, router]);

  const renderAction = useCallback((segment: TranscriptSegmentData) => {
    if (!meetingId || (liveNotes && !originals.has(segment.id))) return null;
    const rawTime = realTime(originals.get(segment.id)?.audio_start_time ?? segment.timestamp);
    const label = formatTimestampLabel(rawTime);
    const hasNote = Boolean(label && notedTimestamps.has(label));
    const title = hasNote
      ? `${liveNotes ? 'Focus' : 'View'} note · ${label}`
      : `Capture a note at ${label || 'this moment'}`;

    return (
      <button
        type="button"
        title={title}
        aria-label={title}
        disabled={opening !== null}
        onClick={() => void open(segment)}
        className={`relative inline-grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-35 ${
          hasNote
            ? 'border-accent bg-accent text-accent-foreground shadow-xs'
            : 'border-accent/35 bg-accent-soft/60 text-accent hover:border-accent hover:bg-accent-soft'
        }`}
      >
        {opening === segment.id ? (
          <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : hasNote ? (
          <NotebookPen className="h-3.5 w-3.5" />
        ) : (
          <Plus className="h-4 w-4" strokeWidth={1.75} />
        )}
      </button>
    );
  }, [meetingId, liveNotes, originals, notedTimestamps, opening, open]);

  const openNotes = useCallback(() => {
    if (!meetingId) return;
    if (liveNotes) {
      requestEmbeddedNotes(null);
      return;
    }
    router.push(`/meeting?id=${encodeURIComponent(meetingId)}&tab=notes`);
  }, [liveNotes, meetingId, requestEmbeddedNotes, router]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {meetingId && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs text-3">
          <span>{liveNotes ? 'Use + to capture your thought at that exact moment' : 'Use + beside a transcript line to add a linked note'}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-accent hover:bg-accent-soft"
            onClick={openNotes}
          >
            <NotebookPen className="h-3.5 w-3.5" /> {liveNotes ? 'Focus notebook' : 'Meeting notes'}
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
