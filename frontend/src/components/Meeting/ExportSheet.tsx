'use client';

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import type { MeetingExportInfo, MeetingExportResult, MeetingExportSelection } from '@/types/meeting';
import { canExportSrt, isFormattedDocument, privateExportDefaults, runExportSteps, selectedSectionCount, selectionKey, type ExportFormatChoice } from '@/lib/export-selection';

interface ExportSheetProps { meetingId: string; open: boolean; onOpenChange: (open: boolean) => void; initialInfo?: MeetingExportInfo | null }
const options: { key: keyof MeetingExportSelection; label: string; availability: 'hasSummary' | 'hasNotes' | 'hasTranscript' }[] = [
  { key: 'includeSummary', label: 'Saved summary', availability: 'hasSummary' },
  { key: 'includeNotes', label: 'Personal notes', availability: 'hasNotes' },
  { key: 'includeTranscript', label: 'Full transcript', availability: 'hasTranscript' },
];
const formats: { value: ExportFormatChoice; label: string }[] = [
  { value: 'markdown', label: 'Markdown' }, { value: 'pdf', label: 'PDF' }, { value: 'docx', label: 'Word' },
  { value: 'text', label: 'Text' }, { value: 'json', label: 'JSON' }, { value: 'srt', label: 'Subtitles' },
];

export default function ExportSheet({ meetingId, open, onOpenChange }: ExportSheetProps) {
  const [info, setInfo] = useState<MeetingExportInfo | null>(null);
  const [selection, setSelection] = useState<MeetingExportSelection>(privateExportDefaults({ hasSummary: false }));
  const [format, setFormat] = useState<ExportFormatChoice>('markdown');
  const [includeAudio, setIncludeAudio] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const exporting = useRef(false);
  const count = selectedSectionCount(selection);
  const key = selectionKey(meetingId, selection);
  const previewReady = count === 0 || preview?.key === key;
  const srtAllowed = Boolean(info?.transcriptHasTiming && canExportSrt(info.transcriptHasTiming, selection));

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setLoading(true); setError(null); setInfo(null); setPreview(null); setPreviewError(false); setIncludeAudio(false); setFormat('markdown');
    // Always refresh. A cached Share menu can predate a new summary or a notes edit.
    void invoke<MeetingExportInfo>('api_get_meeting_export_info', { meetingId }).then((result) => {
      if (disposed) return;
      if (result.meetingId !== meetingId) throw new Error('Meeting mismatch');
      setInfo(result); setSelection(privateExportDefaults(result));
    }).catch(() => { if (!disposed) setError('Saved content could not be loaded. Retry before exporting.'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [meetingId, open, retry]);

  useEffect(() => {
    if (!open || !info || !count) { setPreview(null); setPreviewError(false); return; }
    let disposed = false;
    setPreview(null); setPreviewError(false);
    void invoke<string>('api_get_meeting_markdown', { meetingId, selection }).then((text) => {
      if (!disposed) setPreview({ key, text });
    }).catch(() => { if (!disposed) setPreviewError(true); });
    return () => { disposed = true; };
  }, [count, info, key, meetingId, open, selection]);
  useEffect(() => { if (format === 'srt' && !srtAllowed) setFormat('markdown'); }, [format, srtAllowed]);

  const runExport = async () => {
    if (!info || exporting.current || !previewReady || (!count && !includeAudio)) return;
    exporting.current = true; setIsExporting(true); setError(null);
    try {
      const snapshot = preview?.text ?? '';
      if (count) {
        const current = await invoke<string>('api_get_meeting_markdown', { meetingId, selection });
        if (current !== snapshot) {
          setPreview({ key, text: current });
          setError('Saved content changed since the preview. Review the updated preview and export again.');
          return;
        }
      }
      const outcome = await runExportSteps({
        text: count ? async () => {
          if (isFormattedDocument(format)) {
            // Reuse the existing tested serializers; do not add a second PDF/DOCX implementation.
            const { exportMeetingSummary } = await import('@/lib/meeting-export');
            const result = await exportMeetingSummary({ format, title: info.title, createdAt: info.createdAt, markdown: snapshot });
            return { cancelled: false, label: result.path ?? `Download requested: ${result.filename}` };
          }
          const result = await invoke<MeetingExportResult>('api_export_meeting', { request: { meetingId, format, selection, expectedMarkdown: snapshot } });
          return { cancelled: result.cancelled, label: result.path };
        } : undefined,
        audio: includeAudio ? async () => {
          const result = await invoke<MeetingExportResult>('api_export_meeting_audio', { meetingId });
          return { cancelled: result.cancelled, label: result.path };
        } : undefined,
      });
      if (outcome.failed) {
        setError(outcome.saved.length ? `Part of the export succeeded (${outcome.saved.join('; ')}). The remaining file could not be exported.` : 'Export failed. Check the destination and available disk space, then retry.');
      } else if (outcome.saved.length) {
        toast.success(outcome.cancelled ? 'Partial export complete' : 'Export complete', { description: outcome.saved.join('\n') });
        onOpenChange(false);
      }
    } catch { setError('The saved-content check failed. Nothing new was exported. Retry when the meeting is available.'); }
    finally { exporting.current = false; setIsExporting(false); }
  };
  const button = 'rounded-control border border-border px-3 py-2 text-ui font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40';
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!exporting.current) onOpenChange(next); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-surface text-text sm:max-w-[620px]">
        <DialogTitle className="text-title">Export meeting</DialogTitle>
        <DialogDescription className="text-ui text-2">Exports use saved content. Save current editor changes first. Personal notes, the transcript, and audio are never included automatically.</DialogDescription>
        {loading ? <p role="status" className="flex items-center gap-2 py-8 text-ui text-2"><LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> Checking saved content…</p> : info && (
          <fieldset disabled={isExporting} className="space-y-4">
            <legend className="sr-only">Choose content and format</legend>
            <div className="space-y-2 rounded-card border border-border p-3">
              {options.filter(option => info[option.availability]).map((option) => (
                <label key={option.key} className="flex cursor-pointer items-center gap-3 py-1.5 text-ui"><input type="checkbox" checked={selection[option.key]} onChange={(event) => setSelection((current) => ({ ...current, [option.key]: event.target.checked }))} />{option.label}</label>
              ))}
              {info.hasAudio && <label className="flex cursor-pointer items-center gap-3 py-1.5 text-ui"><input type="checkbox" checked={includeAudio} onChange={(event) => setIncludeAudio(event.target.checked)} /> Saved audio · separate file</label>}
              {!info.hasSummary && !info.hasNotes && !info.hasTranscript && !info.hasAudio && <p className="text-ui text-2">No saved content is available for this meeting.</p>}
            </div>
            {count > 0 && <>
              <fieldset><legend className="mb-2 text-ui font-semibold">Format</legend>
                <div className="grid grid-cols-3 gap-2">{formats.map((option) => (
                  <label key={option.value} className={`flex items-center gap-2 rounded-control border p-2.5 text-caption ${format === option.value ? 'border-accent bg-accent-soft' : 'border-border'} ${option.value === 'srt' && !srtAllowed ? 'opacity-40' : 'cursor-pointer'}`}>
                    <input type="radio" name={`export-format-${meetingId}`} value={option.value} checked={format === option.value} disabled={option.value === 'srt' && !srtAllowed} onChange={() => setFormat(option.value)} />{option.label}
                  </label>
                ))}</div>
                <p className="mt-2 text-caption text-2">{isFormattedDocument(format) ? 'PDF and Word use the existing formatted exporter and save to Downloads.' : 'Choose a save location in the system dialog.'}</p>
                {!srtAllowed && selection.includeTranscript && <p className="mt-1 text-caption text-2">Subtitles require transcript-only selection and real timing for every segment.</p>}
              </fieldset>
              <details className="rounded-card border border-border p-3"><summary className="cursor-pointer text-ui font-medium">Preview selected saved content</summary>
                {previewError ? <p role="alert" className="mt-2 text-caption text-danger">Preview could not be loaded. Retry before exporting.</p> : preview?.key === key
                  ? <pre className="mt-3 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-caption leading-6">{preview.text}</pre>
                  : <p role="status" className="mt-2 text-caption text-2">Loading preview…</p>}
              </details>
            </>}
            {includeAudio && count > 0 && <p className="text-caption text-2">Audio is saved separately. Canceling either file dialog stops the remaining export steps.</p>}
          </fieldset>
        )}
        {error && <p role="alert" className="rounded-control border border-border p-3 text-ui text-danger">{error}</p>}
        <DialogFooter>
          {(error || previewError) && <button type="button" className={button} disabled={isExporting} onClick={() => setRetry((value) => value + 1)}>Reload saved content</button>}
          <button type="button" className={button} disabled={isExporting} onClick={() => onOpenChange(false)}>Cancel</button>
          <button type="button" className={`${button} bg-accent text-white`} disabled={loading || !info || isExporting || !previewReady || previewError || (!count && !includeAudio)} onClick={() => void runExport()}>{isExporting ? 'Exporting…' : 'Export…'}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
