'use client';

import { Suspense } from 'react';
import MeetingLibrary from '@/components/Meetings/MeetingLibrary';

function LibraryFallback() {
  return (
    <div className="flex h-full items-center justify-center text-ui text-3">
      Loading meetings…
    </div>
  );
}

export default function MeetingsPage() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <header className="shrink-0 px-8 pb-4 pt-5">
        <h1 className="text-[22px] font-semibold tracking-[-.03em] text-text">All meetings</h1>
        <p className="mt-1 font-mono text-[10px] text-3">Saved recordings, summaries and meeting outcomes</p>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden px-4 pb-4 md:px-8">
        <div className="h-full overflow-hidden rounded-[16px] border border-border bg-panel shadow-[0_1px_2px_rgba(24,18,12,.03)]">
          <Suspense fallback={<LibraryFallback />}>
            <MeetingLibrary />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
