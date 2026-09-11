'use client';

import React from 'react';
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';

interface ToolbarProps { sidebarVisible: boolean; onToggleSidebar: () => void; trailingAction?: React.ReactNode }
function getRouteTitle(pathname: string | null): string {
  if (!pathname || pathname === '/') return 'Home';
  if (pathname === '/meetings') return 'Meetings';
  if (pathname === '/meeting' || pathname === '/meeting-details') return 'Meeting';
  if (pathname === '/actions') return 'Actions';
  if (pathname === '/memory') return 'Memory';
  if (pathname === '/settings') return 'Settings';
  return 'MeetOdds';
}
const toolbarButtonClass = 'no-drag inline-grid h-8 w-8 place-items-center rounded-[10px] text-2 transition-colors duration-150 hover:bg-[var(--hover)] hover:text-text disabled:cursor-default disabled:opacity-35';

export default function Toolbar({ sidebarVisible, onToggleSidebar, trailingAction }: ToolbarProps) {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <header data-tauri-drag-region className="relative grid h-[52px] shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border bg-bg px-4 text-ui">
      <div className="no-drag flex min-w-0 items-center gap-1 justify-self-start">
        <button type="button" className={toolbarButtonClass} onClick={onToggleSidebar} aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'} title={`${sidebarVisible ? 'Hide' : 'Show'} sidebar (⌃⌘S)`}>
          {sidebarVisible ? <PanelLeftClose aria-hidden="true" className="h-4 w-4" strokeWidth={1.7} /> : <PanelLeftOpen aria-hidden="true" className="h-4 w-4" strokeWidth={1.7} />}
        </button>
        <button type="button" className={toolbarButtonClass} onClick={() => router.back()} aria-label="Go back"><ChevronLeft aria-hidden="true" className="h-4 w-4" strokeWidth={1.7} /></button>
        <button type="button" className={toolbarButtonClass} onClick={() => router.forward()} aria-label="Go forward"><ChevronRight aria-hidden="true" className="h-4 w-4" strokeWidth={1.7} /></button>
      </div>
      <div className="relative min-w-[220px] justify-self-center text-center">
        <div data-meetodds-toolbar-center className="no-drag flex min-h-8 items-center justify-center empty:hidden" />
        <div data-meetodds-toolbar-title className="truncate text-[13px] font-semibold tracking-[-.01em] text-text has-[[data-toolbar-center-active]]:hidden">{getRouteTitle(pathname)}</div>
      </div>
      <div data-meetodds-toolbar-trailing className="no-drag flex min-w-0 items-center justify-end gap-2 justify-self-stretch">{trailingAction}</div>
    </header>
  );
}
