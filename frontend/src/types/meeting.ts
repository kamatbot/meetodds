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

export interface MeetingExportInfo {
  meetingId: string;
  title: string;
  createdAt: string;
  hasSummary: boolean;
  hasNotes: boolean;
  hasTranscript: boolean;
  hasAudio: boolean;
  transcriptHasTiming: boolean;
  audioPath: string | null;
}

export interface MeetingExportSelection {
  includeSummary: boolean;
  includeNotes: boolean;
  includeTranscript: boolean;
}

export type MeetingExportFormat = 'markdown' | 'text' | 'srt' | 'json';

export interface MeetingExportRequest {
  meetingId: string;
  format: MeetingExportFormat;
  selection: MeetingExportSelection;
}

export interface MeetingExportResult {
  cancelled: boolean;
  path?: string | null;
}
