export type FinishedSummaryStatus = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
export type FinishedSummaryViewState = 'generating' | 'ready' | 'failed' | 'empty' | 'needs-summary';

const GENERATING_STATUSES = new Set<FinishedSummaryStatus>(['processing', 'summarizing', 'regenerating']);

export function getFinishedSummaryViewState({
  hasSummary,
  hasTranscript,
  status,
}: {
  hasSummary: boolean;
  hasTranscript: boolean;
  status: FinishedSummaryStatus;
}): FinishedSummaryViewState {
  if (GENERATING_STATUSES.has(status)) return 'generating';
  if (hasSummary) return 'ready';
  if (!hasTranscript) return 'empty';
  if (status === 'error') return 'failed';
  return 'needs-summary';
}

export function getFinishedSummaryProgressLabel(status: FinishedSummaryStatus): string {
  if (status === 'processing') return 'Preparing the saved transcript for summary…';
  if (status === 'regenerating') return 'Updating the AI summary…';
  return 'Writing the AI summary…';
}

export function visibleMeetingActions<T extends { status: string }>(actions: T[]): T[] {
  return actions.filter(action => action.status !== 'dismissed');
}

/** Remember that the saved summary has a structured action source after its last item is dismissed. */
export function rememberStructuredActionPresence<T>(previous: boolean, persistedActions: readonly T[]): boolean {
  return previous || persistedActions.length > 0;
}
