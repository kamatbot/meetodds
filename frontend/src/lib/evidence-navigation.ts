import type { EvidenceReference } from '@/types/intelligence';

export function evidenceHref(meetingId: string, evidence: EvidenceReference): string {
  const params = new URLSearchParams({ id: meetingId, tab: 'transcript' });
  if (evidence.transcriptId) params.set('evidence', evidence.transcriptId);
  if (evidence.audioStartTime != null && Number.isFinite(evidence.audioStartTime)) {
    params.set('at', String(Math.max(0, evidence.audioStartTime)));
  }
  return `/meeting?${params.toString()}`;
}

export function memoryHitHref(hit: {
  meetingId: string;
  kind: string;
  transcriptId: string | null;
  audioStartTime: number | null;
}): string {
  const tab = hit.transcriptId
    ? 'transcript'
    : hit.kind === 'notes' || hit.kind === 'manual_notes'
      ? 'notes'
      : 'summary';
  const params = new URLSearchParams({ id: hit.meetingId, tab });
  if (hit.transcriptId) params.set('evidence', hit.transcriptId);
  if (hit.audioStartTime != null && Number.isFinite(hit.audioStartTime)) {
    params.set('at', String(Math.max(0, hit.audioStartTime)));
  }
  return `/meeting?${params.toString()}`;
}
