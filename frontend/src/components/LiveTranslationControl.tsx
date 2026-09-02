'use client';

import { Languages, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  getLiveTranslationLanguage,
  LIVE_TRANSLATION_LANGUAGES,
  LiveTranslationSettings,
} from '@/lib/live-translation';

interface LiveTranslationControlProps {
  settings: LiveTranslationSettings;
  updateSettings: (update: Partial<LiveTranslationSettings>) => void;
  clearTranslations: () => void;
  queuedCount: number;
  activeCount: number;
  translatedCount: number;
  lastError: string | null;
  lastProvider: string | null;
  lastModel: string | null;
  lastLatencyMs: number | null;
}

export function LiveTranslationControl({
  settings,
  updateSettings,
  clearTranslations,
  queuedCount,
  activeCount,
  translatedCount,
  lastError,
  lastProvider,
  lastModel,
  lastLatencyMs,
}: LiveTranslationControlProps) {
  const target = getLiveTranslationLanguage(settings.targetLanguage);
  const isWorking = activeCount > 0 || queuedCount > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={settings.enabled ? 'secondary' : 'outline'}
          size="sm"
          title="Live translation"
          aria-label={`Live translation${settings.enabled && target ? ` to ${target.name}` : ''}`}
        >
          {isWorking ? <Loader2 className="animate-spin" /> : <Languages />}
          <span className="hidden md:inline">
            {settings.enabled && target ? target.name : 'Translate'}
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-80" align="center">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h4 className="font-semibold">Live translation</h4>
              <p className="mt-1 text-xs text-muted-foreground">
                Translates completed speech turns immediately. Partial speech is briefly debounced so it does not flood the model.
              </p>
            </div>
            <Switch
              checked={settings.enabled}
              onCheckedChange={(enabled) => updateSettings({ enabled })}
              aria-label="Enable live translation"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="live-translation-language">Translate to</Label>
            <Select
              value={settings.targetLanguage}
              onValueChange={(targetLanguage) => updateSettings({ targetLanguage })}
              disabled={!settings.enabled}
            >
              <SelectTrigger id="live-translation-language">
                <SelectValue placeholder="Choose a language" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {LIVE_TRANSLATION_LANGUAGES.map((language) => (
                  <SelectItem key={language.code} value={language.code}>
                    {language.name} · {language.nativeName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="live-translation-display">Display</Label>
            <Select
              value={settings.displayMode}
              onValueChange={(displayMode: 'bilingual' | 'translated') =>
                updateSettings({ displayMode })
              }
              disabled={!settings.enabled}
            >
              <SelectTrigger id="live-translation-display">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bilingual">Original + translation</SelectItem>
                <SelectItem value="translated">Translation only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {settings.enabled && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">
                  {isWorking
                    ? `${activeCount} translating · ${queuedCount} queued`
                    : translatedCount > 0
                      ? `${translatedCount} turns translated`
                      : 'Ready for the next speech turn'}
                </span>
                {lastLatencyMs !== null && (
                  <span className="text-muted-foreground">
                    {lastLatencyMs === 0 ? 'cached' : `${(lastLatencyMs / 1000).toFixed(1)}s`}
                  </span>
                )}
              </div>

              {lastProvider && (
                <p className="mt-1 truncate text-muted-foreground" title={`${lastProvider} / ${lastModel ?? ''}`}>
                  {lastProvider}{lastModel ? ` / ${lastModel}` : ''}
                </p>
              )}

              {lastError && (
                <p className="mt-2 line-clamp-3 text-destructive" title={lastError}>
                  {lastError}
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Uses the summarization provider selected in Model Settings. Cloud providers receive only the text being translated.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={clearTranslations}
              disabled={translatedCount === 0 && !isWorking}
              title="Clear live translations"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
