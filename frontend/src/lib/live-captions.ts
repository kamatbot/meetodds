import type { LiveTranscriptPreview } from '@/types';
import type { LiveTranslationEntry } from './live-translation';

export const CAPTION_WINDOW_LABEL = 'live-captions';
export const CAPTION_FRAME_EVENT = 'meetodds:caption-frame';
export const CAPTION_READY_EVENT = 'meetodds:caption-ready';
export const CAPTION_DISMISS_EVENT = 'meetodds:caption-dismiss';
export const CAPTION_RETRY_EVENT = 'meetodds:caption-retry';
export const CAPTION_GEOMETRY_KEY = 'meetodds.captions.geometry.v1';
export const CAPTION_APPEARANCE_KEY = 'meetodds.captions.appearance.v1';
export const CAPTION_RESET_EVENT = 'meetodds:caption-reset';

export type CaptionPhase = 'listening' | 'translating' | 'live' | 'paused' | 'recovering' | 'error';
export interface CaptionContent {
  text: string;
  speaker: string;
  language: string;
  translated: boolean;
  phase: CaptionPhase;
  error?: string;
}
/** Display-only IPC. Never place transcript history, audio, or provider credentials here. */
export interface CaptionFrame extends CaptionContent {
  sessionId: string;
  enabled: boolean;
  sequence: number;
  epoch: string;
}

/** Captions intentionally ignore the document's bilingual preference. No original-language fallback. */
export function resolveCaptionContent({
  preview, translation, translationEnabled, targetLanguage = 'en', isPaused = false,
}: {
  preview: LiveTranscriptPreview | null;
  translation?: LiveTranslationEntry;
  translationEnabled: boolean;
  targetLanguage?: string;
  isPaused?: boolean;
}): CaptionContent {
  const base = {
    speaker: preview?.speakerLabel || 'Live',
    language: translationEnabled ? targetLanguage : 'und',
    translated: translationEnabled,
  };
  if (isPaused) return { ...base, text: '', phase: 'paused' };
  if (!preview) return { ...base, text: '', phase: 'listening' };
  if (!translationEnabled) return { ...base, text: preview.text, phase: 'live' };
  // Target changes must never briefly display the prior language's cached result.
  const entry = translation?.targetLanguage === targetLanguage ? translation : undefined;
  // A transient provider failure must not replace already-visible translated words
  // with an error message. Keep the last target-language phrase while the app retries.
  if (entry?.translatedText?.trim()) {
    return {
      ...base,
      text: entry.translatedText.trim(),
      phase: entry.status === 'error' ? 'recovering' : 'live',
      error: entry.error,
    };
  }
  if (entry?.status === 'error') return { ...base, text: '', phase: 'error', error: entry.error };
  return { ...base, text: '', phase: 'translating' };
}

export interface CaptionGeometry { x: number; y: number; width: number; height: number }
export interface CaptionScreen extends CaptionGeometry { scaleFactor?: number }
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** Positions/screens use physical pixels; window sizes use logical pixels. Handles mixed-DPI displays. */
export function fitCaptionGeometry(saved: Partial<CaptionGeometry> | null, screen: CaptionScreen): CaptionGeometry {
  const scale = screen.scaleFactor && Number.isFinite(screen.scaleFactor) && screen.scaleFactor > 0 ? screen.scaleFactor : 1;
  const margin = 16;
  const availableWidth = Math.max(240, screen.width / scale - margin * 2);
  const availableHeight = Math.max(120, screen.height / scale - margin * 2);
  const finite = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const width = clamp(finite(saved?.width, 720), Math.min(340, availableWidth), Math.min(1400, availableWidth));
  const height = clamp(finite(saved?.height, 210), Math.min(140, availableHeight), Math.min(800, availableHeight));
  return {
    width, height,
    x: clamp(finite(saved?.x, screen.x + (screen.width - width * scale) / 2), screen.x + margin * scale, screen.x + screen.width - (width + margin) * scale),
    y: clamp(finite(saved?.y, screen.y + screen.height - (height + 72) * scale), screen.y + margin * scale, screen.y + screen.height - (height + margin) * scale),
  };
}

export function selectCaptionScreen(saved: Partial<CaptionGeometry> | null, screens: CaptionScreen[]): CaptionScreen | null {
  if (!screens.length) return null;
  if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
    const found = screens.find(s => saved!.x! >= s.x && saved!.x! < s.x + s.width && saved!.y! >= s.y && saved!.y! < s.y + s.height);
    if (found) return found;
  }
  return screens[0];
}

export function readCaptionGeometry(storage: Pick<Storage, 'getItem'>): Partial<CaptionGeometry> | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(CAPTION_GEOMETRY_KEY) || 'null');
    return value && typeof value === 'object' ? value as Partial<CaptionGeometry> : null;
  } catch { return null; }
}

export interface CaptionAppearance { fontSize: number; opacity: number }
export function normalizeCaptionAppearance(value?: Partial<CaptionAppearance> | null): CaptionAppearance {
  return {
    fontSize: clamp(typeof value?.fontSize === 'number' && Number.isFinite(value.fontSize) ? value.fontSize : 26, 18, 40),
    opacity: clamp(typeof value?.opacity === 'number' && Number.isFinite(value.opacity) ? value.opacity : 0.78, 0.35, 0.96),
  };
}

/** Protect the caption webview from malformed, stale, or cross-session IPC frames. */
export function isCaptionFrame(value: unknown): value is CaptionFrame {
  if (!value || typeof value !== 'object') return false;
  const v = value as CaptionFrame;
  return typeof v.epoch === 'string' && typeof v.sessionId === 'string'
    && Number.isSafeInteger(v.sequence) && v.sequence >= 0 && typeof v.enabled === 'boolean'
    && typeof v.text === 'string' && v.text.length <= 10000
    && typeof v.speaker === 'string' && typeof v.language === 'string'
    && typeof v.translated === 'boolean'
    && (v.error === undefined || typeof v.error === 'string')
    && ['listening', 'translating', 'live', 'paused', 'recovering', 'error'].includes(v.phase);
}

/** Rolling snapshots of one utterance overlap; a different source or later turn must not inherit text. */
export function sameCaptionUtterance(a?: LiveTranscriptPreview | null, b?: LiveTranscriptPreview | null): boolean {
  return Boolean(a && b && a.source === b.source
    && a.audioStartTime < b.audioEndTime && b.audioStartTime < a.audioEndTime);
}

/** Orders IPC and latches a local dismissal until the owner acknowledges it. */
export class CaptionFrameGate {
  private last: CaptionFrame | null = null;
  private retiredEpochs = new Set<string>();
  private dismissed = false;

  dismiss(): void { this.dismissed = true; }

  accept(value: unknown): CaptionFrame | null {
    if (!isCaptionFrame(value) || this.retiredEpochs.has(value.epoch)) return null;
    if (this.last?.epoch === value.epoch && value.sequence <= this.last.sequence) return null;
    if (this.last && this.last.epoch !== value.epoch) this.retiredEpochs.add(this.last.epoch);
    this.last = value;
    if (!value.enabled) this.dismissed = false;
    return this.dismissed ? { ...value, enabled: false, text: '' } : value;
  }
}
