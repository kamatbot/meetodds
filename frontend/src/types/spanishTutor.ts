/** Add these fields to the companion branch's existing types; do not rename its commands. */
export type SpanishCategory =
  | 'verb_tense' | 'verb_conjugation' | 'ser_estar' | 'gender_agreement'
  | 'number_agreement' | 'article' | 'preposition' | 'word_choice'
  | 'word_order' | 'missing_word' | 'english_mixed' | 'other';
export type SpanishSeverity = 'blocking' | 'core' | 'polish';
export type SpanishFeedbackKind = 'correction' | 'praise' | 'practiced' | 'translation';
export interface SpanishFeedbackExtensions {
  category?: SpanishCategory;
  severity?: SpanishSeverity;
  shown?: boolean;
  turnIndex?: number;
  count?: number;
}
export interface SpanishPracticingPhrase {
  phrase: string;
  category: SpanishCategory;
  uses: number;
  mastered: boolean;
  addedAt: number;
  /** Internal evidence needed to distinguish repeated practice from cross-session use. */
  useSessionIds?: string[];
}
export interface SpanishProfileExtensions { practicing?: SpanishPracticingPhrase[] }
export type SpanishTutorMode = 'open' | 'reply' | 'help' | 'stuck';
export interface SpanishTutorReplyEvent {
  text: string;
  repeat: boolean;
  rate?: number;
  filler?: boolean;
  requestId?: string;
  sessionId?: string;
}
export interface SpanishTutorResponse<Feedback> {
  feedback: Feedback | null;
  beat: number;
  sceneDone: boolean;
}

/**
 * Listen before invoking spanish_tutor_turn. The host speaks ONLY from that
 * event, not again when the command resolves with feedback. Scope the native
 * emitter to the originating window, and use fresh request IDs on every turn.
 * This predicate rejects late replies after cancellation/navigation.
 */
export function isCurrentSpanishReply(
  event: SpanishTutorReplyEvent,
  sessionId: string,
  requestId: string,
  cancelled: boolean,
): boolean {
  return !cancelled && event.sessionId === sessionId && event.requestId === requestId
    && typeof event.text === 'string' && event.text.trim().length > 0;
}

/** Server-supplied optional metadata wins; legacy repeat events retain rate 115. */
export function spanishReplyRate(event: SpanishTutorReplyEvent, normalRate: number): number {
  if (event.rate !== undefined && Number.isFinite(event.rate) && event.rate >= 80 && event.rate <= 240) return event.rate;
  return event.repeat ? 115 : normalRate;
}
