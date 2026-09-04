'use client';

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import ShareMenu from '@/components/Meeting/ShareMenu';
import type { DeferredDeleteResponse, MeetingListPage } from '@/types/meeting';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type MeetingDetailTab = 'summary' | 'notes' | 'transcript';

interface MeetingHeaderProps {
  meetingId: string;
  title: string;
  createdAt: string;
  activeTab: MeetingDetailTab;
  onTabChange: (tab: MeetingDetailTab) => void;
  onTitleSaved: (title: string) => void;
  onDeleted: () => void;
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

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatDuration(durationMs: number | null): string | null {
  if (durationMs == null || !Number.isFinite(durationMs)) return null;
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

const tabs: Array<{ id: MeetingDetailTab; label: string; shortcut: string }> = [
  { id: 'summary', label: 'Summary', shortcut: '⌃1' },
  { id: 'notes', label: 'Notes', shortcut: '⌃2' },
  { id: 'transcript', label: 'Transcript', shortcut: '⌃3' },
];

export default function MeetingHeader({
  meetingId,
  title,
  createdAt,
  activeTab,
  onTabChange,
  onTitleSaved,
  onDeleted,
}: MeetingHeaderProps) {
  const {
    currentMeeting,
    setCurrentMeeting,
    meetings,
    setMeetings,
    refetchMeetings,
  } = useSidebar();
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelBlurRef = useRef(false);
  const [savedTitle, setSavedTitle] = useState(title);
  const [draftTitle, setDraftTitle] = useState(title);
  const [editing, setEditing] = useState(false);
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [starred, setStarred] = useState(false);
  const [starStateLoaded, setStarStateLoaded] = useState(false);
  const [durationMs, setDurationMs] = useState<number | null>(null);

  useEffect(() => {
    setSavedTitle(title);
    setDraftTitle(title);
  }, [meetingId, title]);

  useEffect(() => {
    let cancelled = false;
    setStarStateLoaded(false);

    const loadLibraryState = async () => {
      try {
        const page = await invoke<MeetingListPage>('api_list_meetings', {
          request: {
            limit: 100,
            query: title,
            sort: 'newest',
          },
        });
        if (cancelled) return;
        const item = page.items.find((candidate) => candidate.id === meetingId);
        if (item) {
          setStarred(item.starred);
          setDurationMs(item.durationMs);
        }
      } catch (error) {
        console.warn('[MeetingHeader] Could not load library metadata:', error);
      } finally {
        if (!cancelled) setStarStateLoaded(true);
      }
    };

    void loadLibraryState();
    return () => {
      cancelled = true;
    };
  }, [meetingId, title]);

  const beginRename = () => {
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        beginRename();
        return;
      }

      if (event.ctrlKey && !event.metaKey && ['1', '2', '3'].includes(event.key)) {
        event.preventDefault();
        onTabChange(tabs[Number(event.key) - 1].id);
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [onTabChange]);

  const saveTitle = async () => {
    if (cancelBlurRef.current) {
      cancelBlurRef.current = false;
      return;
    }

    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      setDraftTitle(savedTitle);
      setEditing(false);
      toast.error('Meeting title cannot be empty');
      return;
    }
    if (nextTitle === savedTitle) {
      setEditing(false);
      return;
    }

    setIsSavingTitle(true);
    try {
      await invoke<void>('api_rename_meeting', {
        meetingId,
        title: nextTitle,
      });
      setSavedTitle(nextTitle);
      setDraftTitle(nextTitle);
      setEditing(false);
      setMeetings(meetings.map((meeting) => (
        meeting.id === meetingId ? { ...meeting, title: nextTitle } : meeting
      )));
      if (currentMeeting?.id === meetingId) {
        setCurrentMeeting({ id: meetingId, title: nextTitle });
      }
      onTitleSaved(nextTitle);
      await refetchMeetings();
    } catch (error) {
      console.error('[MeetingHeader] Failed to rename meeting:', error);
      setDraftTitle(savedTitle);
      toast.error('Could not rename meeting', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsSavingTitle(false);
    }
  };

  const toggleStar = async () => {
    if (!starStateLoaded) return;
    const next = !starred;
    setStarred(next);
    try {
      await invoke<void>('api_set_meeting_starred', { meetingId, starred: next });
      await refetchMeetings();
    } catch (error) {
      setStarred(!next);
      console.error('[MeetingHeader] Failed to update starred state:', error);
      toast.error('Could not update starred state', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const deleteMeeting = async () => {
    try {
      await invoke<DeferredDeleteResponse>('api_defer_delete_meeting', { meetingId });
      await refetchMeetings();
      onDeleted();
      toast('Meeting deleted', {
        duration: 8_000,
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await invoke<void>('api_restore_meeting', { meetingId });
                await refetchMeetings();
                toast.success('Meeting restored');
              } catch (error) {
                toast.error('Could not restore meeting', {
                  description: error instanceof Error ? error.message : String(error),
                });
              }
            })();
          },
        },
      });
    } catch (error) {
      console.error('[MeetingHeader] Failed to delete meeting:', error);
      toast.error('Could not delete meeting', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const openMeetingFolder = async () => {
    try {
      await invoke<void>('open_meeting_folder', { meetingId });
    } catch (error) {
      console.error('[MeetingHeader] Failed to open meeting folder:', error);
      toast.error('Could not open meeting folder', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const durationLabel = formatDuration(durationMs);

  return (
    <header className="shrink-0 border-b border-border bg-bg">
      <div className="flex items-start gap-4 px-5 pb-3 pt-4 md:px-6">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              ref={inputRef}
              value={draftTitle}
              disabled={isSavingTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  inputRef.current?.blur();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelBlurRef.current = true;
                  setDraftTitle(savedTitle);
                  setEditing(false);
                  inputRef.current?.blur();
                }
              }}
              className="h-8 w-full max-w-[620px] rounded-control border border-accent bg-surface px-2.5 text-title text-text outline-none"
              aria-label="Meeting title"
            />
          ) : (
            <button
              type="button"
              onClick={beginRename}
              className="group flex min-w-0 max-w-[680px] items-center gap-2 text-left"
              title="Rename meeting (⌘⇧R)"
            >
              <h1 className="truncate text-display text-text">{savedTitle || 'Untitled meeting'}</h1>
              <Pencil className="h-3.5 w-3.5 shrink-0 text-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" strokeWidth={1.75} />
            </button>
          )}
          <p className="mt-1 text-caption text-3">
            {formatCreatedAt(createdAt)}{durationLabel ? ` · ${durationLabel}` : ''}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void toggleStar()}
            disabled={!starStateLoaded}
            aria-label={starred ? 'Unstar meeting' : 'Star meeting'}
            aria-pressed={starred}
            className={`inline-grid h-8 w-8 place-items-center rounded-control border border-border bg-surface transition-colors duration-150 hover:bg-bg disabled:opacity-40 ${starred ? 'text-accent' : 'text-2'}`}
          >
            <Star className="h-4 w-4" fill={starred ? 'currentColor' : 'none'} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => void openMeetingFolder()}
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-ui font-medium text-text transition-colors duration-150 hover:bg-bg"
            title="Open meeting folder in Finder"
          >
            <FolderOpen className="h-4 w-4" strokeWidth={1.75} />
            <span className="hidden lg:inline">Open folder</span>
          </button>
          <ShareMenu meetingId={meetingId} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-grid h-8 w-8 place-items-center rounded-control border border-border bg-surface text-2 hover:bg-bg hover:text-text"
                aria-label="More meeting actions"
              >
                <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-surface text-text">
              <DropdownMenuItem onSelect={beginRename}>
                <Pencil /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!starStateLoaded} onSelect={() => void toggleStar()}>
                <Star /> {starred ? 'Unstar' : 'Star'}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onSelect={() => void deleteMeeting()}
                className="text-danger focus:bg-accent-soft focus:text-danger"
              >
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <nav className="flex h-9 items-end gap-1 px-5 md:px-6" aria-label="Meeting detail sections">
        {tabs.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onTabChange(tab.id)}
              className={`relative h-9 rounded-t-control px-3 text-ui font-medium transition-colors duration-150 ${
                selected ? 'text-text' : 'text-3 hover:text-text'
              }`}
            >
              {tab.label}
              <span className="ml-1.5 text-[10px] text-3">{tab.shortcut}</span>
              {selected && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
