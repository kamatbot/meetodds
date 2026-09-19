'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createReadableScriptCache, needsReadableScript } from '@/lib/practice-script';

const ScriptContext = createContext<ReturnType<typeof createReadableScriptCache> | null>(null);

export function PracticeScriptProvider({ children }: { children: ReactNode }) {
  const convert = useMemo(() => createReadableScriptCache((text, language) =>
    invoke<string>('spanish_display_text', { text, language })), []);
  return <ScriptContext.Provider value={convert}>{children}</ScriptContext.Provider>;
}

/** English letters, not an English translation. Original strings remain in the
 * caller's state and click handlers so pinyin can never become TTS input. */
export function PracticeText({ text, language }: { text: string; language?: string }) {
  const convert = useContext(ScriptContext);
  const [result, setResult] = useState<{ source: string; language?: string; display: string } | null>(null);
  useEffect(() => {
    let current = true;
    if (convert && needsReadableScript(text, language)) {
      void convert(text, language).then((display) => {
        if (current) setResult({ source: text, language, display });
      }).catch(() => { if (current) setResult(null); });
    }
    return () => { current = false; };
  }, [convert, text, language]);
  // Never show a previous phrase/language while a new conversion is in flight.
  const display = result?.source === text && result.language === language ? result.display : text;
  return <span lang={display !== text ? `${language}-Latn` : language}>{display}</span>;
}
