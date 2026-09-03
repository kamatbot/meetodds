'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import MainContent from '@/components/MainContent';
import CommandPalette from '@/components/CommandPalette';
import Toolbar from './Toolbar';

const SIDEBAR_VISIBLE_KEY = 'meetodds.shell.sidebar.visible';
const SIDEBAR_WIDTH_KEY = 'meetodds.shell.sidebar.width';
const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 360;

function clampSidebarWidth(value: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value));
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

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    try {
      const persistedVisible = window.localStorage.getItem(SIDEBAR_VISIBLE_KEY);
      const persistedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));

      if (persistedVisible !== null) {
        setSidebarVisible(persistedVisible !== 'false');
      }
      if (Number.isFinite(persistedWidth) && persistedWidth > 0) {
        setSidebarWidth(clampSidebarWidth(persistedWidth));
      }
    } catch (error) {
      console.warn('[AppShell] Unable to restore sidebar preferences:', error);
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(SIDEBAR_VISIBLE_KEY, String(sidebarVisible));
    } catch (error) {
      console.warn('[AppShell] Unable to persist sidebar visibility:', error);
    }
  }, [sidebarVisible, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch (error) {
      console.warn('[AppShell] Unable to persist sidebar width:', error);
    }
  }, [sidebarWidth, storageReady]);

  const toggleSidebar = useCallback(() => {
    setSidebarVisible((visible) => !visible);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.metaKey &&
        event.ctrlKey &&
        event.key.toLowerCase() === 's' &&
        !isEditableTarget(event.target)
      ) {
        event.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar]);

  const beginResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    };

    const stopResize = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }, [sidebarWidth]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      {sidebarVisible && (
        <aside
          className="relative h-full shrink-0 bg-sidebar"
          style={{ width: sidebarWidth }}
          aria-label="Application sidebar"
        >
          <Sidebar />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={beginResize}
            className="no-drag absolute inset-y-0 right-0 z-50 w-1 cursor-col-resize transition-colors duration-150 hover:bg-accent/30"
          />
        </aside>
      )}

      <section className="flex min-w-0 flex-1 flex-col bg-bg">
        <Toolbar sidebarVisible={sidebarVisible} onToggleSidebar={toggleSidebar} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="h-full w-full [&>main]:!ml-0 [&>main]:h-full [&>main]:w-full [&>main>div]:!pl-0">
            <MainContent>{children}</MainContent>
          </div>
        </div>
      </section>

      <CommandPalette onToggleSidebar={toggleSidebar} />
    </div>
  );
}
