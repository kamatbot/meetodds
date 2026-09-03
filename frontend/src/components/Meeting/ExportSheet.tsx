'use client';

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, FileAudio, FileJson, FileText, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  MeetingExportFormat,
  MeetingExportInfo,
  MeetingExportRequest,
  MeetingExportResult,
  MeetingExportSelection,
} from '@/types/meeting';

interface ExportSheetProps {
  meetingId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialInfo?: MeetingExportInfo | null;
}

interface SectionOption {
  key: keyof MeetingExportSelection;
  label: string;
  description: string;
}

const sectionOptions: SectionOption[] = [
  { key: 'includeSummary', label: 'Summary', description: 'Current saved AI summary' },
  { key: 'includeNotes', label: 'Notes', description: 'Markdown meeting notes' },
  { key: 'includeTranscript', label: 'Transcript', description: 'Full saved transcript' },
];

const formatOptions: Array<{ value: MeetingExportFormat; label: string; icon: typeof FileText }> = [
  { value: 'markdown', label: 'Markdown', icon: FileText },
  { value: 'text', label: 'Text', icon: FileText },
  { value: 'json', label: 'JSON', icon: FileJson },
  { value: 'srt', label: 'SRT', icon: FileText },
];

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function selectionFromInfo(info: MeetingExportInfo): MeetingExportSelection {
  return {
    includeSummary: info.hasSummary,
    includeNotes: info.hasNotes,
    includeTranscript: info.hasTranscript,
  };
}

export default function ExportSheet({
  meetingId,
  open,
  onOpenChange,
  initialInfo = null,
}: ExportSheetProps) {
  const [info, setInfo] = useState<MeetingExportInfo | null>(initialInfo);
  const [isLoading, setIsLoading] = useState(!initialInfo);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<MeetingExportSelection>({
    includeSummary: false,
    includeNotes: false,
    includeTranscript: false,
  });
  const [includeAudio, setIncludeAudio] = useState(false);
  const [format, setFormat] = useState<MeetingExportFormat>('markdown');
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const loadInfo = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = initialInfo ?? await invoke<MeetingExportInfo>('api_get_meeting_export_info', {
          meetingId,
        });
        if (cancelled) return;
        setInfo(response);
        setSelection(selectionFromInfo(response));
        setIncludeAudio(false);
        setFormat('markdown');
      } catch (loadError) {
        if (cancelled) return;
        console.error('[ExportSheet] Failed to load export availability:', loadError);
        setInfo(null);
        setError(messageFromError(loadError));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void loadInfo();
    return () => {
      cancelled = true;
    };
  }, [initialInfo, meetingId, open]);

  const availableSections = useMemo(() => {
    if (!info) return [];
    return sectionOptions.filter((option) => {
      if (option.key === 'includeSummary') return info.hasSummary;
      if (option.key === 'includeNotes') return info.hasNotes;
      return info.hasTranscript;
    });
  }, [info]);

  const selectedTextCount = Object.values(selection).filter(Boolean).length;
  const srtAllowed = Boolean(
    info?.transcriptHasTiming &&
    selection.includeTranscript &&
    !selection.includeSummary &&
    !selection.includeNotes,
  );

  useEffect(() => {
    if (format === 'srt' && !srtAllowed) {
      setFormat('markdown');
    }
  }, [format, srtAllowed]);

  const toggleSection = (key: keyof MeetingExportSelection) => {
    setSelection((current) => ({ ...current, [key]: !current[key] }));
  };

  const runExport = async () => {
    if (!info || isExporting) return;
    if (selectedTextCount === 0 && !includeAudio) {
      toast.error('Choose something to export');
      return;
    }

    setIsExporting(true);
    try {
      const exportedPaths: string[] = [];

      if (selectedTextCount > 0) {
        const request: MeetingExportRequest = {
          meetingId,
          format,
          selection,
        };
        const result = await invoke<MeetingExportResult>('api_export_meeting', { request });
        if (!result.cancelled && result.path) {
          exportedPaths.push(result.path);
        } else if (result.cancelled && !includeAudio) {
          return;
        }
      }

      if (includeAudio) {
        const audioResult = await invoke<MeetingExportResult>('api_export_meeting_audio', {
          meetingId,
        });
        if (!audioResult.cancelled && audioResult.path) {
          exportedPaths.push(audioResult.path);
        }
      }

      if (exportedPaths.length > 0) {
        onOpenChange(false);
        toast.success(exportedPaths.length === 1 ? 'Meeting exported' : 'Meeting files exported', {
          description: exportedPaths.length === 1
            ? exportedPaths[0]
            : `${exportedPaths.length} files saved`,
        });
      }
    } catch (exportError) {
      console.error('[ExportSheet] Export failed:', exportError);
      toast.error('Could not export meeting', {
        description: messageFromError(exportError),
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !isExporting && onOpenChange(nextOpen)}>
      <DialogContent className="border-border bg-surface text-text sm:max-w-[520px]">
        <DialogTitle className="text-title">Export meeting</DialogTitle>

        {isLoading ? (
          <div className="flex min-h-[220px] items-center justify-center text-ui text-3">
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.75} />
            Checking saved content…
          </div>
        ) : error ? (
          <div className="rounded-card border border-border bg-bg p-4 text-ui text-danger">
            Export options could not be loaded: {error}
          </div>
        ) : info ? (
          <div className="space-y-5 py-1">
            <section>
              <h3 className="mb-2 text-ui font-semibold text-2">Include</h3>
              <div className="overflow-hidden rounded-card border border-border bg-bg">
                {availableSections.map((option) => {
                  const selected = selection[option.key];
                  return (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => toggleSection(option.key)}
                      className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-surface"
                    >
                      <span className={`inline-grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border ${selected ? 'border-accent bg-accent text-white' : 'border-border bg-surface text-transparent'}`}>
                        <Check className="h-3 w-3" strokeWidth={2} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-ui font-medium text-text">{option.label}</span>
                        <span className="block text-caption text-3">{option.description}</span>
                      </span>
                    </button>
                  );
                })}

                {info.hasAudio && (
                  <button
                    type="button"
                    onClick={() => setIncludeAudio((current) => !current)}
                    className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-surface"
                  >
                    <span className={`inline-grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border ${includeAudio ? 'border-accent bg-accent text-white' : 'border-border bg-surface text-transparent'}`}>
                      <Check className="h-3 w-3" strokeWidth={2} />
                    </span>
                    <FileAudio className="h-4 w-4 shrink-0 text-3" strokeWidth={1.75} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-ui font-medium text-text">Audio</span>
                      <span className="block text-caption text-3">Original saved MP4 recording</span>
                    </span>
                  </button>
                )}
              </div>
              {availableSections.length === 0 && !info.hasAudio && (
                <p className="mt-2 text-caption text-3">This meeting has no saved content to export.</p>
              )}
              {includeAudio && selectedTextCount > 0 && (
                <p className="mt-2 text-caption text-3">
                  Audio is a separate file, so macOS will ask where to save it after the content export.
                </p>
              )}
            </section>

            {selectedTextCount > 0 && (
              <section>
                <h3 className="mb-2 text-ui font-semibold text-2">Format</h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {formatOptions.map((option) => {
                    const disabled = option.value === 'srt' && !srtAllowed;
                    const Icon = option.icon;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        disabled={disabled}
                        onClick={() => setFormat(option.value)}
                        className={`flex h-16 flex-col items-center justify-center gap-1 rounded-card border text-caption font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-35 ${format === option.value ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-bg text-2 hover:text-text'}`}
                      >
                        <Icon className="h-4 w-4" strokeWidth={1.75} />
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                {!srtAllowed && selection.includeTranscript && (
                  <p className="mt-2 text-caption text-3">
                    SRT is available only for transcript-only exports when every segment has real timing.
                  </p>
                )}
              </section>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={isExporting}
            className="h-8 rounded-control border border-border bg-surface px-3 text-ui font-medium text-text hover:bg-bg disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void runExport()}
            disabled={isLoading || Boolean(error) || isExporting || (selectedTextCount === 0 && !includeAudio)}
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-accent bg-accent px-3 text-ui font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
          >
            {isExporting && <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />}
            Export…
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
