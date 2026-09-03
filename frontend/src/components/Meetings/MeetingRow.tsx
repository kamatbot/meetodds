'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  Check,
  CheckCircle2,
  Circle,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type { MeetingListItem } from '@/types/meeting';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface MeetingRowProps {
  item: MeetingListItem;
  optionId: string;
  selected: boolean;
  selectMode: boolean;
  renaming: boolean;
  onSelect: (event: MouseEvent<HTMLDivElement>) => void;
  onOpen: () => void;
  onStartRename: () => void;
  onSaveRename: (title: string) => Promise<boolean>;
  onCancelRename: () => void;
  onToggleStar: () => void;
  onDelete: () => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
}

function displayMeetingTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || /^Meeting\s+\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/i.test(trimmed)) {
    return 'Untitled meeting';
  }
  return trimmed;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs == null || !Number.isFinite(durationMs)) return 'Duration unavailable';
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${String(minutes).padStart(2, '0')} min` : `${hours}h`;
}

function formatTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function SummaryStatus({ status }: { status: MeetingListItem['summaryStatus'] }) {
  if (status === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 text-success">
        <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} /> Summarised
      </span>
    );
  }
  if (status === 'generating') {
    return (
      <span className="inline-flex items-center gap-1 text-warn">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> Generating…
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-danger">
        <TriangleAlert className="h-3.5 w-3.5" strokeWidth={1.75} /> Summary failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-3">
      <Circle className="h-3.5 w-3.5" strokeWidth={1.75} /> No summary
    </span>
  );
}

export default function MeetingRow({
  item,
  optionId,
  selected,
  selectMode,
  renaming,
  onSelect,
  onOpen,
  onStartRename,
  onSaveRename,
  onCancelRename,
  onToggleStar,
  onDelete,
  onContextMenu,
}: MeetingRowProps) {
  const [draft, setDraft] = useState(item.title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      setDraft(item.title);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [item.title, renaming]);

  const saveRename = async () => {
    if (saving) return;
    const title = draft.trim();
    if (!title || title === item.title) {
      onCancelRename();
      return;
    }
    setSaving(true);
    const saved = await onSaveRename(title);
    setSaving(false);
    if (!saved) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  return (
    <div
      id={optionId}
      role="option"
      aria-selected={selected}
      data-meeting-id={item.id}
      onClick={onSelect}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onStartRename();
      }}
      onContextMenu={onContextMenu}
      className={`group grid h-full min-w-0 cursor-default grid-cols-[32px_minmax(0,1fr)_auto_112px_32px] items-center gap-2 border-b border-border px-4 transition-colors duration-150 ${
        selected ? 'bg-accent-soft' : 'bg-bg hover:bg-surface'
      }`}
    >
      <button
        type="button"
        className={`inline-grid h-7 w-7 place-items-center rounded-control transition-colors duration-150 hover:bg-bg ${
          item.starred ? 'text-accent' : 'text-3 hover:text-text'
        }`}
        aria-label={item.starred ? 'Unstar meeting' : 'Star meeting'}
        aria-pressed={item.starred}
        onClick={(event) => {
          event.stopPropagation();
          onToggleStar();
        }}
      >
        {selectMode && selected ? (
          <span className="inline-grid h-4 w-4 place-items-center rounded-[4px] bg-accent text-white">
            <Check className="h-3 w-3" strokeWidth={2} />
          </span>
        ) : (
          <Star
            className="h-4 w-4"
            strokeWidth={1.75}
            fill={item.starred ? 'currentColor' : 'none'}
          />
        )}
      </button>

      <div className="min-w-0 py-2">
        {renaming ? (
          <input
            ref={inputRef}
            value={draft}
            disabled={saving}
            aria-label="Meeting title"
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void saveRename()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void saveRename();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDraft(item.title);
                onCancelRename();
              }
            }}
            className="h-7 w-full rounded-control border border-accent bg-surface px-2 text-ui font-semibold text-text outline-none"
          />
        ) : (
          <>
            <div className="truncate text-ui font-semibold text-text">
              {displayMeetingTitle(item.title)}
            </div>
            {item.transcriptSnippet && (
              <div className="mt-0.5 line-clamp-1 text-caption text-3">
                …{item.transcriptSnippet.trim()}…
              </div>
            )}
          </>
        )}
      </div>

      <div className="hidden min-w-[120px] justify-self-end text-caption sm:block">
        <SummaryStatus status={item.summaryStatus} />
      </div>

      <div className="justify-self-end text-right text-caption text-3">
        <div>{formatTime(item.createdAt)}</div>
        <div>{formatDuration(item.durationMs)}</div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            className="inline-grid h-7 w-7 place-items-center rounded-control text-3 opacity-0 transition-colors duration-150 hover:bg-bg hover:text-text focus:opacity-100 group-hover:opacity-100"
            aria-label={`Actions for ${displayMeetingTitle(item.title)}`}
          >
            <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="border-border bg-surface text-text">
          <DropdownMenuItem onSelect={onOpen}>Open</DropdownMenuItem>
          <DropdownMenuItem onSelect={onStartRename}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onToggleStar}>
            <Star /> {item.starred ? 'Unstar' : 'Star'}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            onSelect={onDelete}
            className="text-danger focus:bg-accent-soft focus:text-danger"
          >
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
