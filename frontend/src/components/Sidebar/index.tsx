'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, Home, Library, ListChecks, Mic, MoreHorizontal, Pencil, RefreshCw, Search, Settings, SlidersHorizontal, Star, Trash2, Upload } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useSidebar } from './SidebarProvider';
import type { CurrentMeeting } from './SidebarProvider';
import type { DeferredDeleteResponse } from '@/types/meeting';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import Analytics from '@/lib/analytics';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const GENERATED_TITLE = /^Meeting\s+\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/i;
function displayMeetingTitle(title: string): string { const trimmed = title.trim(); return !trimmed || GENERATED_TITLE.test(trimmed) ? 'Untitled meeting' : trimmed }
function formatDuration(seconds: number | null): string { if (seconds == null || !Number.isFinite(seconds)) return ''; const total = Math.max(0, Math.floor(seconds)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}` }
function errorDescription(error: unknown): string { return error instanceof Error ? error.message : String(error) }
const navButtonClass = 'flex h-[34px] w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[13.5px] font-medium text-text transition-colors duration-150 hover:bg-[var(--hover)]';
const iconButtonClass = 'inline-grid h-7 w-7 shrink-0 place-items-center rounded-[9px] text-2 transition-colors duration-150 hover:bg-[var(--hover)] hover:text-text';

export default function Sidebar() {
  const router = useRouter(); const pathname = usePathname();
  const { currentMeeting, setCurrentMeeting, handleRecordingToggle, meetings, setMeetings, refetchMeetings } = useSidebar();
  const { isRecording, recordingDuration } = useRecordingState(); const { openImportDialog } = useImportDialog();
  const [showAllMeetings, setShowAllMeetings] = useState(false); const [renameMeeting, setRenameMeeting] = useState<CurrentMeeting | null>(null); const [renameDraft, setRenameDraft] = useState(''); const [isMutating, setIsMutating] = useState(false);

  useEffect(() => { const appWindow = window as Window & { openSettings?: () => void }; appWindow.openSettings = () => router.push('/settings'); return () => { delete appWindow.openSettings } }, [router]);
  const openMeeting = useCallback((meeting: CurrentMeeting) => { setCurrentMeeting(meeting); router.push(`/meeting?id=${encodeURIComponent(meeting.id)}`) }, [router, setCurrentMeeting]);
  const recentMeetings = useMemo(() => (showAllMeetings ? meetings : meetings.slice(0, 8)), [meetings, showAllMeetings]);
  const startRename = (meeting: CurrentMeeting) => { setRenameMeeting(meeting); setRenameDraft(meeting.title) };
  const saveRename = async () => {
    if (!renameMeeting) return; const title = renameDraft.trim(); if (!title) { toast.error('Meeting title cannot be empty'); return }
    setIsMutating(true);
    try { await invoke<void>('api_save_meeting_title', { meetingId: renameMeeting.id, title }); setMeetings(meetings.map(m => m.id === renameMeeting.id ? { ...m, title } : m)); if (currentMeeting?.id === renameMeeting.id) setCurrentMeeting({ id: renameMeeting.id, title }); Analytics.trackButtonClick('edit_meeting_title', 'sidebar'); setRenameMeeting(null); setRenameDraft(''); toast.success('Meeting title updated') }
    catch (error) { console.error('[Sidebar] Failed to rename meeting:', error); toast.error('Failed to update meeting title', { description: errorDescription(error) }) }
    finally { setIsMutating(false) }
  };
  const restoreMeeting = useCallback(async (meeting: CurrentMeeting) => { try { await invoke<void>('api_restore_meeting', { meetingId: meeting.id }); await refetchMeetings(); toast.success('Meeting restored') } catch (error) { toast.error('Could not restore meeting', { description: errorDescription(error) }) } }, [refetchMeetings]);
  const deleteMeetingWithUndo = useCallback(async (meeting: CurrentMeeting) => {
    try { await invoke<DeferredDeleteResponse>('api_defer_delete_meeting', { meetingId: meeting.id }); setMeetings(meetings.filter(candidate => candidate.id !== meeting.id)); Analytics.trackMeetingDeleted(meeting.id); if (currentMeeting?.id === meeting.id) { setCurrentMeeting({ id: 'intro-call', title: '+ New Call' }); router.push('/') } await refetchMeetings(); toast('Meeting deleted', { duration: 8_000, action: { label: 'Undo', onClick: () => void restoreMeeting(meeting) } }) }
    catch (error) { toast.error('Could not delete meeting', { description: errorDescription(error) }); await refetchMeetings() }
  }, [currentMeeting?.id, meetings, refetchMeetings, restoreMeeting, router, setCurrentMeeting, setMeetings]);
  const renderMeetingRow = (meeting: CurrentMeeting) => {
    const isActive = currentMeeting?.id === meeting.id;
    return <div key={meeting.id} className={`group flex h-[30px] min-w-0 items-center rounded-[9px] transition-colors ${isActive ? 'bg-accent-soft' : 'hover:bg-[var(--hover)]'}`}>
      <button type="button" onClick={() => openMeeting(meeting)} className="min-w-0 flex-1 px-3 text-left"><span className={`block truncate text-[12.5px] ${isActive ? 'font-semibold text-accent' : 'text-text'}`}>{displayMeetingTitle(meeting.title)}</span></button>
      <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={`${iconButtonClass} mr-1 opacity-0 focus:opacity-100 group-hover:opacity-100`} aria-label={`Actions for ${displayMeetingTitle(meeting.title)}`}><MoreHorizontal className="h-3.5 w-3.5" /></button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="border-border bg-surface text-text"><DropdownMenuItem onSelect={() => openMeeting(meeting)}>Open</DropdownMenuItem><DropdownMenuItem onSelect={() => startRename(meeting)}><Pencil /> Rename</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void deleteMeetingWithUndo(meeting)} className="text-danger"><Trash2 /> Delete</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>
    </div>;
  };
  const isHome = pathname === '/'; const isMeetings = pathname === '/meetings'; const isActions = pathname === '/actions'; const isMemory = pathname === '/memory'; const isStarred = pathname === '/meetings' && new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('starred') === '1'; const durationLabel = formatDuration(recordingDuration);
  const navItem = (active: boolean) => `${navButtonClass} ${active ? 'bg-accent-soft font-semibold text-accent' : ''}`;

  return <div className="flex h-full w-full flex-col overflow-hidden border-r border-border bg-sidebar">
    <div data-tauri-drag-region className="h-[52px] shrink-0" aria-hidden="true" />
    <div className="px-3 pb-2"><button type="button" onClick={() => window.dispatchEvent(new Event('meetodds:open-command-palette'))} className="flex h-9 w-full items-center gap-2 rounded-[11px] border border-border bg-panel px-3 text-left text-[12.5px] text-3 shadow-[0_1px_1px_rgba(20,18,16,.02)] hover:border-[color:var(--text-3)] hover:text-text" aria-label="Search meetings or run a command"><Search className="h-3.5 w-3.5" /><span className="min-w-0 flex-1 truncate">Search or run a command</span><kbd className="rounded-md border border-border bg-panel-2 px-1.5 py-0.5 text-[9px] text-3">⌘K</kbd></button></div>
    {isRecording && <button type="button" onClick={() => router.push('/')} className="mx-3 mb-2 flex h-9 items-center gap-2 rounded-[10px] border border-record/25 bg-record/5 px-3 text-[12.5px] font-semibold text-record"><span className="h-2 w-2 rounded-full bg-record" /><span>Recording</span>{durationLabel && <span className="ml-auto font-mono text-[11px] font-medium">{durationLabel}</span>}</button>}
    <nav className="grid shrink-0 gap-0.5 px-2.5" aria-label="Primary navigation">
      <button type="button" onClick={() => router.push('/')} className={navItem(isHome)}><Home className="h-4 w-4" strokeWidth={1.8} />Home<span className="ml-auto font-mono text-[9.5px] text-3">⌘1</span></button>
      <button type="button" onClick={() => router.push('/meetings')} className={navItem(isMeetings && !isStarred)}><Library className="h-4 w-4" strokeWidth={1.8} />Meetings<span className="ml-auto font-mono text-[9.5px] text-3">⌘2</span></button>
      <button type="button" onClick={() => router.push('/actions')} className={navItem(isActions)}><ListChecks className="h-4 w-4" strokeWidth={1.8} />Actions</button>
      <button type="button" onClick={() => router.push('/memory')} className={navItem(isMemory)}><Brain className="h-4 w-4" strokeWidth={1.8} />Memory</button>
      <button type="button" onClick={() => router.push('/meetings?starred=1')} className={navItem(isStarred)}><Star className="h-4 w-4" strokeWidth={1.8} />Starred<span className="ml-auto font-mono text-[9.5px] text-3">⌘3</span></button>
    </nav>
    <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2 custom-scrollbar"><section aria-label="Recent meetings"><div className="horizon-eyebrow flex h-10 items-end px-3 pb-2">Recent</div><div className="grid gap-0.5">{recentMeetings.map(renderMeetingRow)}{meetings.length === 0 && <p className="px-3 py-4 text-xs text-3">No saved meetings yet.</p>}</div>{meetings.length > 8 && <button type="button" onClick={() => setShowAllMeetings(v => !v)} className="mt-1 rounded-[9px] px-3 py-1.5 text-[11px] font-medium text-3 hover:bg-[var(--hover)] hover:text-text">{showAllMeetings ? 'Show recent' : `Show all ${meetings.length} →`}</button>}</section></div>
    <div className="shrink-0 border-t border-border p-3">
      <button type="button" onClick={handleRecordingToggle} disabled={isRecording} className={`flex h-[42px] w-full items-center justify-center gap-2 rounded-[11px] px-3 text-[12.5px] font-semibold transition ${isRecording ? 'border border-border bg-panel text-2' : 'border border-accent bg-accent text-accent-foreground shadow-[0_6px_18px_rgba(204,72,5,.16)] hover:brightness-95'}`}><Mic className="h-4 w-4" />{isRecording ? 'Meeting in progress' : 'New meeting'}{!isRecording && <span className="ml-auto font-mono text-[9.5px] opacity-75">⌘N</span>}</button>
      <div className="mt-2 flex h-9 items-center gap-1"><button type="button" onClick={() => router.push('/settings')} className="flex min-w-0 flex-1 items-center gap-2 rounded-[9px] px-2.5 text-[12.5px] font-medium text-text hover:bg-[var(--hover)]"><Settings className="h-4 w-4" /><span>Settings</span></button><span className="ml-auto inline-flex items-center gap-1.5 pr-1 font-mono text-[9.5px] text-3"><i className="h-1.5 w-1.5 rounded-full bg-success" />Ready</span><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={iconButtonClass} aria-label="More sidebar actions"><MoreHorizontal className="h-4 w-4" /></button></DropdownMenuTrigger><DropdownMenuContent align="end" side="top"><DropdownMenuItem onSelect={() => openImportDialog()}><Upload /> Import audio…</DropdownMenuItem><DropdownMenuItem onSelect={() => router.push('/settings?section=summary')}><SlidersHorizontal /> Summary model…</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void refetchMeetings()}><RefreshCw /> Refresh meetings</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
    </div>
    <Dialog open={Boolean(renameMeeting)} onOpenChange={(open) => !open && setRenameMeeting(null)}><DialogContent className="border-border bg-surface text-text sm:max-w-[420px]"><DialogTitle className="text-title">Rename meeting</DialogTitle><div className="py-2"><label htmlFor="sidebar-meeting-title" className="mb-1.5 block text-ui font-medium text-2">Meeting title</label><input id="sidebar-meeting-title" value={renameDraft} onChange={e => setRenameDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void saveRename(); if (e.key === 'Escape') setRenameMeeting(null) }} autoFocus className="h-9 w-full rounded-[10px] border border-border bg-bg px-3 text-body text-text focus:outline-none" /></div><DialogFooter><button type="button" onClick={() => setRenameMeeting(null)} className="h-9 rounded-[10px] border border-border bg-surface px-3 text-ui font-medium">Cancel</button><button type="button" onClick={() => void saveRename()} disabled={isMutating} className="h-9 rounded-[10px] bg-accent px-4 text-ui font-semibold text-accent-foreground disabled:opacity-50">Save</button></DialogFooter></DialogContent></Dialog>
  </div>;
}
