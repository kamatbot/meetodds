export interface MeetingSpeaker {
  id: string;
  name: string;
  source: 'manual' | 'post-meeting-acoustic' | 'capture-channel';
  turnCount: number;
}

export interface SpeakerReviewTurn {
  id: string;
  text: string;
  start: number | null;
  end: number | null;
  speakerId: string | null;
  speakerLabel: string | null;
  captureChannel: string | null;
  source: 'manual' | 'post-meeting-acoustic' | 'unresolved-channel';
  confidence: number | null;
  reviewed: boolean;
  reason: string;
}

export interface MeetingSpeakerReview {
  meetingId: string;
  revision: number;
  speakers: MeetingSpeaker[];
  turns: SpeakerReviewTurn[];
  analyzedAt: string | null;
  summaryNeedsReview: boolean;
  canEdit: boolean;
  readOnlyReason: string | null;
  canAnalyze: boolean;
  unavailableReason: string | null;
}
