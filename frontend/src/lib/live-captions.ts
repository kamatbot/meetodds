import type { LiveTranscriptPreview } from '@/types';
import type { LiveTranslationEntry } from './live-translation';

export const CAPTION_WINDOW_LABEL = 'live-captions';
export const CAPTION_FRAME_EVENT = 'meetodds:caption-frame';
export const CAPTION_READY_EVENT = 'meetodds:caption-ready';
export const CAPTION_DISMISS_EVENT = 'meetodds:caption-dismiss';
export const CAPTION_GEOMETRY_KEY = 'meetodds.captions.geometry.v1';
export const CAPTION_APPEARANCE_KEY = 'meetodds.captions.appearance.v1';
export const CAPTION_RESET_EVENT = 'meetodds:caption-reset';

export type CaptionPhase = 'listening' | 'translating' | 'live' | 'paused' | 'error';
export interface CaptionContent {
  text: string;
  speaker: string;
  language: string;
  translated: boolean;
  phase: CaptionPhase;
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
  if (entry?.translatedText?.trim()) {
    return { ...base, text: entry.translatedText.trim(), phase: entry.status === 'error' ? 'error' : 'live' };
  }
  return { ...base, text: '', phase: entry?.status === 'error' ? 'error' : 'translating' };
}

export interface CaptionGeometry { x: number; y: number; width: number; height: number }
export interface CaptionScreen extends CaptionGeometry {}
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** All values are logical pixels. Supports displays left/above the primary display. */
export function fitCaptionGeometry(saved: Partial<CaptionGeometry> | null, screen: CaptionScreen): CaptionGeometry {
  const margin = 16;
  const availableWidth = Math.max(240, screen.width - margin * 2);
  const availableHeight = Math.max(120, screen.height - margin * 2);
  const finite = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const width = clamp(finite(saved?.width, 720), Math.min(340, availableWidth), Math.min(1400, availableWidth));
  const height = clamp(finite(saved?.height, 210), Math.min(140, availableHeight), Math.min(800, availableHeight));
  return {
    width, height,
    x: clamp(finite(saved?.x, screen.x + (screen.width - width) / 2), screen.x + margin, screen.x + screen.width - width - margin),
    y: clamp(finite(saved?.y, screen.y + screen.height - height - 72), screen.y + margin, screen.y + screen.height - height - margin),
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
    && ['listening', 'translating', 'live', 'paused', 'error'].includes(v.phase);
}
