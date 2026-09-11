'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { Check, ChevronDown, FileCheck2, Languages, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { Summary, SummaryResponse, Transcript } from '@/types';
import { BlockNoteSummaryView, type BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import type { ModelConfig } from '@/components/ModelSettingsModal';
import { SummaryGeneratorButtonGroup } from './SummaryGeneratorButtonGroup';
import { SummaryUpdaterButtonGroup } from './SummaryUpdaterButtonGroup';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { LanguagePickerPopover } from '@/components/LanguagePickerPopover';
import { useRecentLanguages } from '@/hooks/useRecentLanguages';
import { useConfig } from '@/contexts/ConfigContext';
import { labelForCode } from '@/lib/summary-languages';
import { parseSummaryData } from '@/lib/summary-input';
import { AUTO_SUMMARY_CHOICE_KEY } from '@/lib/post-meeting-flow';
import type { MeetingExportFormat } from '@/lib/meeting-export';
import ExportSheet from '@/components/Meeting/ExportSheet';
import MeetingOutcomeWorkspace from '@/components/Meeting/MeetingOutcomeWorkspace';
import { readMeetingSummaryLanguage, saveMeetingSummaryLanguage, type SummaryLanguageStorage } from '@/lib/summary-language-preferences';

type Status = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
interface SummaryPanelProps {
  meeting: { id: string; title: string; created_at: string };
  meetingTitle: string;
  onTitleChange: (title: string) => void;
  isEditingTitle: boolean;
  onStartEditTitle: () => void;
  onFinishEditTitle: () => void;
  isTitleDirty: boolean;
  summaryRef: RefObject<BlockNoteSummaryViewRef>;
  isSaving: boolean;
  onSaveAll: () => Promise<void>;
  onCopySummary: () => Promise<void>;
  onOpenFolder: () => Promise<void>;
  aiSummary: Summary | null;
  summaryStatus: Status;
  transcripts: Transcript[];
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig | ((previous: ModelConfig) => ModelConfig)) => void;
  onSaveModelConfig: (config?: ModelConfig) => Promise<void>;
  onGenerateSummary: (prompt: string) => Promise<void>;
  onStopGeneration: () => void;
  customPrompt: string;
  summaryResponse: SummaryResponse | null;
  onSaveSummary: (summary: Summary | { markdown?: string; summary_json?: any[] }) => Promise<void>;
  onSummaryChange: (summary: Summary) => void;
  onDirtyChange: (dirty: boolean) => void;
  summaryError: string | null;
  onRegenerateSummary: () => Promise<void>;
  getSummaryStatusMessage: (status: Status) => string;
  availableTemplates: Array<{ id: string; name: string; description: string }>;
  selectedTemplate: string;
  onTemplateSelect: (id: string, name: string) => void;
  isModelConfigLoading?: boolean;
  onOpenModelSettings?: (open: () => void) => void;
}

export function SummaryPanel(props: SummaryPanelProps) {
  const { meeting, aiSummary, summaryStatus, summaryError, transcripts, modelConfig, summaryRef } = props;
  const { isAutoSummary, toggleIsAutoSummary } = useConfig();
  const [firstChoice, setFirstChoice] = useState(false);
  const [summaryLang, setSummaryLang] = useState<string | null>(null);
  const [summaryLangStorage, setSummaryLangStorage] = useState<SummaryLanguageStorage>('metadata');
  const [langPickerOpen, setLangPickerOpen] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<MeetingExportFormat | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<MeetingExportFormat>('markdown');
  const languageLoadVersion = useRef(0);
  const activeMeetingId = useRef(meeting.id);
  activeMeetingId.current = meeting.id;
  const saveRunning = useRef(false);
  const pendingLanguage = useRef<{ meetingId: string; version: number; language: string | null; rollback: { language: string | null; storage: SummaryLanguageStorage } } | null>(null);
  const languageVersion = useRef(0);
  const { addRecent } = useRecentLanguages();
  const busy = ['processing', 'summarizing', 'regenerating'].includes(summaryStatus);
  const hasSummary = Boolean(parseSummaryData(aiSummary));
  const localProvider = modelConfig.provider === 'builtin-ai' || modelConfig.provider === 'ollama';
  const providerLabel = modelConfig.provider === 'openai-codex' ? 'Your connected ChatGPT account'
    : modelConfig.provider === 'builtin-ai' ? 'Built-in AI on your device'
    : modelConfig.provider === 'ollama' ? 'Your configured Ollama server' : 'Your selected AI provider';

  useEffect(() => {
    try { setFirstChoice(!localStorage.getItem(AUTO_SUMMARY_CHOICE_KEY)); } catch { setFirstChoice(true); }
    let cancelled = false;
    const version = ++languageLoadVersion.current;
    void readMeetingSummaryLanguage(meeting.id).then(stored => {
      if (!cancelled && version === languageLoadVersion.current) { setSummaryLang(stored.language); setSummaryLangStorage(stored.storage); }
    }).catch(() => { if (!cancelled) toast.warning('Could not load saved summary language', { description: 'Using Auto until meeting metadata can be read.' }); });
    return () => { cancelled = true; };
  }, [meeting.id]);

  const persistLanguage = async () => {
    if (saveRunning.current) return;
    saveRunning.current = true;
    try {
      while (pendingLanguage.current) {
        const request = pendingLanguage.current;
        try {
          const saved = await saveMeetingSummaryLanguage(request.meetingId, request.language);
          if (pendingLanguage.current?.version === request.version && activeMeetingId.current === request.meetingId) {
            setSummaryLang(saved.language); setSummaryLangStorage(saved.storage);
            if (request.language) addRecent(request.language);
            if (saved.storage === 'local_fallback') toast.info('Summary language saved on this device');
          }
        } catch {
          if (pendingLanguage.current?.version === request.version && activeMeetingId.current === request.meetingId) {
            setSummaryLang(request.rollback.language); setSummaryLangStorage(request.rollback.storage);
            toast.error('Failed to save summary language');
          }
        }
        if (pendingLanguage.current?.version === request.version) pendingLanguage.current = null;
      }
    } finally { saveRunning.current = false; }
  };
  const changeLanguage = (language: string | null) => {
    ++languageLoadVersion.current;
    pendingLanguage.current = { version: ++languageVersion.current, meetingId: meeting.id, language, rollback: { language: summaryLang, storage: summaryLangStorage } };
    setSummaryLang(language); setLangPickerOpen(false); void persistLanguage();
  };
  const generate = async (prompt: string) => {
    try {
      if (hasSummary) await props.onSaveAll();
      try { localStorage.setItem(AUTO_SUMMARY_CHOICE_KEY, 'chosen'); setFirstChoice(false); } catch { /* Optional preference. */ }
      await props.onGenerateSummary(prompt);
    } catch { toast.error('Could not prepare the summary. Save your edits and retry.'); }
  };
  const exportSummary = async (format: MeetingExportFormat) => {
    if (exportingFormat) return;
    setExportingFormat(format);
    try { await props.onSaveAll(); setExportFormat(format); setExportOpen(true); }
    catch { toast.error('Save your summary edits before exporting'); }
    finally { setExportingFormat(null); }
  };
  const languageSlot = <Popover open={langPickerOpen} onOpenChange={setLangPickerOpen}>
    <PopoverTrigger asChild><Button type="button" variant="outline" disabled={busy} aria-label="Set summary language"><Languages size={16} />{summaryLang ? labelForCode(summaryLang) : 'Auto language'}<ChevronDown size={13} /></Button></PopoverTrigger>
    <PopoverContent align="end" className="w-auto border-0 bg-transparent p-0 shadow-none"><LanguagePickerPopover value={summaryLang} onChange={changeLanguage} onClose={() => setLangPickerOpen(false)} autoSubtitle={summaryLangStorage === 'local_fallback' ? 'Saved on this device for folderless meetings' : 'Uses dominant transcript language'} /></PopoverContent>
  </Popover>;
  const controls = <SummaryGeneratorButtonGroup {...props} onGenerateSummary={generate} hasTranscripts={transcripts.length > 0} hasSummary={hasSummary} languageSlot={languageSlot} />;

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
    <ExportSheet meetingId={meeting.id} open={exportOpen} onOpenChange={setExportOpen} initialFormat={exportFormat} />
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1040px] space-y-6 px-5 py-6 sm:px-8">
        <ol aria-label="Post-meeting progress" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-3">
          <li className="inline-flex items-center gap-2 text-text"><Check size={14} /> Meeting saved</li>
          <li aria-current={!hasSummary ? 'step' : undefined} className="inline-flex items-center gap-2"><span className="grid h-5 w-5 place-items-center rounded-full border border-border">{hasSummary && !busy ? <Check size={12} /> : '2'}</span> AI summary & actions</li>
          <li aria-current={hasSummary && !busy ? 'step' : undefined} className="inline-flex items-center gap-2"><span className="grid h-5 w-5 place-items-center rounded-full border border-border">3</span> Meeting outcome</li>
        </ol>
        {!hasSummary ? <section className="rounded-2xl border border-border bg-surface p-6 sm:p-9" aria-labelledby="post-meeting-title">
          <div className="mb-5 inline-grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent">{busy ? <Loader2 size={23} className="animate-spin motion-reduce:animate-none" /> : <FileCheck2 size={23} strokeWidth={1.5} />}</div>
          <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-3">{busy ? 'YOUR AI IS AT WORK' : 'THE CONVERSATION IS CAPTURED'}</p>
          <h2 id="post-meeting-title" className="mt-2 text-2xl font-semibold tracking-tight text-text sm:text-3xl">{busy ? 'Turning the conversation into clarity.' : 'Make the meeting useful.'}</h2>
          <p className="mt-3 max-w-[580px] text-sm leading-7 text-2">{busy ? props.getSummaryStatusMessage(summaryStatus) : 'Generate a thoughtful summary, clear decisions, and well-written next steps together. No guessed tasks. No fragments pulled from the transcript.'}</p>
          <div className="mt-6">{controls}</div>
          <p className="mt-3 text-xs text-3">{providerLabel}{modelConfig.model ? ` · ${modelConfig.model}` : ' · Choose a model to begin'}</p>
          {!busy && transcripts.length > 0 && <div className="mt-7 border-t border-border pt-5">
            <label className="flex cursor-pointer items-start gap-3 text-sm text-text"><input type="checkbox" className="mt-1 h-4 w-4 accent-current" checked={isAutoSummary} onChange={event => {
              toggleIsAutoSummary(event.target.checked);
              try { localStorage.setItem(AUTO_SUMMARY_CHOICE_KEY, 'chosen'); setFirstChoice(false); } catch { /* Preference only. */ }
            }} /><span><strong className="font-medium">{firstChoice ? 'Make this automatic after future meetings' : 'Generate automatically after future meetings'}</strong><span className="mt-1 block max-w-[560px] text-xs leading-5 text-3">You will approve the provider and included notes on the next screen. Changing the provider, model, or destination requires a new approval. You can turn this off in Settings.</span></span></label>
          </div>}
          {!transcripts.length && <p role="status" className="mt-5 text-sm text-2">No saved speech was found. Your notes are available in the Notes tab; no actions will be invented.</p>}
          {busy && <p role="status" className="mt-5 text-xs leading-5 text-3">Your recording and notes are unchanged. Actions will appear only after the AI result is saved.</p>}
        </section> : <header className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-3">{busy ? 'UPDATING YOUR AI SUMMARY' : 'READY TO REVIEW'}</p><h2 className="mt-1 text-2xl font-semibold tracking-tight text-text">Your meeting, made clear.</h2></div><span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-xs text-accent"><Sparkles size={13} /> AI-generated · review before sharing</span></div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3">{controls}<SummaryUpdaterButtonGroup isSaving={props.isSaving} isDirty={props.isTitleDirty || (summaryRef.current?.isDirty || false)} onSave={() => props.onSaveAll().catch(() => undefined)} onCopy={props.onCopySummary} onFind={() => window.dispatchEvent(new CustomEvent('meetodds:find-summary'))} onOpenFolder={props.onOpenFolder} onExport={exportSummary} exportingFormat={exportingFormat} hasSummary /></div>
        </header>}
        {summaryError && <div role="alert" className="rounded-xl border border-border bg-surface p-4 text-sm leading-6 text-danger">{summaryError}</div>}
        {busy && hasSummary && <div role="status" className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 text-sm text-2"><Loader2 size={16} className="shrink-0 animate-spin motion-reduce:animate-none" />{props.getSummaryStatusMessage(summaryStatus)} Your previous summary is kept below until the new result succeeds.</div>}
        {hasSummary && <>
          <section className="overflow-hidden rounded-2xl border border-border bg-surface" aria-label="AI meeting summary">
            <div className="border-b border-border px-6 py-4"><h3 className="text-sm font-semibold text-text">AI summary</h3><p className="mt-1 text-xs text-3">The full picture, with your notes in context. Editable without changing the original transcript.</p></div>
            <div className="p-4 sm:p-6" aria-busy={busy} style={busy ? { pointerEvents: 'none' } : undefined}>
              <BlockNoteSummaryView key={meeting.id} ref={summaryRef} summaryData={aiSummary} onSave={props.onSaveSummary} onSummaryChange={props.onSummaryChange} onDirtyChange={props.onDirtyChange} status={summaryStatus} error={summaryError}
                onRegenerateSummary={() => void generate(props.customPrompt)} meeting={{ id: meeting.id, title: props.meetingTitle, created_at: meeting.created_at }} />
            </div>
          </section>
          {!busy && <section aria-label="AI-generated meeting outcome and actions"><MeetingOutcomeWorkspace meetingId={meeting.id} /></section>}
        </>}
        <p className="pb-2 text-xs leading-5 text-3">{!hasSummary ? 'Your saved transcript and notes are always available in the tabs above.' : 'Actions are taken from the saved AI summary. Your confirmed decisions and completed work survive regeneration.'} {localProvider ? 'The next screen shows the exact processing destination.' : 'Only approved text is sent to the selected provider; audio is not sent for this summary.'}</p>
      </div>
    </div>
  </div>;
}
