import { parseSummaryData, sameSummaryTarget, type SummaryTarget } from './summary-input';

export const AUTO_SUMMARY_APPROVAL_KEY = 'meetodds.autoSummaryApproval.v1';
export const AUTO_SUMMARY_CHOICE_KEY = 'meetodds.autoSummaryChoice.v1';
export type PostMeetingPhase = 'ready' | 'generating' | 'outcome' | 'error';

/** Do not infer readiness from an empty object or an in-progress provider response. */
export function postMeetingPhase(summary: unknown, status: string): PostMeetingPhase {
  if (['processing', 'pending', 'summarizing', 'regenerating'].includes(status.toLowerCase())) return 'generating';
  if (parseSummaryData(summary)) return 'outcome';
  return ['failed', 'error'].includes(status.toLowerCase()) ? 'error' : 'ready';
}

export interface AutoSummaryApproval {
  version: 1;
  target: SummaryTarget;
  includeManualNotes: boolean;
}

/** Consent is specific to provider, model and destination. Personal notes are never auto-included. */
export function readAutoSummaryApproval(storage: Pick<Storage, 'getItem'>, target: SummaryTarget): AutoSummaryApproval | null {
  try {
    if (storage.getItem('isAutoSummary') !== 'true') return null;
    const value = JSON.parse(storage.getItem(AUTO_SUMMARY_APPROVAL_KEY) || 'null') as AutoSummaryApproval | null;
    return value?.version === 1 && value.target && sameSummaryTarget(value.target, target)
      && typeof value.includeManualNotes === 'boolean' ? value : null;
  } catch { return null; }
}

export function saveAutoSummaryApproval(storage: Pick<Storage, 'setItem'>, target: SummaryTarget, includeManualNotes: boolean): void {
  storage.setItem(AUTO_SUMMARY_APPROVAL_KEY, JSON.stringify({ version: 1, target, includeManualNotes } satisfies AutoSummaryApproval));
  storage.setItem(AUTO_SUMMARY_CHOICE_KEY, 'chosen');
}

/** One automatic attempt per saved recording, including reloads. Manual retry is never blocked. */
export function claimAutomaticSummary(storage: Pick<Storage, 'getItem' | 'setItem'>, meetingId: string): boolean {
  if (!meetingId) return false;
  const key = `meetodds.autoSummaryAttempt.v1:${meetingId}`;
  try {
    if (storage.getItem(key)) return false;
    storage.setItem(key, 'attempted');
    return true;
  } catch { return false; }
}

/** Added to the SAME reviewed model request: no heuristic harvest or second cloud request. */
export const POST_MEETING_INSTRUCTIONS = `
POST-MEETING OUTCOME CONTRACT
Follow the selected summary template. Also include the sections below in your final Markdown.
Use the requested output language for their contents. Keep these HTML markers exactly as written
(they identify the sections even when the headings are translated). Do not put the markers in code fences.
Never manufacture work to fill a section. Use "None" when no supported item exists.

<!-- meetodds:outcome -->
## Meeting outcome
One concise, complete statement of what the meeting achieved or left unresolved. Do not invent consensus.

<!-- meetodds:decisions -->
## Decisions
- One complete, self-contained statement per explicitly agreed decision. Discussion is not a decision.

<!-- meetodds:actions -->
## Action items
- Write each real follow-up as a clear, self-contained task, NOT a transcript fragment.
  Append explicit metadata only using: | Owner: name | Due: stated date or phrase | Commitment: agreed or proposed
  Omit Owner and Due when unknown; never guess names or deadlines. Use proposed for an unaccepted request.
  Each action must be supported by the transcript, not solely by a personal observation in the notes.

<!-- meetodds:questions -->
## Open questions
- One complete question per substantive issue still unresolved at the end of the meeting.

<!-- meetodds:end -->
Before returning, reconcile later corrections and decisions with earlier discussion. Remove duplicates.
Do not output the instructional sentences or placeholder examples above as meeting content.
`;
