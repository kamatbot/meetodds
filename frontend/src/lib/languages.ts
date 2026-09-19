// Target-language registry, mirroring frontend/src-tauri/src/languages/mod.rs.
// Content originates in the Mural iOS app (Core/Languages); the Rust module is
// the single source of truth at runtime and these are its wire types.

import { invoke } from '@tauri-apps/api/core';

/** Stable storage keys. Never rename: profiles persist these. */
export type LanguageId = 'nb' | 'es' | 'en' | 'fr' | 'de' | 'it' | 'pt' | 'zh' | 'hi';

export interface LanguageSummary {
  id: LanguageId;
  name: string;
  nativeName: string;
  variety: string;
  locale: string;
  greeting: string;
  topicPlaceholder: string;
  settingsTitle: string;
  talkTitle: string;
}

export interface ConversationTheme {
  id: string;
  title: string;
  subtitle: string;
  /** SF Symbol name carried over from Mural; map to the web icon set. */
  symbol: string;
  category: string;
  situation: string;
  colorIndex: number;
}

/** Subtitle language paired with its greeting. */
export type MeaningOption = [name: string, greeting: string];

export const DEFAULT_LANGUAGE_ID: LanguageId = 'nb';

export function listLanguages(): Promise<LanguageSummary[]> {
  return invoke<LanguageSummary[]>('languages_list');
}

export function listThemes(languageId: LanguageId): Promise<ConversationTheme[]> {
  return invoke<ConversationTheme[]>('languages_themes', { languageId });
}

export function listMeaningOptions(): Promise<MeaningOption[]> {
  return invoke<MeaningOption[]>('languages_meaning_options');
}

/** Theme categories, in the order Mural groups them for display. */
export const THEME_CATEGORIES = ['Everyday', 'Connection', 'Local life', 'Interests'] as const;
export type ThemeCategory = (typeof THEME_CATEGORIES)[number];

export function groupThemesByCategory(
  themes: ConversationTheme[],
): Record<ThemeCategory, ConversationTheme[]> {
  const grouped = Object.fromEntries(
    THEME_CATEGORIES.map((c) => [c, [] as ConversationTheme[]]),
  ) as Record<ThemeCategory, ConversationTheme[]>;
  for (const theme of themes) {
    const bucket = grouped[theme.category as ThemeCategory];
    // An unrecognised category is dropped rather than crashing the picker;
    // THEME_CATEGORIES is kept in step with the Rust registry.
    if (bucket) bucket.push(theme);
  }
  return grouped;
}
