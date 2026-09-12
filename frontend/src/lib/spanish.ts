// Types, constants, and pure helpers for the Spanish practice feature.
// Kept in one file (ponytail: no separate types/ + utils/ split for ~10 helpers).
// Tutor-turn event/reply types folded in from types/spanishTutor.ts (single home for types).

export type Level = 'beginner' | 'intermediate' | 'advanced';
export type Variety = 'es_MX' | 'es_ES';

// ponytail: category is a plain string on the wire (native owns the enum); we only need
// it to key CATEGORY_LABELS, so no separate union type to keep in lockstep with Rust.
export const CATEGORY_LABELS: Record<string, string> = {
  verb_tense: 'Past, present, and future',
  verb_conjugation: 'Verb endings',
  ser_estar: 'Ser vs. estar',
  gender_agreement: 'Gender agreement',
  number_agreement: 'Singular and plural',
  article: 'Articles (el, la, un…)',
  preposition: 'Prepositions',
  word_choice: 'Word choice',
  word_order: 'Word order',
  missing_word: 'Missing words',
  english_mixed: 'Saying it in Spanish',
  other: 'Other',
};

export interface PracticingPhrase {
  phrase: string;
  category: string;
  uses: number;
  mastered: boolean;
  addedAt: number;
  /** Internal evidence natively used to distinguish repeated practice from cross-session use. */
  useSessionIds?: string[];
}

export interface SpanishProfile {
  id: string;
  name: string;
  level: Level;
  variety: Variety;
  topics: string[];
  practicing: PracticingPhrase[];
  allowCloud: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Turn {
  role: 'tutor' | 'learner';
  text: string;
}

export interface Feedback {
  kind: 'correction' | 'praise' | 'practiced' | 'translation';
  youSaid: string;
  tryThis: string;
  why: string;
  category: string;
  severity: 'blocking' | 'core' | 'polish';
  shown: boolean;
  turnIndex: number;
  count: number;
}

export interface SpanishSession {
  id: string;
  profileId: string;
  situation: string | null;
  startedAt: string;
  endedAt: string | null;
  turns: Turn[];
  feedback: Feedback[];
  levelSignal: 'easier' | 'right' | 'harder' | null;
}

export type TutorMode = 'open' | 'reply' | 'help' | 'stuck';

/** Emitted by the native side while spanish_tutor_turn is still awaiting the judge.
 * THE APP SPEAKS ONLY FROM THESE EVENTS, never from the command's return value. */
export interface TutorReplyEvent {
  text: string;
  repeat: boolean;
  rate?: number;
  filler?: boolean;
  requestId: string;
  sessionId: string;
}

export interface TutorTurnResponse {
  feedback: Feedback | null;
  beat: number;
  sceneDone: boolean;
}

export interface FocusItem {
  category: string;
  title: string;
  count: number;
  example: Feedback;
}

export interface SessionRecap {
  focusNextTime: FocusItem[];
  findings: Feedback[];
  masteredPhrases: string[];
  suggestLevelBump: boolean;
}

export interface SessionCounts {
  learnerTurns: number;
  corrections: number;
  praise: number;
}

export interface PracticeResult {
  score: number;
  missedWordIndices: number[];
  message: string;
  done: boolean;
  succeeded: boolean;
  attempts: number;
}

export interface Readiness {
  whisperModel: string | null;
  whisperReady: boolean;
  llmProvider: string | null;
  llmModel: string | null;
  llmReady: boolean;
  message: string | null;
}

export const LEVELS: { value: Level; label: string }[] = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
];

export const VARIETIES: { value: Variety; label: string }[] = [
  { value: 'es_MX', label: 'Mexico' },
  { value: 'es_ES', label: 'Spain' },
];

export const SITUATIONS: string[] = [
  'Ordering food',
  'Meeting someone new',
  'Telling what happened at school',
  'Planning the weekend',
  'Asking for directions',
  'Talking about your family',
  'At the doctor',
  'Shopping for clothes',
];

// signal describes how the session felt: 'easier' (too easy -> bump up),
// 'harder' (too hard -> bump down), 'right' (no change).
export function nextLevel(level: Level, signal: 'easier' | 'right' | 'harder'): Level {
  const order: Level[] = ['beginner', 'intermediate', 'advanced'];
  const i = order.indexOf(level);
  if (signal === 'easier') return order[Math.min(i + 1, order.length - 1)];
  if (signal === 'harder') return order[Math.max(i - 1, 0)];
  return level;
}

/**
 * Listen before invoking spanish_tutor_turn. The app speaks ONLY from this
 * event, never again when the command resolves. Scope the listener to the
 * originating window, and use fresh request IDs on every turn.
 * This predicate rejects late replies after cancellation/navigation/a new turn.
 */
export function isCurrentSpanishReply(
  event: TutorReplyEvent,
  sessionId: string,
  requestId: string,
  cancelled: boolean,
): boolean {
  return !cancelled && event.sessionId === sessionId && event.requestId === requestId
    && typeof event.text === 'string' && event.text.trim().length > 0;
}

/** Server-supplied optional metadata wins; legacy repeat events retain rate 115. */
export function spanishReplyRate(event: TutorReplyEvent, normalRate: number): number {
  if (event.rate !== undefined && Number.isFinite(event.rate) && event.rate >= 80 && event.rate <= 240) return event.rate;
  return event.repeat ? 115 : normalRate;
}

// --- Lessons built from recorded classes (meeting transcripts) ---
export interface ClassMeeting { id: string; title: string; createdAt: string; segments: number }
export interface LessonPhrase { es: string; en: string }
export interface LessonBrief {
  meetingId: string;
  title: string;
  topic: string;
  phrases: LessonPhrase[];
  grammar: string[];
  prompts: string[];
  /** Situation text handed to the tutor session. */
  situation: string;
}
