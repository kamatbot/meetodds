export interface MeetingContext {
  project: string | null;
  client: string | null;
  participants: string[];
  agenda: string | null;
}

export interface EvidenceReference {
  id: string;
  meetingId: string;
  sourceKind: string;
  transcriptId: string | null;
  transcriptRevision: number;
  quote: string;
  audioStartTime: number | null;
  audioEndTime: number | null;
  speakerLabel: string | null;
}

export interface MeetingFact {
  id: string;
  kind: 'outcome' | 'decision' | 'open_question' | string;
  text: string;
  state: string;
  confidence: number;
  confirmed: boolean;
  evidence: EvidenceReference[];
}

export type MeetingActionStatus = 'open' | 'done' | 'dismissed';
export type CommitmentState = 'detected' | 'proposed' | 'agreed';

export interface MeetingAction {
  id: string;
  text: string;
  owner: string | null;
  dueAt: string | null;
  dueText: string | null;
  status: MeetingActionStatus;
  commitmentState: CommitmentState;
  confirmed: boolean;
  evidence: EvidenceReference[];
}

export interface MeetingIntelligence {
  meetingId: string;
  context: MeetingContext;
  outcome: MeetingFact | null;
  decisions: MeetingFact[];
  openQuestions: MeetingFact[];
  actions: MeetingAction[];
}

export interface MeetingActionUpdate {
  actionId: string;
  text: string;
  owner: string | null;
  dueAt: string | null;
  dueText: string | null;
  status: MeetingActionStatus;
  commitmentState: CommitmentState;
  confirmed: boolean;
}

export interface ActionInboxItem {
  action: MeetingAction;
  meetingId: string;
  meetingTitle: string;
  meetingCreatedAt: string;
  project: string | null;
  client: string | null;
}

export interface ActionInboxResponse {
  needsReview: ActionInboxItem[];
  open: ActionInboxItem[];
  doneRecent: ActionInboxItem[];
}

export interface FollowupDraft {
  subject: string;
  body: string;
  sourceActionIds: string[];
  sourceFactIds: string[];
}

export type MemoryScope = 'meeting' | 'project' | 'client' | 'all';

export interface MemorySearchRequest {
  query: string;
  scope: MemoryScope;
  meetingId?: string | null;
  project?: string | null;
  client?: string | null;
  limit?: number;
}

export interface MemoryHit {
  meetingId: string;
  meetingTitle: string;
  kind: string;
  sourceId: string;
  snippet: string;
  score: number;
  transcriptId: string | null;
  audioStartTime: number | null;
  audioEndTime: number | null;
  speakerLabel: string | null;
  project: string | null;
  client: string | null;
}

export interface MemorySearchResponse {
  answer: string;
  scopeLabel: string;
  hits: MemoryHit[];
}

export interface PreparationItem {
  meetingId: string;
  meetingTitle: string;
  text: string;
  confirmed: boolean;
  evidence: EvidenceReference | null;
}

export interface MeetingPreparationResponse {
  context: MeetingContext;
  scopeLabel: string;
  priorDecisions: PreparationItem[];
  openActions: PreparationItem[];
  openQuestions: PreparationItem[];
}
