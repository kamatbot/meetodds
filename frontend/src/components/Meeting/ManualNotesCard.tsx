'use client';

import { useEffect, useState } from 'react';
import { getManualNotes } from '@/services/manualNotesService';

interface ManualNotesCardProps {
  meetingId: string;
}

export default function ManualNotesCard({ meetingId }: ManualNotesCardProps) {
  const [content, setContent] = useState('');

  useEffect(() => {
    let cancelled = false;
    getManualNotes(meetingId)
      .then((loaded) => {
        if (!cancelled) setContent(loaded);
      })
      .catch(() => {
        // Manual notes are supplementary; a load failure here is not worth surfacing.
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  if (!content.trim()) return null;

  return (
    <details open className="m-4 shrink-0 rounded-control border border-border bg-surface p-3 text-ui text-text">
      <summary className="cursor-pointer font-semibold">Notes taken during the meeting</summary>
      <pre className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-caption leading-6">{content}</pre>
    </details>
  );
}
