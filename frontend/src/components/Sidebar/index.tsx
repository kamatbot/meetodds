'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Home,
  Library,
  Mic,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useSidebar } from './SidebarProvider';
import type { CurrentMeeting } from './SidebarProvider';
import type { DeferredDeleteResponse } from '@/types/meeting';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import Analytics from '@/lib/analytics';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const GENERATED_TITLE = /^Meeting\s+\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/i;

function displayMeetingTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || GENERATED_TITLE.test(trimmed)) return 'Untitled meeting';
  return trimmed;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function errorDescription(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const navButtonClass =
  'flex h-[30px] w-full items-center gap-2.5 rounded-control px-2.5 text-left text-ui text-text transition-colors duration-150 hover:bg-surface';

const iconButtonClass =
  'inline-grid h-7 w-7 shrink-0 place-items-center rounded-control text-2 transition-colors duration-150 hover:bg-surface hover:text-text';

export default function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const {
    currentMeeting,
    setCurrentMeeting,
    handleRecordingToggle,
    meetings,
    setMeetings,
    refetchMeetings,
  } = useSidebar();
  const { isRecording, recordingDuration } = useRecordingState();
  const { openImportDialog } = useImportDialog();

  const [showAllMeetings, setShowAllMeetings] = useState(false);
  const [renameMeeting, setRenameMeeting] = useState<CurrentMeeting | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [isMutating, setIsMutating] = useState(false);

  useEffect(() => {
    const appWindow = window as Window & { openSettings?: () => void };
    appWindow.openSettings = () => router.push('/settings');
    return () => {
      delete appWindow.openSettings;
    };
  }, [router]);

  const openMeeting = useCallback((meeting: CurrentMeeting) => {
    setCurrentMeeting(meeting);
    router.push(`/meeting?id=${encodeURIComponent(meeting.id)}`);
  }, [router, setCurrentMeeting]);

  const recentMeetings = useMemo(
    () => (showAllMeetings ? meetings : meetings.slice(0, 8)),
    [meetings, showAllMeetings],
  );

  const startRename = (meeting: CurrentMeeting) => {
    setRenameMeeting(meeting);
    setRenameDraft(meeting.title);
  };

  const saveRename = async () => {
    if (!renameMeeting) return;
    const title = renameDraft.trim();
    if (!title) {
      toast.error('Meeting title cannot be empty');
      return;
    }

    setIsMutating(true);
    try {
      await invoke<void>('api_save_meeting_title', {
        meetingId: renameMeeting.id,
        title,
      });
      setMeetings(meetings.map((meeting) =>
        meeting.id === renameMeeting.id ? { ...meeting, title } : meeting,
      ));
      if (currentMeeting?.id === renameMeeting.id) {
        setCurrentMeeting({ id: renameMeeting.id, title });
      }
      Analytics.trackButtonClick('edit_meeting_title', 'sidebar');
      setRenameMeeting(null);
      setRenameDraft('');
      toast.success('Meeting title updated');
    } catch (error) {
      console.error('[Sidebar] Failed to rename meeting:', error);
      toast.error('Failed to update meeting title', {
        description: errorDescription(error),
      });
    } finally {
      setIsMutating(false);
    }
  };

  const restoreMeeting = useCallback(async (meeting: CurrentMeeting) => {
    try {
      await invoke<void>('api_restore_meeting', { meetingId: meeting.id });
      await refetchMeetings();
      toast.success('Meeting restored');
    } catch (error) {
      console.error('[Sidebar] Failed to restore meeting:', error);
      toast.error('Could not restore meeting', {
        description: errorDescription(error),
      });
    }
  }, [refetchMeetings]);

  const deleteMeetingWithUndo = useCallback(async (meeting: CurrentMeeting) => {
    try {
      await invoke<DeferredDeleteResponse>('api_defer_delete_meeting', {
        meetingId: meeting.id,
      });

      setMeetings(meetings.filter((candidate) => candidate.id !== meeting.id));
      Analytics.trackMeetingDeleted(meeting.id);

      if (currentMeeting?.id === meeting.id) {
        setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
        router.push('/');
      }

      await refetchMeetings();
      toast('Meeting deleted', {
        duration: 8_000,
        action: {
          label: 'Undo',
          onClick: () => void restoreMeeting(meeting),
        },
      });
    } catch (error) {
      console.error('[Sidebar] Failed to defer meeting deletion:', error);
      toast.error('Could not delete meeting', {
        description: errorDescription(error),
      });
      await refetchMeetings();
    }
  }, [currentMeeting?.id, meetings, refetchMeetings, restoreMeeting, router, setCurrentMeeting, setMeetings]);

  const renderMeetingRow = (meeting: CurrentMeeting) => {
    const isActive = currentMeeting?.id === meeting.id;
    return (
      <div
        key={meeting.id}
        className={`group flex min-w-0 items-start rounded-control transition-colors duration-150 ${
          isActive ? 'bg-accent-soft' : 'hover:bg-surface'
        }`}
      >
        <button
          type="button"
          onClick={() => openMeeting(meeting)}
          className="min-w-0 flex-1 px-2.5 py-1.5 text-left"
        >
          <span className={`block truncate text-ui ${isActive ? 'font-semibold text-accent' : 'text-text'}`}>
            {displayMeetingTitle(meeting.title)}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={`${iconButtonClass} mr-1 mt-1 opacity-0 focus:opacity-100 group-hover:opacity-100`}
              aria-label={`Actions for ${displayMeetingTitle(meeting.title)}`}
            >
              <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="border-border bg-surface text-text">
            <DropdownMenuItem onSelect={() => openMeeting(meeting)}>
              Open
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => startRename(meeting)}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              onSelect={() => void deleteMeetingWithUndo(meeting)}
              className="text-danger focus:bg-accent-soft focus:text-danger"
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  const isHome = pathname === '/';
  const isMeetings = pathname === '/meetings';
  const durationLabel = formatDuration(recordingDuration);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden border-r border-border bg-sidebar backdrop-blur-xl">
      <div data-tauri-drag-region className="h-[52px] shrink-0" aria-hidden="true" />

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('meetodds:open-command-palette'))}
          className="flex h-7 w-full items-center gap-2 rounded-control border border-border bg-surface px-2.5 text-left text-ui text-3 transition-colors duration-150 hover:text-text focus:outline-none"
          aria-label="Search meetings or run a command"
        >
          <Search className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">Search or run a command</span>
          <kbd className="rounded border border-border bg-bg px-1 text-[10px] leading-4 text-3">⌘K</kbd>
        </button>
      </div>

      {isRecording && (
        <button
          type="button"
          onClick={() => router.push('/')}
          className="mx-3 mb-2 flex h-[30px] items-center gap-2 rounded-control border border-record px-2.5 text-ui font-semibold text-record transition-colors duration-150 hover:bg-surface"
        >
          <span className="h-2 w-2 rounded-full bg-record" aria-hidden="true" />
          <span>Recording</span>
          {durationLabel && <span className="ml-auto font-mono text-caption font-normal">{durationLabel}</span>}
        </button>
      )}

      <nav className="grid shrink-0 gap-0.5 px-2" aria-label="Primary navigation">
        <button
          type="button"
          onClick={() => router.push('/')}
          className={`${navButtonClass} ${isHome ? 'bg-accent-soft font-semibold text-accent' : ''}`}
        >
          <Home className="h-4 w-4" strokeWidth={1.75} />
          Home
          <span className="ml-auto text-caption text-3">⌘1</span>
        </button>
        <button
          type="button"
          onClick={() => router.push('/meetings')}
          className={`${navButtonClass} ${isMeetings ? 'bg-accent-soft font-semibold text-accent' : ''}`}
        >
          <Library className="h-4 w-4" strokeWidth={1.75} />
          Meetings
          <span className="ml-auto text-caption text-3">⌘2</span>
        </button>
        <button
          type="button"
          onClick={() => router.push('/meetings?starred=1')}
          className={navButtonClass}
        >
          <Star className="h-4 w-4" strokeWidth={1.75} />
          Starred
          <span className="ml-auto text-caption text-3">⌘3</span>
        </button>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 custom-scrollbar">
        <section aria-label="Recent meetings">
          <div className="flex h-8 items-center px-2.5 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-3">
            Recent
          </div>
          <div className="grid gap-0.5">
            {recentMeetings.map((meeting) => renderMeetingRow(meeting))}
            {meetings.length === 0 && (
              <p className="px-2.5 py-4 text-caption text-3">No saved meetings yet.</p>
            )}
          </div>
          {meetings.length > 8 && (
            <button
              type="button"
              onClick={() => setShowAllMeetings((value) => !value)}
              className="mt-1 rounded-control px-2.5 py-1 text-caption font-medium text-3 transition-colors duration-150 hover:bg-surface hover:text-text"
            >
              {showAllMeetings ? 'Show recent' : `Show all ${meetings.length} →`}
            </button>
          )}
        </section>
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <button
          type="button"
          onClick={handleRecordingToggle}
          disabled={isRecording}
          className="flex h-[30px] w-full items-center justify-center gap-2 rounded-control border border-accent bg-accent px-3 text-ui font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Mic className="h-4 w-4" strokeWidth={1.75} />
          {isRecording ? 'Meeting in progress' : 'New meeting'}
          {!isRecording && <span className="ml-auto text-caption font-normal opacity-75">⌘N</span>}
        </button>

        <div className="mt-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => router.push('/settings')}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-1.5 text-ui text-text transition-colors duration-150 hover:bg-surface"
          >
            <Settings className="h-4 w-4" strokeWidth={1.75} />
            <span>Settings</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={iconButtonClass} aria-label="More sidebar actions">
                <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="border-border bg-surface text-text">
              <DropdownMenuItem onSelect={() => openImportDialog()}>
                <Upload /> Import audio…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => router.push('/settings?section=summary')}>
                <SlidersHorizontal /> Summary model…
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem onSelect={() => void refetchMeetings()}>
                <RefreshCw /> Refresh meetings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Dialog open={Boolean(renameMeeting)} onOpenChange={(open) => !open && setRenameMeeting(null)}>
        <DialogContent className="border-border bg-surface text-text sm:max-w-[420px]">
          <DialogTitle className="text-title">Rename meeting</DialogTitle>
          <div className="py-2">
            <label htmlFor="sidebar-meeting-title" className="mb-1.5 block text-ui font-medium text-2">
              Meeting title
            </label>
            <input
              id="sidebar-meeting-title"
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveRename();
                if (event.key === 'Escape') setRenameMeeting(null);
              }}
              autoFocus
              className="h-8 w-full rounded-control border border-border bg-bg px-2.5 text-body text-text focus:outline-none"
            />
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setRenameMeeting(null)}
              className="h-8 rounded-control border border-border bg-surface px-3 text-ui font-medium text-text hover:bg-bg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveRename()}
              disabled={isMutating}
              className="h-8 rounded-control border border-accent bg-accent px-3 text-ui font-semibold text-white disabled:opacity-50"
            >
              Save
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
