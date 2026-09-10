'use client';

import { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import {
  DEFAULT_LIVE_TRANSLATION_SETTINGS,
  LIVE_TRANSLATION_LANGUAGES,
  loadLiveTranslationSettings,
  saveLiveTranslationSettings,
  type LiveTranslationEngine,
  type LiveTranslationSettings,
  type LiveTranslationSpeed,
  type TranslationDisplayMode,
} from '@/lib/live-translation';
import SettingRow from './SettingRow';

const selectClass = 'h-8 min-w-[180px] rounded-control border border-border bg-bg px-2.5 text-ui text-text outline-none focus:border-accent';
const textFieldClass = 'h-8 w-full min-w-[220px] rounded-control border border-border bg-bg px-2.5 text-ui text-text outline-none placeholder:text-3 focus:border-accent';

export default function LiveTranslationSettingsSection() {
  const [settings, setSettings] = useState<LiveTranslationSettings>(DEFAULT_LIVE_TRANSLATION_SETTINGS);

  useEffect(() => {
    setSettings(loadLiveTranslationSettings());
  }, []);

  const update = (patch: Partial<LiveTranslationSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveLiveTranslationSettings(next);
      window.dispatchEvent(new CustomEvent('meetodds:live-translation-settings-updated', {
        detail: next,
      }));
      return next;
    });
  };

  return (
    <div>
      <SettingRow
        label="Live translation"
        description="Translate transcript segments as they arrive. The original transcript remains the source of truth."
        control={<Switch checked={settings.enabled} onCheckedChange={(enabled) => update({ enabled })} />}
      />

      <SettingRow
        label="Target language"
        description="Language shown beside or instead of the original transcript."
        control={(
          <select
            value={settings.targetLanguage}
            onChange={(event) => update({ targetLanguage: event.target.value })}
            className={selectClass}
          >
            {LIVE_TRANSLATION_LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.name} · {language.nativeName}
              </option>
            ))}
          </select>
        )}
      />

      <SettingRow
        label="Translation speed"
        description="Instant prioritizes latency; Accurate allows more processing time."
        control={(
          <select
            value={settings.speed}
            onChange={(event) => update({ speed: event.target.value as LiveTranslationSpeed })}
            className={selectClass}
          >
            <option value="instant">Instant</option>
            <option value="balanced">Balanced</option>
            <option value="accurate">Accurate</option>
          </select>
        )}
      />

      <SettingRow
        label="Translation engine"
        description="Choose local on-device AI, Ollama, cloud API, or auto-detection."
        control={(
          <select
            value={settings.engine}
            onChange={(event) => update({ engine: event.target.value as LiveTranslationEngine })}
            className={selectClass}
          >
            <option value="auto">Auto · best available</option>
            <option value="builtin-ai">Local AI (On-device Built-in)</option>
            <option value="ollama">Ollama (Local)</option>
            <option value="summary">Summary model</option>
            <option value="groq">Groq (Fast Cloud)</option>
            <option value="openai">OpenAI (Cloud)</option>
            <option value="claude">Claude (Cloud)</option>
          </select>
        )}
      />

      <SettingRow
        label="Display mode"
        description="Bilingual preserves original and translated text together."
        control={(
          <select
            value={settings.displayMode}
            onChange={(event) => update({ displayMode: event.target.value as TranslationDisplayMode })}
            className={selectClass}
          >
            <option value="bilingual">Bilingual</option>
            <option value="translated">Translation only</option>
          </select>
        )}
      />

      <SettingRow
        label="Context turns"
        description="Include recent transcript turns to improve names and phrase continuity."
        control={(
          <select
            value={settings.contextTurns}
            onChange={(event) => update({ contextTurns: Number(event.target.value) as 0 | 2 | 4 })}
            className={selectClass}
          >
            <option value={0}>None</option>
            <option value={2}>2 turns</option>
            <option value={4}>4 turns</option>
          </select>
        )}
      />

      <SettingRow
        label="Model override"
        description="Optional provider-specific model name. Leave blank to use the configured default."
        align="start"
        control={(
          <input
            value={settings.modelOverride}
            onChange={(event) => update({ modelOverride: event.target.value })}
            placeholder="Use configured default"
            className={textFieldClass}
          />
        )}
      />

      <SettingRow
        label="Glossary"
        description="Optional names or domain terms to preserve during translation."
        align="start"
        control={(
          <textarea
            value={settings.glossary}
            onChange={(event) => update({ glossary: event.target.value })}
            placeholder="N26, MeetOdds, product names…"
            className="min-h-[88px] w-full min-w-[220px] resize-y rounded-control border border-border bg-bg px-2.5 py-2 text-ui text-text outline-none placeholder:text-3 focus:border-accent"
          />
        )}
      />

      <SettingRow
        label="Context hint"
        description="Optional background that helps the translator interpret specialist language."
        align="start"
        control={(
          <textarea
            value={settings.contextHint}
            onChange={(event) => update({ contextHint: event.target.value })}
            placeholder="e.g. fintech product review"
            className="min-h-[88px] w-full min-w-[220px] resize-y rounded-control border border-border bg-bg px-2.5 py-2 text-ui text-text outline-none placeholder:text-3 focus:border-accent"
          />
        )}
      />
    </div>
  );
}
