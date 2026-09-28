'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Check, ChevronDown, Languages, Loader2, NotebookPen, Save } from 'lucide-react';
import { toast } from 'sonner';
import type { Summary, SummaryDataResponse, Transcript } from '@/types';
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
import FinishedMeetingActions from './FinishedMeetingActions';
import FinishedMeetingSummary from './FinishedMeetingSummary';
import { getFinishedSummaryProgressLabel, getFinishedSummaryViewState, rememberStructuredActionPresence } from '@/lib/finished-meeting-state';
import { readMeetingSummaryLanguage, saveMeetingSummaryLanguage, type SummaryLanguageStorage } from '@/lib/summary-language-preferences';

type Status = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
interface SummaryPanelProps {
  meeting: { id: string; title: string; created_at: string };
  meetingTitle: string;
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
  onCustomPromptChange: (value: string) => void;
  onSaveSummary: (summary: Summary | { markdown?: string; summary_json?: any[] }) => Promise<void>;
  onSummaryChange: (summary: Summary) => void;
  onDirtyChange: (dirty: boolean) => void;
  summaryError: string | null;
  availableTemplates: Array<{ id: string; name: string; description: string }>;
  selectedTemplate: string;
  onTemplateSelect: (id: string, name: string) => void;
  isModelConfigLoading?: boolean;
  onOpenModelSettings?: (open: () => void) => void;
  notesOpen: boolean;
  onToggleNotes: () => void;
}

export function SummaryPanel(props: SummaryPanelProps) {
  const { meeting, aiSummary, summaryStatus, summaryError, transcripts, modelConfig, summaryRef } = props;
  const { onDirtyChange, onSaveAll, onSummaryChange, isSaving } = props;
  const { isAutoSummary, toggleIsAutoSummary } = useConfig();
  const [summaryLanguage, setSummaryLanguage] = useState<string | null>(null);
  const [languageStorage, setLanguageStorage] = useState<SummaryLanguageStorage>('metadata');
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<MeetingExportFormat | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<MeetingExportFormat>('markdown');
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [legacyDirty, setLegacyDirty] = useState(false);
  const [autoSaveAttempted, setAutoSaveAttempted] = useState(false);
  const [autoSaveFailed, setAutoSaveFailed] = useState(false);
  const [hasStructuredActions, setHasStructuredActions] = useState(false);
  const [moreHasOpened, setMoreHasOpened] = useState(false);
  const languageLoadVersion = useRef(0);
  const activeMeetingId = useRef(meeting.id);
  activeMeetingId.current = meeting.id;
  const saveRunning = useRef(false);
  const pendingLanguage = useRef<{ meetingId: string; version: number; language: string | null; rollback: { language: string | null; storage: SummaryLanguageStorage } } | null>(null);
  const languageVersion = useRef(0);
  const { addRecent } = useRecentLanguages();

  const hasSummary = Boolean(parseSummaryData(aiSummary));
  const generationActive = ['processing', 'summarizing', 'regenerating'].includes(summaryStatus);
  const summaryDirty = editorDirty || legacyDirty;
  const viewState = getFinishedSummaryViewState({ hasSummary, hasTranscript: transcripts.length > 0, status: summaryStatus });
  const providerLabel = modelConfig.provider === 'openai-codex' ? 'Connected ChatGPT'
    : modelConfig.provider === 'apple-intelligence' ? 'Apple Intelligence'
      : modelConfig.provider === 'ollama' ? 'Ollama' : modelConfig.provider;
  const providerDetail = `${providerLabel}${modelConfig.model ? ` · ${modelConfig.model}` : ''}${modelConfig.provider === 'apple-intelligence' || modelConfig.provider === 'ollama' ? ' · on this Mac' : ''}`;

  const handleEditorDirtyChange = useCallback((dirty: boolean) => {
    setEditorDirty(dirty);
    onDirtyChange(dirty);
    if (!dirty) setAutoSaveAttempted(false);
  }, [onDirtyChange]);
  const handleSummaryChange = useCallback((summary: Summary) => {
    setLegacyDirty(true);
    setAutoSaveAttempted(false);
    setAutoSaveFailed(false);
    onSummaryChange(summary);
  }, [onSummaryChange]);
  const handlePersistedActionsChange = useCallback((actions: unknown[]) => {
    setHasStructuredActions(previous => rememberStructuredActionPresence(previous, actions));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const version = ++languageLoadVersion.current;
    void readMeetingSummaryLanguage(meeting.id).then(stored => {
      if (!cancelled && version === languageLoadVersion.current) {
        setSummaryLanguage(stored.language);
        setLanguageStorage(stored.storage);
      }
    }).catch(() => { if (!cancelled) toast.warning('Could not load saved summary language'); });
    return () => { cancelled = true; };
  }, [meeting.id]);

  const persistLanguage = useCallback(async () => {
    if (saveRunning.current) return;
    saveRunning.current = true;
    try {
      while (pendingLanguage.current) {
        const request = pendingLanguage.current;
        try {
          const saved = await saveMeetingSummaryLanguage(request.meetingId, request.language);
          if (pendingLanguage.current?.version === request.version && activeMeetingId.current === request.meetingId) {
            setSummaryLanguage(saved.language);
            setLanguageStorage(saved.storage);
            if (request.language) addRecent(request.language);
          }
        } catch {
          if (pendingLanguage.current?.version === request.version && activeMeetingId.current === request.meetingId) {
            setSummaryLanguage(request.rollback.language);
            setLanguageStorage(request.rollback.storage);
            toast.error('Failed to save summary language');
          }
        }
        if (pendingLanguage.current?.version === request.version) pendingLanguage.current = null;
      }
    } finally { saveRunning.current = false; }
  }, [addRecent]);

  const changeLanguage = (language: string | null) => {
    ++languageLoadVersion.current;
    pendingLanguage.current = { version: ++languageVersion.current, meetingId: meeting.id, language, rollback: { language: summaryLanguage, storage: languageStorage } };
    setSummaryLanguage(language);
    setLanguagePickerOpen(false);
    void persistLanguage();
  };

  const generate = async (prompt = props.customPrompt) => {
    const before = new CustomEvent('meetodds:before-summary-generation', { cancelable: true, detail: { meetingId: meeting.id } });
    if (!window.dispatchEvent(before)) {
      toast.info('Save or cancel action edits before retrying the summary.');
      return;
    }
    if (saveRunning.current) {
      toast.info('Wait for the summary language to save, then retry.');
      return;
    }
    try {
      if (hasSummary) {
        await onSaveAll();
        setIsEditingSummary(false);
        setEditorDirty(false);
        setLegacyDirty(false);
      }
      try { localStorage.setItem(AUTO_SUMMARY_CHOICE_KEY, 'chosen'); } catch { /* Generation remains available when local storage is blocked. */ }
      await props.onGenerateSummary(prompt);
    } catch {
      toast.error('Could not prepare the summary. Save your edits and retry.');
    }
  };

  const exportSummary = async (format: MeetingExportFormat) => {
    if (exportingFormat) return;
    setExportingFormat(format);
    try {
      await onSaveAll();
      setExportFormat(format);
      setExportOpen(true);
    } catch { toast.error('Save your summary edits before exporting'); }
    finally { setExportingFormat(null); }
  };

  const languageSlot = <Popover open={languagePickerOpen} onOpenChange={setLanguagePickerOpen}>
    <PopoverTrigger asChild><Button type="button" variant="outline" disabled={generationActive} className="h-9 rounded-lg text-xs" aria-label="Set summary language"><Languages size={14} />{summaryLanguage ? labelForCode(summaryLanguage) : 'Auto language'}<ChevronDown size={12} /></Button></PopoverTrigger>
    <PopoverContent align="end" className="w-auto border-0 bg-transparent p-0 shadow-none"><LanguagePickerPopover value={summaryLanguage} onChange={changeLanguage} onClose={() => setLanguagePickerOpen(false)} autoSubtitle={languageStorage === 'local_fallback' ? 'Saved on this device' : 'Uses dominant transcript language'} /></PopoverContent>
  </Popover>;

  const advancedGenerationControls = <SummaryGeneratorButtonGroup
    modelConfig={props.modelConfig} setModelConfig={props.setModelConfig} onSaveModelConfig={props.onSaveModelConfig}
    onGenerateSummary={generate} onStopGeneration={props.onStopGeneration} customPrompt={props.customPrompt}
    summaryStatus={summaryStatus} availableTemplates={props.availableTemplates} selectedTemplate={props.selectedTemplate}
    onTemplateSelect={props.onTemplateSelect} hasTranscripts={transcripts.length > 0} hasSummary={hasSummary}
    isModelConfigLoading={props.isModelConfigLoading} onOpenModelSettings={props.onOpenModelSettings} languageSlot={languageSlot}
  />;

  useEffect(() => {
    if (!isEditingSummary || !hasSummary || !summaryDirty || autoSaveAttempted || isSaving || generationActive) return;
    const timer = window.setTimeout(() => {
      if (!summaryRef.current?.isDirty && !legacyDirty) return;
      setAutoSaveAttempted(true);
      setAutoSaveFailed(false);
      void onSaveAll().then(() => { setLegacyDirty(false); setAutoSaveAttempted(false); setAutoSaveFailed(false); }).catch(() => setAutoSaveFailed(true));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [autoSaveAttempted, generationActive, hasSummary, isEditingSummary, isSaving, legacyDirty, onSaveAll, summaryDirty, summaryRef]);

  const saveNow = async (): Promise<boolean> => {
    try {
      await onSaveAll();
      setEditorDirty(false);
      setLegacyDirty(false);
      setAutoSaveFailed(false);
      setAutoSaveAttempted(false);
      return true;
    } catch { setAutoSaveFailed(true); return false; }
  };

  const toggleSummaryEditing = async () => {
    if (!isEditingSummary) { setIsEditingSummary(true); return; }
    if (summaryDirty && !await saveNow()) return;
    setIsEditingSummary(false);
  };

  const controlsDisabled = props.isModelConfigLoading || generationActive || !transcripts.length;
  const shouldOfferGenerate = !hasSummary && transcripts.length > 0;
  const needsApproval = Boolean(summaryError && /approve|choose generate summary/i.test(summaryError));
  const primaryGenerationLabel = viewState === 'failed' && !needsApproval ? 'Retry summary' : 'Generate summary';

  return <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg">
    <ExportSheet meetingId={meeting.id} open={exportOpen} onOpenChange={setExportOpen} initialFormat={exportFormat} />
    <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-6 pb-8 pt-5">
      <div className="mx-auto w-full max-w-[900px]">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-text">Summary</h2>
            <p className="mt-1 text-xs text-3">{hasSummary ? 'AI-generated' : 'A readable recap of the saved conversation'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <button type="button" aria-pressed={props.notesOpen} aria-expanded={props.notesOpen} onClick={props.onToggleNotes} className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs ${props.notesOpen ? 'bg-panel-2 text-text' : 'text-3 hover:bg-panel-2 hover:text-text'}`}><NotebookPen size={14} /> Notes</button>
            {hasSummary && !generationActive && <button type="button" aria-pressed={isEditingSummary} disabled={isSaving} onClick={() => void toggleSummaryEditing()} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-3 hover:bg-panel-2 hover:text-text disabled:opacity-50">{isEditingSummary ? 'Done' : 'Edit summary'}</button>}
            {isEditingSummary && summaryDirty && <Button type="button" size="sm" variant="outline" disabled={isSaving} onClick={() => void saveNow()} className="h-8 gap-1.5 px-2.5 text-xs">{isSaving ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" /> : <Save size={13} />}{isSaving ? 'Saving' : 'Save'}</Button>}
          </div>
        </header>

        {generationActive && <div role="status" aria-live="polite" className="mt-4 flex items-center gap-3 text-xs text-2"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" /><span>{getFinishedSummaryProgressLabel(summaryStatus)}</span><progress aria-label="AI summary generation" className="h-1 w-28 accent-[var(--accent)]" /></div>}
        {summaryError && <div role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-xs leading-5 text-danger"><p>{summaryError}</p>{hasSummary && summaryStatus === 'error' && transcripts.length > 0 && <button type="button" onClick={() => void generate()} className="mt-1 font-medium underline underline-offset-2">Retry summary</button>}</div>}

        {!hasSummary && viewState !== 'generating' && <section className="mt-6" aria-labelledby="summary-empty-title">
          <h3 id="summary-empty-title" className="text-base font-medium text-text">{viewState === 'empty' ? 'No saved speech yet' : viewState === 'failed' ? 'Summary needs attention' : 'Your transcript is saved'}</h3>
          <p className="mt-1 max-w-[56ch] text-sm leading-6 text-2">{viewState === 'empty' ? 'There is no transcript to summarize. Your notes and recording remain available.' : viewState === 'failed' ? 'Your saved transcript is still here. Retry the summary when the selected AI is available.' : 'Generate a summary when you are ready. Your saved transcript remains visible beside it.'}</p>
          {shouldOfferGenerate && <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="button" disabled={controlsDisabled} onClick={() => void generate()} className="h-9 rounded-lg px-3.5 text-xs font-medium">{primaryGenerationLabel}</Button>
          </div>}
        </section>}

        {hasSummary && <div className="mt-5" aria-busy={generationActive}>
          {isEditingSummary ? <div className="rounded-lg border border-border bg-surface px-4 py-3">
            <p className="mb-3 text-xs text-3">Editing the saved AI summary, including its original action section.</p>
            <BlockNoteSummaryView key={meeting.id} ref={summaryRef} summaryData={aiSummary as SummaryDataResponse | Summary} onSave={props.onSaveSummary} onSummaryChange={handleSummaryChange} onDirtyChange={handleEditorDirtyChange} status="completed" error={null} onRegenerateSummary={() => void generate(props.customPrompt)} meeting={{ id: meeting.id, title: props.meetingTitle, created_at: meeting.created_at }} />
          </div> : <FinishedMeetingSummary summary={aiSummary} summaryRef={summaryRef} hideGeneratedActions={hasStructuredActions} />}
          {!isEditingSummary && <FinishedMeetingActions meetingId={meeting.id} onPersistedActionsChange={handlePersistedActionsChange} />}
        </div>}

        {generationActive && !hasSummary && <div className="mt-5 flex items-center gap-2"><Button type="button" variant="outline" onClick={props.onStopGeneration} className="h-8 rounded-lg px-3 text-xs">Cancel summary</Button></div>}
        {isEditingSummary && <div role="status" aria-live="polite" className="mt-3 flex items-center gap-1.5 text-xs text-3">{isSaving ? <><Loader2 size={13} className="animate-spin motion-reduce:animate-none" />Saving edits…</> : autoSaveFailed ? 'Autosave failed. Your edits are still here; save again before exporting.' : summaryDirty ? 'Changes will save automatically.' : <><Check size={13} className="text-success" />Saved</>}</div>}

        <details className="mt-7 border-t border-border pt-3" onToggle={event => { if (event.currentTarget.open) setMoreHasOpened(true); }}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-2 text-xs font-medium text-3 hover:text-text"><span>More</span><ChevronDown size={14} /></summary>
          <div className="space-y-4 pb-3 pt-2">
            {hasSummary && <div className="flex flex-wrap items-center justify-between gap-3">
              <SummaryUpdaterButtonGroup isSaving={isSaving} isDirty={summaryDirty} onSave={async () => { await saveNow(); }} onCopy={props.onCopySummary} onOpenFolder={props.onOpenFolder} onExport={exportSummary} exportingFormat={exportingFormat} hasSummary />
            </div>}
            <div>
              <p className="mb-2 text-xs font-medium text-2">AI summary settings</p>
              {advancedGenerationControls}
              <p className="mt-2 text-[11px] text-3">Selected AI: {providerDetail}</p>
            </div>
            <label className="block border-t border-border pt-3 text-xs text-2">Additional context for the next summary<textarea value={props.customPrompt} onChange={event => props.onCustomPromptChange(event.target.value)} placeholder="Add background or a focus for the summary…" className="mt-1 min-h-20 w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-xs leading-5 text-text outline-none focus:border-accent" /></label>
            {transcripts.length > 0 && <label className="flex cursor-pointer items-start gap-2.5 border-t border-border pt-3 text-xs text-2">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={isAutoSummary} onChange={event => { toggleIsAutoSummary(event.target.checked); try { localStorage.setItem(AUTO_SUMMARY_CHOICE_KEY, 'chosen'); } catch { /* Preference still belongs to the config store. */ } }} />
              <span><strong className="font-medium text-text">Generate summaries automatically after future meetings</strong><span className="mt-1 block leading-5 text-3">Your selected AI may ask once before a new provider receives a transcript. Audio is not sent.</span></span>
            </label>}
            {hasSummary && <p className="text-[11px] leading-5 text-3">The original summary stays unchanged in storage, editing, copy, and export. When structured action links are available, this reading view shows them as a checklist.</p>}
            {hasSummary && <details className="border-t border-border pt-3"><summary className="cursor-pointer text-xs font-medium text-3">Decisions, open questions, and meeting context</summary>{moreHasOpened && <div className="pt-3"><MeetingOutcomeWorkspace meetingId={meeting.id} showOutcomeAndActions={false} /></div>}</details>}
          </div>
        </details>
      </div>
    </div>
  </div>;
}
