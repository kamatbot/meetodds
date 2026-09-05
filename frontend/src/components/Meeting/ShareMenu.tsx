'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { Clipboard, Download, FileText, FolderOpen, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import ExportSheet from './ExportSheet';
import type { MeetingExportInfo, MeetingExportSelection } from '@/types/meeting';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export default function ShareMenu({ meetingId }: { meetingId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [exportOpen, setExportOpen] = useState(false);
  const [info, setInfo] = useState<MeetingExportInfo | null>(null);
  const [copying, setCopying] = useState(false);
  const copyLock = useRef(false);
  const activeId = useRef(meetingId);
  activeId.current = meetingId;
  const openedQuery = useRef<string | null>(null);
  useEffect(() => { setInfo(null); setExportOpen(false); }, [meetingId]);
  const loadInfo = useCallback(async () => {
    const response = await invoke<MeetingExportInfo>('api_get_meeting_export_info', { meetingId });
    if (activeId.current === meetingId && response.meetingId === meetingId) setInfo(response);
    return response;
  }, [meetingId]);
  const openExport = useCallback(() => setExportOpen(true), []);

  const copySelection = useCallback(async (selection: MeetingExportSelection, label: string) => {
    if (copyLock.current) return;
    copyLock.current = true; setCopying(true);
    try {
      const markdown = await invoke<string>('api_get_meeting_markdown', { meetingId, selection });
      if (activeId.current !== meetingId) return;
      await navigator.clipboard.writeText(markdown);
      toast.success(label, { description: 'Copied saved content. Clipboard sync is controlled by your operating system.' });
    } catch { toast.error('Could not copy saved content', { description: 'Save your edits and retry, or use Export to review the content.' }); }
    finally { copyLock.current = false; setCopying(false); }
  }, [meetingId]);

  const copyAsMarkdown = useCallback(async () => {
    try {
      const current = await loadInfo();
      if (activeId.current !== meetingId) return;
      if (!current.hasSummary) {
        // Never silently substitute personal notes or the entire transcript for an absent summary.
        openExport();
        toast.info('Choose content to share', { description: 'No saved summary is available. Personal notes and transcripts require an explicit selection.' });
        return;
      }
      await copySelection({ includeSummary: true, includeNotes: false, includeTranscript: false }, 'Copied saved summary as Markdown');
    } catch { toast.error('Could not load saved content'); }
  }, [copySelection, loadInfo, meetingId, openExport]);
  const revealRecording = async () => {
    try { await invoke<void>('api_reveal_meeting_audio', { meetingId }); }
    catch { toast.error('Could not reveal recording', { description: 'The audio may not have been retained or may have moved.' }); }
  };

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"],[role="alertdialog"]'))) return;
      if (event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'e') { event.preventDefault(); openExport(); }
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === 'c') { event.preventDefault(); void copyAsMarkdown(); }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [copyAsMarkdown, openExport]);
  useEffect(() => {
    const requested = searchParams.get('export') === '1';
    if (!requested) { openedQuery.current = null; return; }
    if (openedQuery.current === meetingId) return;
    openedQuery.current = meetingId;
    openExport();
    const next = new URLSearchParams(searchParams.toString()); next.delete('export');
    if (!next.get('id')) next.set('id', meetingId);
    router.replace(`/meeting?${next.toString()}`, { scroll: false });
  }, [meetingId, openExport, router, searchParams]);

  return <>
    <DropdownMenu onOpenChange={(open) => { if (open) void loadInfo().catch(() => setInfo(null)); }}>
      <DropdownMenuTrigger asChild><button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-ui font-medium text-text hover:bg-bg"><Share2 aria-hidden="true" className="h-4 w-4" /> Share</button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[250px] border-border bg-surface text-text">
        <DropdownMenuItem disabled={copying} onSelect={() => void copyAsMarkdown()}><Clipboard /> Copy saved summary as Markdown<span className="ml-auto text-caption text-3">⌘⇧C</span></DropdownMenuItem>
        <DropdownMenuItem disabled={copying || !info?.hasNotes} onSelect={() => void copySelection({ includeSummary: false, includeNotes: true, includeTranscript: false }, 'Copied personal notes')}><FileText /> Copy personal notes</DropdownMenuItem>
        <DropdownMenuItem disabled={copying || !info?.hasTranscript} onSelect={() => void copySelection({ includeSummary: false, includeNotes: false, includeTranscript: true }, 'Copied saved transcript')}><FileText /> Copy full transcript</DropdownMenuItem>
        <DropdownMenuSeparator className="bg-border" />
        <DropdownMenuItem onSelect={openExport}><Download /> Export…<span className="ml-auto text-caption text-3">⌘E</span></DropdownMenuItem>
        <DropdownMenuItem disabled={!info?.hasAudio} onSelect={() => void revealRecording()}><FolderOpen /> Reveal saved recording</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <ExportSheet meetingId={meetingId} open={exportOpen} onOpenChange={setExportOpen} />
  </>;
}
