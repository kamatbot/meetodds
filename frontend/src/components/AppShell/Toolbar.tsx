'use client';

import React from 'react';
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';

interface ToolbarProps {
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  trailingAction?: React.ReactNode;
}

function getRouteTitle(pathname: string | null): string {
  if (!pathname || pathname === '/') return 'Home';
  if (pathname === '/meetings') return 'Meetings';
  if (pathname === '/meeting' || pathname === '/meeting-details') return 'Meeting';
  if (pathname === '/settings') return 'Settings';
  return 'MeetOdds';
}

const toolbarButtonClass =
  'no-drag inline-grid h-7 w-7 place-items-center rounded-control text-2 transition-colors duration-150 hover:bg-surface hover:text-text disabled:cursor-default disabled:opacity-35';

export default function Toolbar({
  sidebarVisible,
  onToggleSidebar,
  trailingAction,
}: ToolbarProps) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <header
      data-tauri-drag-region
      className="grid h-[52px] shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border bg-bg px-4 text-ui"
    >
      <div className="no-drag flex min-w-0 items-center gap-1 justify-self-start">
        <button
          type="button"
          className={toolbarButtonClass}
          onClick={onToggleSidebar}
          aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          title={`${sidebarVisible ? 'Hide' : 'Show'} sidebar (⌃⌘S)`}
        >
          {sidebarVisible ? (
            <PanelLeftClose aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
          ) : (
            <PanelLeftOpen aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
          )}
        </button>
        <button
          type="button"
          className={toolbarButtonClass}
          onClick={() => router.back()}
          aria-label="Go back"
        >
          <ChevronLeft aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className={toolbarButtonClass}
          onClick={() => router.forward()}
          aria-label="Go forward"
        >
          <ChevronRight aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="min-w-0 max-w-[42vw] justify-self-center truncate text-title text-text">
        {getRouteTitle(pathname)}
      </div>

      <div className="no-drag flex min-w-0 items-center justify-end gap-2 justify-self-stretch">
        {trailingAction}
      </div>
    </header>
  );
}
