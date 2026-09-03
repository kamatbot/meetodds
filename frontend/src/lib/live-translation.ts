\
export type TranslationDisplayMode = 'bilingual' | 'translated';
export type LiveTranslationStatus = 'queued' | 'translating' | 'translated' | 'error';
export type LiveTranslationSpeed = 'instant' | 'balanced' | 'accurate';
export type LiveTranslationEngine = 'auto' | 'summary' | 'groq' | 'openai' | 'claude';

export interface LiveTranslationLanguage {
  code: string;
  name: string;
  nativeName: string;
}

export interface LiveTranslationSettings {
  enabled: boolean;
  sourceLanguage: 'auto';
  targetLanguage: string;
  displayMode: TranslationDisplayMode;
  speed: LiveTranslationSpeed;
  engine: LiveTranslationEngine;
  contextTurns: 0 | 2 | 4;
  modelOverride: string;
  glossary: string;
  contextHint: string;
}

export interface LiveTranslationEntry {
  segmentKey: string;
  sourceText: string;
  translatedText?: string;
  targetLanguage: string;
  status: LiveTranslationStatus;
  error?: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
  firstWordLatencyMs?: number;
  fallbackReason?: string;
  cached?: boolean;
}

export interface LiveTranslationResponse {
  requestId: string;
  translatedText: string;
  sourceLanguage?: string | null;
  targetLanguage: string;
  provider: string;
  model: string;
  latencyMs: number;
  firstWordLatencyMs: number;
  fallbackReason?: string | null;
  cached: boolean;
}

export const LIVE_TRANSLATION_LANGUAGES: LiveTranslationLanguage[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
];

export const DEFAULT_LIVE_TRANSLATION_SETTINGS: LiveTranslationSettings = {
  enabled: false,
  sourceLanguage: 'auto',
  targetLanguage: 'en',
  displayMode: 'bilingual',
  speed: 'instant',
  engine: 'auto',
  contextTurns: 2,
  modelOverride: '',
  glossary: '',
  contextHint: '',
};

export const LIVE_TRANSLATION_STORAGE_KEY = 'meetodds.liveTranslation.v2';
const LEGACY_STORAGE_KEY = 'meetodds.liveTranslation.v1';

export function getLiveTranslationLanguage(code: string): LiveTranslationLanguage | undefined {
  return LIVE_TRANSLATION_LANGUAGES.find((language) => language.code === code);
}

export function loadLiveTranslationSettings(): LiveTranslationSettings {
  if (typeof window === 'undefined') return DEFAULT_LIVE_TRANSLATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(LIVE_TRANSLATION_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return DEFAULT_LIVE_TRANSLATION_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<LiveTranslationSettings>;
    const supportedTarget = LIVE_TRANSLATION_LANGUAGES.some(
      (language) => language.code === parsed.targetLanguage
    );
    const speed: LiveTranslationSpeed = ['instant', 'balanced', 'accurate'].includes(parsed.speed ?? '')
      ? parsed.speed as LiveTranslationSpeed
      : 'instant';
    const engine: LiveTranslationEngine = ['auto', 'summary', 'groq', 'openai', 'claude'].includes(parsed.engine ?? '')
      ? parsed.engine as LiveTranslationEngine
      : 'auto';
    const contextTurns: 0 | 2 | 4 = parsed.contextTurns === 0 || parsed.contextTurns === 4 ? parsed.contextTurns : 2;
    return {
      enabled: parsed.enabled === true,
      sourceLanguage: 'auto',
      targetLanguage: supportedTarget ? parsed.targetLanguage! : 'en',
      displayMode: parsed.displayMode === 'translated' ? 'translated' : 'bilingual',
      speed,
      engine,
      contextTurns,
      modelOverride: typeof parsed.modelOverride === 'string' ? parsed.modelOverride : '',
      glossary: typeof parsed.glossary === 'string' ? parsed.glossary : '',
      contextHint: typeof parsed.contextHint === 'string' ? parsed.contextHint : '',
    };
  } catch {
    return DEFAULT_LIVE_TRANSLATION_SETTINGS;
  }
}

export function saveLiveTranslationSettings(settings: LiveTranslationSettings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LIVE_TRANSLATION_STORAGE_KEY, JSON.stringify(settings));
}

export function liveTranslationSegmentKey(segment: { id: string; sequence_id?: number }): string {
  return segment.sequence_id === undefined ? segment.id : `sequence-${segment.sequence_id}`;
}
