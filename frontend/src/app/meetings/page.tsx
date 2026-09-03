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
    <Suspense fallback={<LibraryFallback />}>
      <MeetingLibrary />
    </Suspense>
  );
}
