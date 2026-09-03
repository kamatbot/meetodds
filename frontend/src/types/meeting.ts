export type MeetingListSort = 'newest' | 'oldest' | 'longest' | 'title';

export type MeetingSummaryStatus = 'ready' | 'missing' | 'generating' | 'failed';

export interface MeetingListRequest {
  cursor?: string;
  limit: number;
  query?: string;
  sort: MeetingListSort;
  starredOnly?: boolean;
}

export interface MeetingListItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  starred: boolean;
  summaryStatus: MeetingSummaryStatus;
  transcriptSnippet?: string;
}

export interface MeetingListPage {
  items: MeetingListItem[];
  nextCursor?: string;
}

export interface DeferredDeleteResponse {
  meetingId: string;
  undoUntil: string;
}
