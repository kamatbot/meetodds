'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Clipboard, Download, FileText, FolderOpen, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import ExportSheet from './ExportSheet';
import type { MeetingExportInfo, MeetingExportSelection } from '@/types/meeting';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ShareMenuProps {
  meetingId: string;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    target.isContentEditable ||
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    Boolean(target.closest('[contenteditable="true"]'))
  );
}

function preferredMarkdownSelection(info: MeetingExportInfo): MeetingExportSelection {
  if (info.hasSummary) {
    return { includeSummary: true, includeNotes: false, includeTranscript: false };
  }
  if (info.hasNotes) {
    return { includeSummary: false, includeNotes: true, includeTranscript: false };
  }
  return {
    includeSummary: false,
    includeNotes: false,
    includeTranscript: info.hasTranscript,
  };
}

export default function ShareMenu({ meetingId }: ShareMenuProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const [info, setInfo] = useState<MeetingExportInfo | null>(null);
  const [copying, setCopying] = useState(false);

  const loadInfo = useCallback(async (): Promise<MeetingExportInfo> => {
    if (info?.meetingId === meetingId) return info;
    const response = await invoke<MeetingExportInfo>('api_get_meeting_export_info', { meetingId });
    setInfo(response);
    return response;
  }, [info, meetingId]);

  const copySelection = useCallback(async (
    selection: MeetingExportSelection,
    successMessage: string,
  ) => {
    if (copying) return;
    setCopying(true);
    try {
      const markdown = await invoke<string>('api_get_meeting_markdown', {
        meetingId,
        selection,
      });
      await navigator.clipboard.writeText(markdown);
      toast.success(successMessage);
    } catch (error) {
      console.error('[ShareMenu] Copy failed:', error);
      toast.error('Could not copy meeting content', {
        description: messageFromError(error),
      });
    } finally {
      setCopying(false);
    }
  }, [copying, meetingId]);

  const copyAsMarkdown = useCallback(async () => {
    try {
      const exportInfo = await loadInfo();
      await copySelection(
        preferredMarkdownSelection(exportInfo),
        'Copied meeting as Markdown',
      );
    } catch (error) {
      console.error('[ShareMenu] Copy as Markdown failed:', error);
      toast.error('Could not copy meeting', {
        description: messageFromError(error),
      });
    }
  }, [copySelection, loadInfo]);

  const openExport = useCallback(async () => {
    try {
      await loadInfo();
    } catch (error) {
      console.warn('[ShareMenu] Export availability will retry in the sheet:', error);
    }
    setExportOpen(true);
  }, [loadInfo]);

  const revealRecording = useCallback(async () => {
    try {
      await invoke<void>('api_reveal_meeting_audio', { meetingId });
    } catch (error) {
      console.error('[ShareMenu] Reveal recording failed:', error);
      toast.error('Could not reveal recording', {
        description: messageFromError(error),
      });
    }
  }, [meetingId]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      if (event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        void openExport();
        return;
      }

      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        void copyAsMarkdown();
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [copyAsMarkdown, openExport]);

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void loadInfo()}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-ui font-medium text-text transition-colors duration-150 hover:bg-bg"
          >
            <Share2 className="h-4 w-4" strokeWidth={1.75} /> Share
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[240px] border-border bg-surface text-text">
          <DropdownMenuItem disabled={copying} onSelect={() => void copyAsMarkdown()}>
            <Clipboard /> Copy as Markdown
            <span className="ml-auto text-caption text-3">⌘⇧C</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={copying || info?.hasSummary === false}
            onSelect={() => void copySelection(
              { includeSummary: true, includeNotes: false, includeTranscript: false },
              'Copied summary',
            )}
          >
            <FileText /> Copy summary
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={copying || info?.hasTranscript === false}
            onSelect={() => void copySelection(
              { includeSummary: false, includeNotes: false, includeTranscript: true },
              'Copied transcript',
            )}
          >
            <FileText /> Copy transcript
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem onSelect={() => void openExport()}>
            <Download /> Export…
            <span className="ml-auto text-caption text-3">⌘E</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={info?.hasAudio === false}
            onSelect={() => void revealRecording()}
          >
            <FolderOpen /> Reveal recording in Finder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ExportSheet
        meetingId={meetingId}
        open={exportOpen}
        onOpenChange={setExportOpen}
        initialInfo={info}
      />
    </>
  );
}
