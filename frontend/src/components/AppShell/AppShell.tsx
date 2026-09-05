'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import MainContent from '@/components/MainContent';
import CommandPalette from '@/components/CommandPalette';
import Toolbar from './Toolbar';
import RecordingSaveStatus from './RecordingSaveStatus';
import './app-shell.css';

const SIDEBAR_VISIBLE_KEY = 'meetodds.shell.sidebar.visible';
const SIDEBAR_WIDTH_KEY = 'meetodds.shell.sidebar.width';
const APPEARANCE_KEY = 'meetodds.appearance';
const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 360;
function clampSidebarWidth(value: number) { return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value)); }
function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest('input,textarea,select,[contenteditable="true"]')));
}
function restoreAppearance() {
  try {
    const appearance = window.localStorage.getItem(APPEARANCE_KEY);
    if (appearance === 'light' || appearance === 'dark') document.documentElement.setAttribute('data-theme', appearance);
    else document.documentElement.removeAttribute('data-theme');
  } catch { /* Storage availability must not prevent using the app. */ }
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [storageReady, setStorageReady] = useState(false);
  const drag = useRef<{ x: number; width: number; cursor: string; selection: string } | null>(null);
  const stopResize = useCallback(() => {
    if (!drag.current) return;
    document.body.style.cursor = drag.current.cursor;
    document.body.style.userSelect = drag.current.selection;
    drag.current = null;
  }, []);
  useEffect(() => () => stopResize(), [stopResize]);

  useEffect(() => {
    restoreAppearance();
    try {
      const visible = window.localStorage.getItem(SIDEBAR_VISIBLE_KEY);
      const width = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
      if (visible !== null) setSidebarVisible(visible !== 'false');
      if (Number.isFinite(width) && width > 0) setSidebarWidth(clampSidebarWidth(width));
    } catch { /* Defaults remain usable. */ }
    finally { setStorageReady(true); }
  }, []);
  useEffect(() => {
    if (storageReady) {
      try { window.localStorage.setItem(SIDEBAR_VISIBLE_KEY, String(sidebarVisible)); } catch { /* Keep session state. */ }
    }
  }, [sidebarVisible, storageReady]);
  useEffect(() => {
    if (storageReady) {
      try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); } catch { /* Keep session state. */ }
    }
  }, [sidebarWidth, storageReady]);
  const toggleSidebar = useCallback(() => { stopResize(); setSidebarVisible((visible) => !visible); }, [stopResize]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('[role="dialog"],[role="alertdialog"]')) return;
      const editable = isEditableTarget(target);
      if (event.metaKey && event.key === ',') { event.preventDefault(); router.push('/settings'); return; }
      if (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !editable) {
        const destination: Record<string, string> = { '1': '/', '2': '/meetings', '3': '/meetings?starred=1' };
        if (destination[event.key]) { event.preventDefault(); router.push(destination[event.key]); return; }
      }
      if (event.metaKey && event.ctrlKey && event.key.toLowerCase() === 's' && !editable) { event.preventDefault(); toggleSidebar(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [router, toggleSidebar]);

  return (
    <div className="meetodds-shell flex h-screen w-screen overflow-hidden bg-bg text-text">
      {sidebarVisible && (
        <aside className="relative h-full shrink-0 bg-sidebar" style={{ width: sidebarWidth }} aria-label="Application sidebar">
          <Sidebar />
          <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={0}
            aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH} aria-valuenow={Math.round(sidebarWidth)} aria-valuetext={`${Math.round(sidebarWidth)} pixels`}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setSidebarWidth((width) => clampSidebarWidth(width + (event.key === 'ArrowLeft' ? -10 : 10))); }
              if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setSidebarWidth(event.key === 'Home' ? MIN_SIDEBAR_WIDTH : MAX_SIDEBAR_WIDTH); }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { x: event.clientX, width: sidebarWidth, cursor: document.body.style.cursor, selection: document.body.style.userSelect };
              document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
            }}
            onPointerMove={(event) => { if (drag.current) setSidebarWidth(clampSidebarWidth(drag.current.width + event.clientX - drag.current.x)); }}
            onPointerUp={stopResize} onPointerCancel={stopResize} onLostPointerCapture={stopResize}
            className="no-drag absolute inset-y-0 right-0 z-50 w-1 cursor-col-resize transition-colors duration-150 hover:bg-accent/30 focus-visible:bg-accent/30" />
        </aside>
      )}
      <section className="flex min-w-0 flex-1 flex-col bg-bg">
        <Toolbar sidebarVisible={sidebarVisible} onToggleSidebar={toggleSidebar} />
        <RecordingSaveStatus />
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="h-full w-full [&>main]:!ml-0 [&>main]:h-full [&>main]:w-full [&>main>div]:!pl-0"><MainContent>{children}</MainContent></div>
        </div>
      </section>
      <CommandPalette onToggleSidebar={toggleSidebar} />
    </div>
  );
}
