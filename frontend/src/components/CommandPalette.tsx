'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import {
  Home,
  Library,
  LoaderCircle,
  Mic,
  PanelLeft,
  Search,
  Settings,
  Upload,
} from 'lucide-react';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';

interface CommandPaletteProps {
  onToggleSidebar: () => void;
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

function displayMeetingTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || /^Meeting\s+\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/i.test(trimmed)) {
    return 'Untitled meeting';
  }
  return trimmed;
}

export default function CommandPalette({ onToggleSidebar }: CommandPaletteProps) {
  const router = useRouter();
  const {
    meetings,
    setCurrentMeeting,
    handleRecordingToggle,
    searchTranscripts,
    searchResults,
    isSearching,
  } = useSidebar();
  const { openImportDialog } = useImportDialog();
  const { betaFeatures } = useConfig();
  const { isRecording } = useRecordingState();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchTranscriptsRef = useRef(searchTranscripts);

  useEffect(() => {
    searchTranscriptsRef.current = searchTranscripts;
  }, [searchTranscripts]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        event.metaKey &&
        event.key.toLowerCase() === 'k' &&
        !isEditableTarget(event.target)
      ) {
        event.preventDefault();
        event.stopPropagation();
        setOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', handleShortcut, true);
    return () => window.removeEventListener('keydown', handleShortcut, true);
  }, []);

  useEffect(() => {
    const openFromUi = () => setOpen(true);
    window.addEventListener('meetodds:open-command-palette', openFromUi);
    return () => window.removeEventListener('meetodds:open-command-palette', openFromUi);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery('');
      void searchTranscriptsRef.current('');
      return;
    }

    const trimmed = query.trim();
    const timer = window.setTimeout(() => {
      void searchTranscriptsRef.current(trimmed);
    }, trimmed ? 120 : 0);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const meetingMatches = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];

    const results = new Map<string, { id: string; title: string; matchContext?: string }>();
    for (const result of searchResults) {
      results.set(result.id, {
        id: result.id,
        title: result.title,
        matchContext: result.matchContext,
      });
    }
    for (const meeting of meetings) {
      if (meeting.title.toLowerCase().includes(trimmed) && !results.has(meeting.id)) {
        results.set(meeting.id, meeting);
      }
    }
    return [...results.values()].slice(0, 8);
  }, [meetings, query, searchResults]);

  const run = (action: () => void) => {
    setOpen(false);
    requestAnimationFrame(action);
  };

  const openMeeting = (meeting: { id: string; title: string }) => {
    run(() => {
      setCurrentMeeting({ id: meeting.id, title: meeting.title });
      router.push(`/meeting-details?id=${encodeURIComponent(meeting.id)}`);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="overflow-hidden border-border bg-surface p-0 text-text shadow-popover sm:max-w-[560px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">Search meetings and run commands</DialogTitle>
        <Command className="bg-surface text-text" loop>
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search className="h-4 w-4 shrink-0 text-3" strokeWidth={1.75} aria-hidden="true" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search meetings or run a command…"
              className="h-12 min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-3"
            />
            <kbd className="rounded border border-border bg-bg px-1.5 text-[10px] leading-5 text-3">⌘K</kbd>
          </div>

          <Command.List className="max-h-[420px] overflow-y-auto p-2 custom-scrollbar">
            <Command.Empty className="px-3 py-8 text-center text-ui text-3">
              {isSearching ? 'Searching meetings…' : 'No matching meetings or commands.'}
            </Command.Empty>

            <Command.Group
              heading="Actions"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-3"
            >
              <Command.Item
                value="new meeting start recording"
                disabled={isRecording}
                onSelect={() => run(handleRecordingToggle)}
                className="flex h-9 cursor-default items-center gap-2 rounded-control px-2 text-ui text-text aria-selected:bg-accent-soft data-[disabled=true]:opacity-40"
              >
                <Mic className="h-4 w-4 text-record" strokeWidth={1.75} />
                New meeting
                <span className="ml-auto text-caption text-3">⌘N</span>
              </Command.Item>
              <Command.Item
                value="import audio file"
                disabled={!betaFeatures.importAndRetranscribe}
                onSelect={() => run(() => openImportDialog())}
                className="flex h-9 cursor-default items-center gap-2 rounded-control px-2 text-ui text-text aria-selected:bg-accent-soft data-[disabled=true]:opacity-40"
              >
                <Upload className="h-4 w-4 text-2" strokeWidth={1.75} />
                Import audio…
                {!betaFeatures.importAndRetranscribe && (
                  <span className="ml-auto text-caption text-3">Enable Beta in Settings</span>
                )}
              </Command.Item>
              <Command.Item
                value="open settings preferences"
                onSelect={() => run(() => router.push('/settings'))}
                className="flex h-9 cursor-default items-center gap-2 rounded-control px-2 text-ui text-text aria-selected:bg-accent-soft"
              >
                <Settings className="h-4 w-4 text-2" strokeWidth={1.75} />
                Open Settings
              </Command.Item>
              <Command.Item
                value="toggle sidebar show hide"
                onSelect={() => run(onToggleSidebar)}
                className="flex h-9 cursor-default items-center gap-2 rounded-control px-2 text-ui text-text aria-selected:bg-accent-soft"
              >
                <PanelLeft className="h-4 w-4 text-2" strokeWidth={1.75} />
                Toggle sidebar
                <span className="ml-auto text-caption text-3">⌃⌘S</span>
              </Command.Item>
            </Command.Group>

            <Command.Separator className="my-2 h-px bg-border" />

            <Command.Group
              heading="Navigate"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-3"
            >
              <Command.Item
                value="home dashboard"
                onSelect={() => run(() => router.push('/'))}
                className="flex h-9 cursor-default items-center gap-2 rounded-control px-2 text-ui text-text aria-selected:bg-accent-soft"
              >
                <Home className="h-4 w-4 text-2" strokeWidth={1.75} />
                Home
                <span className="ml-auto text-caption text-3">⌘1</span>
              </Command.Item>
              <Command.Item
                value="meetings library"
                onSelect={() => run(() => router.push('/meetings'))}
                className="flex h-9 cursor-default items-center gap-2 rounded-control px-2 text-ui text-text aria-selected:bg-accent-soft"
              >
                <Library className="h-4 w-4 text-2" strokeWidth={1.75} />
                Meetings
                <span className="ml-auto text-caption text-3">⌘2</span>
              </Command.Item>
            </Command.Group>

            {query.trim() && (
              <>
                <Command.Separator className="my-2 h-px bg-border" />
                <Command.Group
                  heading="Meetings"
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-3"
                >
                  {isSearching && meetingMatches.length === 0 && (
                    <div className="flex h-10 items-center px-2 text-ui text-3">
                      <LoaderCircle className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.75} />
                      Searching transcripts…
                    </div>
                  )}
                  {meetingMatches.map((meeting) => (
                    <Command.Item
                      key={meeting.id}
                      value={`${meeting.title} ${meeting.matchContext ?? ''}`}
                      onSelect={() => openMeeting(meeting)}
                      className="flex min-h-11 cursor-default items-start gap-2 rounded-control px-2 py-2 text-ui text-text aria-selected:bg-accent-soft"
                    >
                      <Search className="mt-0.5 h-4 w-4 shrink-0 text-3" strokeWidth={1.75} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{displayMeetingTitle(meeting.title)}</span>
                        {meeting.matchContext && (
                          <span className="mt-0.5 block line-clamp-1 text-caption text-3">
                            {meeting.matchContext}
                          </span>
                        )}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              </>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
