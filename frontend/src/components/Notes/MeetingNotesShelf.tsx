'use client';

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Clock3, ArrowUpRight } from 'lucide-react';
import { useMomentNotes } from '@/hooks/useMomentNotes';
import { getManualNotes, openManualNotesWindow } from '@/services/manualNotesService';
import { NOTES_CHANGED } from '@/services/momentNotesService';
import { momentLabel, noteTitle } from '@/types/moment-notes';
import { NoteMarkdown } from './MarkdownNoteEditor';

export default function MeetingNotesShelf({ meetingId }: { meetingId: string }) {
  const { notebook, error, refresh } = useMomentNotes(meetingId);
  const [legacy, setLegacy] = useState('');
  const [legacyReload, setLegacyReload] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const load = () => { void getManualNotes(meetingId).then(value => { if (!disposed) setLegacy(value); }).catch(() => { if (!disposed) setLocalError('Earlier meeting notes could not be read.'); }); };
    setLegacy(''); setLocalError(null); load();
    void listen(NOTES_CHANGED, load).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [meetingId, legacyReload]);
  const open = (noteId: string | null = null) => {
    void openManualNotesWindow(meetingId, noteId).catch(() => setLocalError('Could not open the notebook. Retry.'));
  };
  return <section className="mx-6 mt-5 shrink-0 border-b border-border pb-5 text-text" aria-label="Personal notes linked to the meeting">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold">Meeting notebook{notebook ? ` · ${notebook.notes.length} linked notes` : ''}</h2>
      <button type="button" onClick={() => open()} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-accent hover:bg-accent-soft">Open full window <ArrowUpRight className="h-3.5 w-3.5" /></button>
    </div>
    <div className="max-h-56 space-y-2 overflow-y-auto">
      {notebook?.notes.map(note => <button type="button" key={note.id} onClick={() => open(note.id)} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface">
        <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-xs text-accent"><Clock3 className="h-3.5 w-3.5" />{note.segmentId ? momentLabel(note.audioStartTime) : 'Note'}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{noteTitle(note.markdown)}</span><span className="mt-1 block truncate text-xs text-3">{note.sourceText || 'Personal meeting note'}</span></span>
      </button>)}
      {legacy.trim() && <details><summary className="cursor-pointer py-2 text-sm text-2">Earlier freeform meeting notes</summary><div className="px-3 pb-3"><NoteMarkdown content={legacy} /></div></details>}
    </div>
    {!notebook?.notes.length && !legacy.trim() && <p className="text-sm leading-6 text-3">Use the “+” beside a transcript turn to keep a thought next to what was said.</p>}
    {(error || localError) && <p role="alert" className="mt-2 text-sm text-danger">{localError || error}<button type="button" onClick={() => { void refresh(); setLegacyReload(n => n + 1); setLocalError(null); }} className="ml-2 underline">Retry</button></p>}
  </section>;
}
