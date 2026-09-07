'use client';

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useRouter } from 'next/navigation';

/** Mounted only in the main application, never in the auxiliary notes window. */
export default function NotesNavigationBridge() {
  const router = useRouter();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>('meetodds:open-note-source', ({ payload }) => {
      if (typeof payload === 'string' && payload.startsWith('/meeting?')) router.push(payload);
    }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [router]);
  return null;
}
