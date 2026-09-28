import { useCallback, useState } from 'react';
import { getAppleSpeechCapabilities, type AppleSpeechLocale } from '@/lib/apple-speech';

/**
 * Installed Apple Speech locales for file transcription (imports and re-transcription).
 * Only installed languages can be transcribed; downloads happen in Settings.
 */
export function useAppleSpeechLocales() {
  const [locales, setLocales] = useState<AppleSpeechLocale[]>([]);
  const [loadingLocales, setLoadingLocales] = useState(false);

  const fetchLocales = useCallback(async () => {
    setLoadingLocales(true);
    try {
      const capabilities = await getAppleSpeechCapabilities();
      setLocales(capabilities.available ? capabilities.locales.filter((locale) => locale.installed) : []);
    } catch (error) {
      console.error('Failed to read Apple Speech languages:', error);
      setLocales([]);
    } finally {
      setLoadingLocales(false);
    }
  }, []);

  return { locales, loadingLocales, fetchLocales };
}
