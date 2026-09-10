'use client';

import { Languages, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  getLiveTranslationLanguage,
  LIVE_TRANSLATION_LANGUAGES,
  LiveTranslationEngine,
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
  lastFirstWordLatencyMs: number | null;
  lastFallbackReason: string | null;
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
  lastFirstWordLatencyMs,
  lastFallbackReason,
}: LiveTranslationControlProps) {
  const target = getLiveTranslationLanguage(settings.targetLanguage);
  const isWorking = activeCount > 0 || queuedCount > 0;
  const subscriptionOrLocalPath = ['openai-codex', 'ollama', 'builtin-ai'].includes(lastProvider ?? '');

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
          <span className="hidden md:inline">{settings.enabled && target ? target.name : 'Translate'}</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-96" align="center">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h4 className="font-semibold">Live translation</h4>
              <p className="mt-1 text-xs text-muted-foreground">
                Shows the selected language in floating captions as words arrive. If a provider is slow, the last good translation stays visible while MeetOdds recovers.
              </p>
            </div>
            <Switch checked={settings.enabled} onCheckedChange={(enabled) => updateSettings({ enabled })} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Speed</Label>
              <Select value={settings.speed} onValueChange={(speed: 'instant' | 'balanced' | 'accurate') => updateSettings({ speed })} disabled={!settings.enabled}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="instant">Instant</SelectItem>
                  <SelectItem value="balanced">Balanced</SelectItem>
                  <SelectItem value="accurate">Accurate</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Translation engine</Label>
              <Select value={settings.engine} onValueChange={(engine: LiveTranslationEngine) => updateSettings({ engine })} disabled={!settings.enabled}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto · best available</SelectItem>
                  <SelectItem value="builtin-ai">Local AI · On-device GGUF</SelectItem>
                  <SelectItem value="ollama">Ollama · Local server</SelectItem>
                  <SelectItem value="groq">Groq · instant</SelectItem>
                  <SelectItem value="openai">OpenAI · ChatGPT subscription</SelectItem>
                  <SelectItem value="claude">Claude · Haiku</SelectItem>
                  <SelectItem value="summary">Summary provider</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Translate to</Label>
            <Select value={settings.targetLanguage} onValueChange={(targetLanguage) => updateSettings({ targetLanguage })} disabled={!settings.enabled}>
              <SelectTrigger><SelectValue placeholder="Choose a language" /></SelectTrigger>
              <SelectContent className="max-h-72">
                {LIVE_TRANSLATION_LANGUAGES.map((language) => (
                  <SelectItem key={language.code} value={language.code}>
                    {language.name} · {language.nativeName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Context</Label>
              <Select value={String(settings.contextTurns)} onValueChange={(value) => updateSettings({ contextTurns: Number(value) as 0 | 2 | 4 })} disabled={!settings.enabled}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Current turn only</SelectItem>
                  <SelectItem value="2">2 prior turns</SelectItem>
                  <SelectItem value="4">4 prior turns</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Transcript display</Label>
              <Select value={settings.displayMode} onValueChange={(displayMode: 'bilingual' | 'translated') => updateSettings({ displayMode })} disabled={!settings.enabled}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bilingual">Original + translation</SelectItem>
                  <SelectItem value="translated">Translation only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <details className="rounded-md border p-3 text-xs">
            <summary className="cursor-pointer font-medium">Accuracy hints & advanced model</summary>
            <div className="mt-3 space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Keywords / names</Label>
                <Input value={settings.glossary} onChange={(event) => updateSettings({ glossary: event.target.value })} placeholder="N26, MeetOdds, EBITDA, Mayur" disabled={!settings.enabled} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Meeting context</Label>
                <Input value={settings.contextHint} onChange={(event) => updateSettings({ contextHint: event.target.value })} placeholder="Product review for a fintech team" disabled={!settings.enabled} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Model override</Label>
                <Input value={settings.modelOverride} onChange={(event) => updateSettings({ modelOverride: event.target.value })} placeholder="Leave blank for provider default" disabled={!settings.enabled || settings.engine === 'auto'} />
              </div>
            </div>
          </details>

          {settings.enabled && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">
                  {isWorking ? `${activeCount} translating · ${queuedCount} queued` : translatedCount > 0 ? `${translatedCount} turns translated` : 'Ready for the next speech turn'}
                </span>
                <div className="text-right text-muted-foreground">
                  {lastFirstWordLatencyMs !== null && <div>first word {(lastFirstWordLatencyMs / 1000).toFixed(1)}s</div>}
                  {lastLatencyMs !== null && <div>{lastLatencyMs === 0 ? 'cached' : `complete ${(lastLatencyMs / 1000).toFixed(1)}s`}</div>}
                </div>
              </div>
              {lastProvider && <p className="mt-1 truncate text-muted-foreground">{lastProvider}{lastModel ? ` / ${lastModel}` : ''}</p>}
              {lastFallbackReason && <p className="mt-2 line-clamp-2 text-amber-700">Trying another provider: {lastFallbackReason}</p>}
              {subscriptionOrLocalPath && <p className="mt-2 text-muted-foreground">Connected ChatGPT and local models can take a little longer to start than dedicated translation APIs. MeetOdds keeps the last translated phrase visible while they catch up.</p>}
              {lastError && <p className="mt-2 line-clamp-3 text-destructive">{lastError}</p>}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Auto tries configured fast translation APIs first, then your current summary provider—including connected ChatGPT or a local model. Floating captions always show only the selected target language; the saved original transcript is unchanged.
            </p>
            <Button type="button" variant="ghost" size="icon" onClick={clearTranslations} disabled={translatedCount === 0 && !isWorking} title="Clear live translations">
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
