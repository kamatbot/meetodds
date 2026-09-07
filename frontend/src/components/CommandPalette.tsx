'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import {
  Bot,
  Brain,
  Download,
  Home,
  Library,
  ListChecks,
  LoaderCircle,
  Mic,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Search,
  Settings,
  Upload,
} from 'lucide-react';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useImportDialog } from '@/contexts/ImportDialogContext';
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

const groupClass = '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-3';
const itemClass = 'flex h-9 cursor-default items-center gap-2 rounded-control px-2 text-ui text-text aria-selected:bg-accent-soft data-[disabled=true]:opacity-40';

export default function CommandPalette({ onToggleSidebar }: CommandPaletteProps) {
  const router = useRouter();
  const {
    currentMeeting,
    meetings,
    setCurrentMeeting,
    handleRecordingToggle,
    searchTranscripts,
    searchResults,
    isSearching,
  } = useSidebar();
  const { openImportDialog } = useImportDialog();
  const { isRecording } = useRecordingState();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchTranscriptsRef = useRef(searchTranscripts);

  const trimmedQuery = query.trim();
  const commandMode = trimmedQuery.startsWith('>');
  const searchQuery = commandMode ? '' : trimmedQuery;
  const hasSavedCurrentMeeting = Boolean(
    currentMeeting?.id && currentMeeting.id !== 'intro-call',
  );

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
    if (!open || commandMode) {
      void searchTranscriptsRef.current('');
      return;
    }

    const timer = window.setTimeout(() => {
      void searchTranscriptsRef.current(searchQuery);
    }, searchQuery ? 80 : 0);
    return () => window.clearTimeout(timer);
  }, [commandMode, open, searchQuery]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const meetingMatches = useMemo(() => {
    const normalized = searchQuery.toLowerCase();
    if (!normalized) return [];

    const results = new Map<string, { id: string; title: string; matchContext?: string }>();
    for (const result of searchResults) {
      results.set(result.id, {
        id: result.id,
        title: result.title,
        matchContext: result.matchContext,
      });
    }
    for (const meeting of meetings) {
      if (meeting.title.toLowerCase().includes(normalized) && !results.has(meeting.id)) {
        results.set(meeting.id, meeting);
      }
    }
    return [...results.values()].slice(0, 10);
  }, [meetings, searchQuery, searchResults]);

  const run = (action: () => void) => {
    setOpen(false);
    requestAnimationFrame(action);
  };

  const openMeeting = (meeting: { id: string; title: string }, transcript = false) => {
    run(() => {
      setCurrentMeeting({ id: meeting.id, title: meeting.title });
      router.push(`/meeting?id=${encodeURIComponent(meeting.id)}${transcript ? '&tab=transcript' : ''}`);
    });
  };

  const openExport = () => {
    if (!currentMeeting || currentMeeting.id === 'intro-call') return;
    run(() => {
      router.push(`/meeting?id=${encodeURIComponent(currentMeeting.id)}&export=1`);
    });
  };

  const showHomeActions = trimmedQuery.length === 0;
  const showSearchResults = !commandMode && searchQuery.length > 0;

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
              placeholder="Search meetings · type > for commands"
              className="h-12 min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-3"
            />
            <kbd className="rounded border border-border bg-bg px-1.5 text-[10px] leading-5 text-3">⌘K</kbd>
          </div>

          <Command.List className="max-h-[420px] overflow-y-auto p-2 custom-scrollbar">
            <Command.Empty className="px-3 py-8 text-center text-ui text-3">
              {isSearching ? 'Searching meetings…' : commandMode ? 'No matching command.' : 'No matching meetings.'}
            </Command.Empty>

            {showHomeActions && (
              <>
                <Command.Group heading="Actions" className={groupClass}>
                  <Command.Item
                    value="new meeting start recording"
                    disabled={isRecording}
                    onSelect={() => run(handleRecordingToggle)}
                    className={itemClass}
                  >
                    <Mic className="h-4 w-4 text-record" strokeWidth={1.75} />
                    New meeting
                    <span className="ml-auto text-caption text-3">⌘N</span>
                  </Command.Item>
                  <Command.Item
                    value="import audio file"
                    onSelect={() => run(() => openImportDialog())}
                    className={itemClass}
                  >
                    <Upload className="h-4 w-4 text-2" strokeWidth={1.75} />
                    Import audio…
                  </Command.Item>
                  <Command.Item
                    value="open settings preferences"
                    onSelect={() => run(() => router.push('/settings'))}
                    className={itemClass}
                  >
                    <Settings className="h-4 w-4 text-2" strokeWidth={1.75} />
                    Open Settings
                    <span className="ml-auto text-caption text-3">⌘,</span>
                  </Command.Item>
                </Command.Group>

                <Command.Separator className="my-2 h-px bg-border" />

                <Command.Group heading="Navigate" className={groupClass}>
                  <Command.Item
                    value="home dashboard"
                    onSelect={() => run(() => router.push('/'))}
                    className={itemClass}
                  >
                    <Home className="h-4 w-4 text-2" strokeWidth={1.75} />
                    Home
                    <span className="ml-auto text-caption text-3">⌘1</span>
                  </Command.Item>
                  <Command.Item
                    value="meetings library"
                    onSelect={() => run(() => router.push('/meetings'))}
                    className={itemClass}
                  >
                    <Library className="h-4 w-4 text-2" strokeWidth={1.75} />
                    Meetings
                    <span className="ml-auto text-caption text-3">⌘2</span>
                  </Command.Item>
                  <Command.Item
                    value="actions commitments action inbox"
                    onSelect={() => run(() => router.push('/actions'))}
                    className={itemClass}
                  >
                    <ListChecks className="h-4 w-4 text-2" strokeWidth={1.75} />
                    Action inbox
                  </Command.Item>
                  <Command.Item
                    value="meeting memory ask recall search"
                    onSelect={() => run(() => router.push('/memory'))}
                    className={itemClass}
                  >
                    <Brain className="h-4 w-4 text-2" strokeWidth={1.75} />
                    Meeting memory
                  </Command.Item>
                  <Command.Item
                    value="toggle sidebar show hide"
                    onSelect={() => run(onToggleSidebar)}
                    className={itemClass}
                  >
                    <PanelLeft className="h-4 w-4 text-2" strokeWidth={1.75} />
                    Toggle sidebar
                    <span className="ml-auto text-caption text-3">⌃⌘S</span>
                  </Command.Item>
                </Command.Group>
              </>
            )}

            {commandMode && (
              <Command.Group heading="Commands" className={groupClass}>
                <Command.Item
                  value="> new meeting start recording"
                  disabled={isRecording}
                  onSelect={() => run(handleRecordingToggle)}
                  className={itemClass}
                >
                  <Mic className="h-4 w-4 text-record" strokeWidth={1.75} />
                  New meeting
                </Command.Item>
                <Command.Item
                  value="> import audio file"
                  onSelect={() => run(() => openImportDialog())}
                  className={itemClass}
                >
                  <Upload className="h-4 w-4 text-2" strokeWidth={1.75} />
                  Import audio…
                </Command.Item>
                <Command.Item
                  value="> toggle transcript live drawer"
                  disabled={!isRecording}
                  onSelect={() => run(() => window.dispatchEvent(new Event('meetodds:toggle-transcript-drawer')))}
                  className={itemClass}
                >
                  <PanelRight className="h-4 w-4 text-2" strokeWidth={1.75} />
                  Toggle live transcript
                </Command.Item>
                <Command.Item
                  value="> export meeting current"
                  disabled={!hasSavedCurrentMeeting}
                  onSelect={openExport}
                  className={itemClass}
                >
                  <Download className="h-4 w-4 text-2" strokeWidth={1.75} />
                  Export current meeting…
                  <span className="ml-auto text-caption text-3">⌘E</span>
                </Command.Item>
                <Command.Item
                  value="> switch summary model ai provider"
                  onSelect={() => run(() => router.push('/settings?section=summary'))}
                  className={itemClass}
                >
                  <Bot className="h-4 w-4 text-2" strokeWidth={1.75} />
                  Switch summary model…
                </Command.Item>
                <Command.Item
                  value="> change microphone recording audio device"
                  onSelect={() => run(() => router.push('/settings?section=recording'))}
                  className={itemClass}
                >
                  <Mic className="h-4 w-4 text-2" strokeWidth={1.75} />
                  Change microphone…
                </Command.Item>
                <Command.Item
                  value="> check for updates about version"
                  onSelect={() => run(() => router.push('/settings?section=about'))}
                  className={itemClass}
                >
                  <RefreshCw className="h-4 w-4 text-2" strokeWidth={1.75} />
                  Check for updates…
                </Command.Item>
                <Command.Item
                  value="> open settings preferences"
                  onSelect={() => run(() => router.push('/settings'))}
                  className={itemClass}
                >
                  <Settings className="h-4 w-4 text-2" strokeWidth={1.75} />
                  Open Settings…
                </Command.Item>
              </Command.Group>
            )}

            {showSearchResults && (
              <Command.Group heading="Meetings" className={groupClass}>
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
                    onSelect={() => openMeeting(meeting, Boolean(meeting.matchContext))}
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
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
