// Display-only script conversion. Never feed this result to speech or scoring.
// The native command uses Core Foundation, not another model request.
export type DisplayTransliterator = (text: string, language: string) => Promise<string>;

export function needsReadableScript(text: string, language: string | undefined): boolean {
  if (language === 'hi') return /[\u0900-\u097f\ua8e0-\ua8ff]/u.test(text);
  if (language === 'zh') return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{323af}]/u.test(text);
  return false;
}

/** Instance-scoped cache; one per mounted learning screen, never localStorage. */
export function createReadableScriptCache(transliterate: DisplayTransliterator) {
  const cache = new Map<string, Promise<string>>();
  return (text: string, language?: string): Promise<string> => {
    if (!language || !needsReadableScript(text, language)) return Promise.resolve(text);
    const key = JSON.stringify([language, text]);
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = transliterate(text, language).then((display) => {
      if (!display.trim() || needsReadableScript(display, language)) throw new Error('Readable script unavailable.');
      return display;
    }).catch((error: unknown) => {
      // Failed conversions may be retried; never cache an error as a translation.
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    if (cache.size > 128) cache.delete(cache.keys().next().value as string);
    return pending;
  };
}
