// Types, constants, and pure helpers for the Spanish practice feature.
// Kept in one file (ponytail: no separate types/ + utils/ split for ~10 helpers).

export type Level = 'beginner' | 'intermediate' | 'advanced';
export type Variety = 'es_MX' | 'es_ES';

export interface SpanishProfile {
  id: string;
  name: string;
  level: Level;
  variety: Variety;
  topics: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Turn {
  role: 'tutor' | 'learner';
  text: string;
}

export interface Feedback {
  kind: 'correction' | 'praise';
  youSaid: string;
  tryThis: string;
  why: string;
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

export interface TutorResponse {
  reply: string;
  feedback: Feedback | null;
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

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!¡?¿"'`´;:()\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = new Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[n];
}

// 0..1, 1 = identical after normalization (lowercase, punctuation/space stripped, accents kept).
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// ponytail: no test runner configured in this repo (no test script, no vitest/jest) -
// run this by hand with `npx tsx src/lib/spanish.ts` instead of a proper test file.
export function selfCheckSimilarity(): void {
  const identical = similarity('Hola, ¿cómo estás?', 'hola como estas');
  console.assert(identical > 0.85 && identical < 1, `expected accent mismatch to reduce ratio, got ${identical}`);

  const exact = similarity('Buenos días!!', 'buenos días');
  console.assert(exact === 1, `expected punctuation/case-only diff to be 1, got ${exact}`);

  const different = similarity('hola', 'adiós');
  console.assert(different < 0.4, `expected unrelated strings to score low, got ${different}`);

  console.log('selfCheckSimilarity: ok', { identical, exact, different });
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  selfCheckSimilarity();
}
