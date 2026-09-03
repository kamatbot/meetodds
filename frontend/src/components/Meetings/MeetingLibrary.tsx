'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useRouter, useSearchParams } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  LoaderCircle,
  MoreHorizontal,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import MeetingRow from './MeetingRow';
import { useMeetingList } from '@/hooks/useMeetingList';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import type {
  DeferredDeleteResponse,
  MeetingListItem,
  MeetingListSort,
} from '@/types/meeting';

interface HeaderEntry {
  kind: 'header';
  key: string;
  label: string;
}

interface MeetingEntry {
  kind: 'meeting';
  key: string;
  item: MeetingListItem;
}

type LibraryEntry = HeaderEntry | MeetingEntry;

interface ContextMenuState {
  item: MeetingListItem;
  x: number;
  y: number;
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

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfLocalWeek(date: Date): Date {
  const day = startOfLocalDay(date);
  const weekday = day.getDay();
  const distanceFromMonday = (weekday + 6) % 7;
  day.setDate(day.getDate() - distanceFromMonday);
  return day;
}

function groupLabel(createdAt: string, now = new Date()): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 'Unknown date';

  const day = startOfLocalDay(date);
  const today = startOfLocalDay(now);
  const oneDay = 24 * 60 * 60 * 1000;
  const daysAgo = Math.round((today.getTime() - day.getTime()) / oneDay);

  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';

  const thisWeek = startOfLocalWeek(today);
  const lastWeek = new Date(thisWeek);
  lastWeek.setDate(lastWeek.getDate() - 7);

  if (day >= thisWeek) return 'This week';
  if (day >= lastWeek) return 'Last week';

  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function flattenGroupedMeetings(items: MeetingListItem[]): LibraryEntry[] {
  const groups = new Map<string, MeetingListItem[]>();
  for (const item of items) {
    const label = groupLabel(item.createdAt);
    const group = groups.get(label);
    if (group) group.push(item);
    else groups.set(label, [item]);
  }

  const entries: LibraryEntry[] = [];
  for (const [label, groupItems] of groups) {
    entries.push({
      kind: 'header',
      key: `group:${label}:${groupItems[0]?.id ?? 'empty'}`,
      label,
    });
    for (const item of groupItems) {
      entries.push({ kind: 'meeting', key: `meeting:${item.id}`, item });
    }
  }
  return entries;
}

function optionId(meetingId: string): string {
  return `meeting-option-${meetingId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function errorDescription(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const toolbarControlClass =
  'h-8 rounded-control border border-border bg-surface text-ui text-text outline-none transition-colors duration-150 focus:border-accent';

export default function MeetingLibrary() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refetchMeetings } = useSidebar();
  const starredOnly = searchParams.get('starred') === '1';
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<MeetingListSort>('newest');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [toolbarHost, setToolbarHost] = useState<Element | null>(null);

  const {
    items,
    isLoading,
    isLoadingMore,
    error,
    hasMore,
    refresh,
    loadMore,
    patchItem,
    removeItems,
  } = useMeetingList({ query, sort, starredOnly });

  const entries = useMemo(() => flattenGroupedMeetings(items), [items]);
  const itemIndexById = useMemo(
    () => new Map(items.map((item, index) => [item.id, index])),
    [items],
  );

  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const entry = entries[index];
      if (!entry || entry.kind === 'header') return 32;
      return entry.item.transcriptSnippet ? 88 : 64;
    },
    overscan: 12,
    getItemKey: (index) => entries[index]?.key ?? index,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastVirtualIndex = virtualItems.length
    ? virtualItems[virtualItems.length - 1].index
    : -1;

  useEffect(() => {
    const host = document.querySelector('[data-meetodds-toolbar-trailing]');
    setToolbarHost(host);
  }, []);

  useEffect(() => {
    if (lastVirtualIndex >= entries.length - 8 && hasMore && !isLoadingMore) {
      void loadMore();
    }
  }, [entries.length, hasMore, isLoadingMore, lastVirtualIndex, loadMore]);

  useEffect(() => {
    if (items.length === 0) {
      setFocusedId(null);
      setSelectedIds(new Set());
      return;
    }
    setFocusedId((current) => (
      current && itemIndexById.has(current) ? current : items[0].id
    ));
    setSelectedIds((current) => {
      const valid = new Set([...current].filter((id) => itemIndexById.has(id)));
      if (valid.size > 0 || selectMode) return valid;
      return new Set([items[0].id]);
    });
  }, [itemIndexById, items, selectMode]);

  useEffect(() => {
    setSelectedIds(new Set());
    setFocusedId(null);
    setSelectionAnchorId(null);
    setRenamingId(null);
  }, [query, sort, starredOnly]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('pointerdown', close);
    scrollRef.current?.addEventListener('scroll', close);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('pointerdown', close);
      scrollRef.current?.removeEventListener('scroll', close);
    };
  }, [contextMenu]);

  const openMeeting = useCallback((item: MeetingListItem) => {
    router.push(`/meeting-details?id=${encodeURIComponent(item.id)}`);
  }, [router]);

  const applySelection = useCallback((
    item: MeetingListItem,
    event: Pick<ReactMouseEvent<HTMLDivElement>, 'metaKey' | 'ctrlKey' | 'shiftKey'>,
  ) => {
    const toggle = event.metaKey || event.ctrlKey;
    setFocusedId(item.id);

    if (event.shiftKey && selectionAnchorId && itemIndexById.has(selectionAnchorId)) {
      const anchorIndex = itemIndexById.get(selectionAnchorId)!;
      const itemIndex = itemIndexById.get(item.id)!;
      const [start, end] = anchorIndex <= itemIndex
        ? [anchorIndex, itemIndex]
        : [itemIndex, anchorIndex];
      setSelectedIds(new Set(items.slice(start, end + 1).map((candidate) => candidate.id)));
      setSelectMode(true);
      return;
    }

    if (toggle) {
      setSelectMode(true);
      setSelectionAnchorId(item.id);
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
      return;
    }

    setSelectionAnchorId(item.id);
    setSelectedIds(new Set([item.id]));
  }, [itemIndexById, items, selectionAnchorId]);

  const renameMeeting = useCallback(async (item: MeetingListItem, title: string) => {
    const previousTitle = item.title;
    patchItem(item.id, { title });
    try {
      await invoke<void>('api_rename_meeting', { meetingId: item.id, title });
      setRenamingId(null);
      await refetchMeetings();
      return true;
    } catch (renameError) {
      patchItem(item.id, { title: previousTitle });
      console.error('[MeetingLibrary] Failed to rename meeting:', renameError);
      toast.error('Could not rename meeting', {
        description: errorDescription(renameError),
      });
      return false;
    }
  }, [patchItem, refetchMeetings]);

  const toggleStar = useCallback(async (item: MeetingListItem) => {
    const starred = !item.starred;
    patchItem(item.id, { starred });
    try {
      await invoke<void>('api_set_meeting_starred', {
        meetingId: item.id,
        starred,
      });
      if (starredOnly && !starred) removeItems([item.id]);
      await refetchMeetings();
    } catch (starError) {
      patchItem(item.id, { starred: item.starred });
      console.error('[MeetingLibrary] Failed to update star:', starError);
      toast.error('Could not update starred state', {
        description: errorDescription(starError),
      });
    }
  }, [patchItem, refetchMeetings, removeItems, starredOnly]);

  const restoreDeletedMeetings = useCallback(async (meetingIds: readonly string[]) => {
    try {
      await Promise.all(meetingIds.map((meetingId) => invoke<void>('api_restore_meeting', {
        meetingId,
      })));
      await refresh();
      await refetchMeetings();
      toast.success(meetingIds.length === 1 ? 'Meeting restored' : 'Meetings restored');
    } catch (restoreError) {
      console.error('[MeetingLibrary] Failed to restore meeting:', restoreError);
      toast.error('Could not restore meeting', {
        description: errorDescription(restoreError),
      });
    }
  }, [refresh, refetchMeetings]);

  const deleteMeetings = useCallback(async (meetingIds: readonly string[]) => {
    const ids = [...new Set(meetingIds)].filter((id) => itemIndexById.has(id));
    if (ids.length === 0) return;

    const deferred: string[] = [];
    try {
      for (const meetingId of ids) {
        await invoke<DeferredDeleteResponse>('api_defer_delete_meeting', { meetingId });
        deferred.push(meetingId);
      }
    } catch (deleteError) {
      await Promise.allSettled(deferred.map((meetingId) => invoke<void>('api_restore_meeting', {
        meetingId,
      })));
      console.error('[MeetingLibrary] Failed to defer meeting deletion:', deleteError);
      toast.error('Could not delete meeting', {
        description: errorDescription(deleteError),
      });
      await refresh();
      return;
    }

    removeItems(ids);
    setSelectedIds(new Set());
    setFocusedId(null);
    setSelectionAnchorId(null);
    setContextMenu(null);
    await refetchMeetings();

    toast(ids.length === 1 ? 'Meeting deleted' : `${ids.length} meetings deleted`, {
      duration: 8_000,
      action: {
        label: 'Undo',
        onClick: () => void restoreDeletedMeetings(ids),
      },
    });
  }, [itemIndexById, refetchMeetings, refresh, removeItems, restoreDeletedMeetings]);

  const moveFocus = useCallback((delta: number, extendSelection: boolean) => {
    if (items.length === 0) return;
    const currentIndex = focusedId ? itemIndexById.get(focusedId) ?? 0 : 0;
    const nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + delta));
    const next = items[nextIndex];
    setFocusedId(next.id);

    if (extendSelection) {
      const anchorId = selectionAnchorId ?? items[currentIndex]?.id ?? next.id;
      setSelectionAnchorId(anchorId);
      const anchorIndex = itemIndexById.get(anchorId) ?? currentIndex;
      const [start, end] = anchorIndex <= nextIndex
        ? [anchorIndex, nextIndex]
        : [nextIndex, anchorIndex];
      setSelectedIds(new Set(items.slice(start, end + 1).map((item) => item.id)));
      setSelectMode(true);
    } else {
      setSelectionAnchorId(next.id);
      setSelectedIds(new Set([next.id]));
    }

    const entryIndex = entries.findIndex(
      (entry) => entry.kind === 'meeting' && entry.item.id === next.id,
    );
    if (entryIndex >= 0) rowVirtualizer.scrollToIndex(entryIndex, { align: 'auto' });
  }, [entries, focusedId, itemIndexById, items, rowVirtualizer, selectionAnchorId]);

  const handleKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isEditableTarget(event.target)) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
      return;
    }

    const focusedItem = focusedId
      ? items[itemIndexById.get(focusedId) ?? -1]
      : undefined;
    if (!focusedItem) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      openMeeting(focusedItem);
      return;
    }

    if (event.metaKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      void toggleStar(focusedItem);
      return;
    }

    if (
      event.metaKey &&
      (event.key === 'Backspace' || event.key === 'Delete')
    ) {
      event.preventDefault();
      const ids = selectedIds.size ? [...selectedIds] : [focusedItem.id];
      void deleteMeetings(ids);
    }
  }, [deleteMeetings, focusedId, itemIndexById, items, moveFocus, openMeeting, selectedIds, toggleStar]);

  useEffect(() => {
    const handleFindShortcut = (event: KeyboardEvent) => {
      if (
        event.metaKey &&
        event.key.toLowerCase() === 'f' &&
        !isEditableTarget(event.target)
      ) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleFindShortcut);
    return () => window.removeEventListener('keydown', handleFindShortcut);
  }, []);

  const firstVirtualIndex = virtualItems[0]?.index ?? -1;
  const activeGroup = useMemo(() => {
    if (firstVirtualIndex < 0) return null;
    for (let index = firstVirtualIndex; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.kind === 'header') return entry.label;
    }
    return null;
  }, [entries, firstVirtualIndex]);

  const toolbar = (
    <>
      <div className="relative hidden w-[200px] md:block">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-3"
          strokeWidth={1.75}
        />
        <input
          ref={searchInputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find meetings"
          aria-label="Find meetings"
          className={`${toolbarControlClass} w-full pl-8 pr-8`}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-control text-3 hover:text-text"
            aria-label="Clear meeting search"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        )}
      </div>
      <select
        value={sort}
        onChange={(event) => setSort(event.target.value as MeetingListSort)}
        aria-label="Sort meetings"
        className={`${toolbarControlClass} px-2.5`}
      >
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="longest">Longest</option>
        <option value="title">Title A–Z</option>
      </select>
      <button
        type="button"
        onClick={() => {
          setSelectMode((current) => !current);
          setSelectedIds(new Set());
          setSelectionAnchorId(null);
        }}
        className={`${toolbarControlClass} px-3 font-medium hover:bg-bg`}
      >
        {selectMode ? 'Done' : 'Select'}
      </button>
    </>
  );

  if (isLoading && items.length === 0) {
    return (
      <>
        {toolbarHost && createPortal(toolbar, toolbarHost)}
        <div className="flex h-full items-center justify-center text-ui text-3">
          <LoaderCircle className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.75} />
          Loading meetings…
        </div>
      </>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-bg">
      {toolbarHost && createPortal(toolbar, toolbarHost)}

      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4 md:hidden">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-3"
            strokeWidth={1.75}
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find meetings"
            className={`${toolbarControlClass} w-full pl-8 pr-2`}
          />
        </div>
      </div>

      {error && items.length === 0 ? (
        <div className="m-auto max-w-sm rounded-card border border-border bg-surface p-5 text-center">
          <p className="text-ui font-semibold text-text">Could not load meetings</p>
          <p className="mt-1 text-caption text-3">{error}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-3 h-8 rounded-control border border-border bg-bg px-3 text-ui font-medium text-text hover:bg-surface"
          >
            Try again
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="m-auto max-w-sm rounded-card border border-border bg-surface p-6 text-center">
          <p className="text-title text-text">
            {query ? 'No matching meetings' : starredOnly ? 'No starred meetings' : 'No meetings yet'}
          </p>
          <p className="mt-1.5 text-body text-2">
            {query
              ? 'Try a different title or transcript search.'
              : starredOnly
                ? 'Star a meeting to keep it easy to find here.'
                : 'Saved and imported meetings will appear here.'}
          </p>
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="mt-3 h-8 rounded-control border border-border bg-bg px-3 text-ui font-medium text-text hover:bg-surface"
            >
              Clear search
            </button>
          )}
        </div>
      ) : (
        <div
          ref={scrollRef}
          role="listbox"
          aria-label={starredOnly ? 'Starred meetings' : 'Meetings'}
          aria-multiselectable={selectMode}
          aria-activedescendant={focusedId ? optionId(focusedId) : undefined}
          tabIndex={0}
          onKeyDown={handleKeyboard}
          className="relative min-h-0 flex-1 overflow-auto outline-none custom-scrollbar focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          {activeGroup && (
            <div className="sticky top-0 z-20 h-0">
              <div className="flex h-8 items-center border-b border-border bg-bg px-4 text-[11px] font-semibold uppercase tracking-[0.06em] text-3">
                {activeGroup}
              </div>
            </div>
          )}
          <div
            className="relative w-full"
            style={{ height: rowVirtualizer.getTotalSize() }}
          >
            {virtualItems.map((virtualRow) => {
              const entry = entries[virtualRow.index];
              if (!entry) return null;
              return (
                <div
                  key={entry.key}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="absolute left-0 top-0 w-full"
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {entry.kind === 'header' ? (
                    <div className="flex h-full items-center border-b border-border bg-bg px-4 text-[11px] font-semibold uppercase tracking-[0.06em] text-3">
                      {entry.label}
                    </div>
                  ) : (
                    <MeetingRow
                      item={entry.item}
                      optionId={optionId(entry.item.id)}
                      selected={selectedIds.has(entry.item.id)}
                      selectMode={selectMode}
                      renaming={renamingId === entry.item.id}
                      onSelect={(event) => {
                        scrollRef.current?.focus({ preventScroll: true });
                        applySelection(entry.item, event);
                      }}
                      onOpen={() => openMeeting(entry.item)}
                      onStartRename={() => {
                        setFocusedId(entry.item.id);
                        setSelectedIds(new Set([entry.item.id]));
                        setRenamingId(entry.item.id);
                      }}
                      onSaveRename={(title) => renameMeeting(entry.item, title)}
                      onCancelRename={() => setRenamingId(null)}
                      onToggleStar={() => void toggleStar(entry.item)}
                      onDelete={() => void deleteMeetings([entry.item.id])}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setFocusedId(entry.item.id);
                        setSelectedIds(new Set([entry.item.id]));
                        setContextMenu({
                          item: entry.item,
                          x: Math.min(event.clientX, window.innerWidth - 220),
                          y: Math.min(event.clientY, window.innerHeight - 190),
                        });
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {isLoadingMore && (
            <div className="sticky bottom-2 mx-auto flex w-fit items-center rounded-popover border border-border bg-surface px-3 py-1.5 text-caption text-3 shadow-popover">
              <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              Loading more…
            </div>
          )}
        </div>
      )}

      {selectMode && selectedIds.size > 0 && (
        <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-popover border border-border bg-surface px-2 py-2 shadow-popover">
          <span className="px-2 text-ui font-medium text-text">{selectedIds.size} selected</span>
          <button
            type="button"
            onClick={() => void deleteMeetings([...selectedIds])}
            className="inline-flex h-8 items-center gap-1.5 rounded-control px-2.5 text-ui font-medium text-danger hover:bg-bg"
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.75} /> Delete
          </button>
        </div>
      )}

      {contextMenu && (
        <div
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
          className="fixed z-[100] w-[210px] rounded-popover border border-border bg-surface p-1 text-ui text-text shadow-popover"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              openMeeting(contextMenu.item);
              setContextMenu(null);
            }}
            className="flex h-8 w-full items-center rounded-control px-2 text-left hover:bg-bg"
          >
            Open <span className="ml-auto text-caption text-3">↩</span>
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setRenamingId(contextMenu.item.id);
              setContextMenu(null);
            }}
            className="flex h-8 w-full items-center rounded-control px-2 text-left hover:bg-bg"
          >
            Rename
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              void toggleStar(contextMenu.item);
              setContextMenu(null);
            }}
            className="flex h-8 w-full items-center rounded-control px-2 text-left hover:bg-bg"
          >
            <Star className="mr-2 h-4 w-4" strokeWidth={1.75} />
            {contextMenu.item.starred ? 'Unstar' : 'Star'}
            <span className="ml-auto text-caption text-3">⌘D</span>
          </button>
          <div className="my-1 h-px bg-border" />
          <button
            role="menuitem"
            type="button"
            onClick={() => void deleteMeetings([contextMenu.item.id])}
            className="flex h-8 w-full items-center rounded-control px-2 text-left text-danger hover:bg-bg"
          >
            <Trash2 className="mr-2 h-4 w-4" strokeWidth={1.75} /> Delete
            <span className="ml-auto text-caption text-3">⌘⌫</span>
          </button>
        </div>
      )}

      {error && items.length > 0 && (
        <button
          type="button"
          onClick={() => void refresh()}
          className="absolute bottom-3 right-3 inline-flex items-center gap-2 rounded-popover border border-border bg-surface px-3 py-2 text-caption text-danger shadow-popover"
        >
          <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
          Refresh failed · Retry
        </button>
      )}
    </div>
  );
}
