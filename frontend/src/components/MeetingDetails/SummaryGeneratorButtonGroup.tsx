'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ModelSettingsModal, type ModelConfig } from '@/components/ModelSettingsModal';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Check, FileText, Loader2, Settings, Sparkles, Square } from 'lucide-react';

interface SummaryGeneratorButtonGroupProps {
  languageSlot?: ReactNode;
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig | ((previous: ModelConfig) => ModelConfig)) => void;
  onSaveModelConfig: (config?: ModelConfig) => Promise<void>;
  onGenerateSummary: (customPrompt: string) => Promise<void>;
  onStopGeneration: () => void;
  customPrompt: string;
  summaryStatus: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
  availableTemplates: Array<{ id: string; name: string; description: string }>;
  selectedTemplate: string;
  onTemplateSelect: (templateId: string, templateName: string) => void;
  hasTranscripts?: boolean;
  hasSummary?: boolean;
  isModelConfigLoading?: boolean;
  onOpenModelSettings?: (open: () => void) => void;
}

/** One entry point for generation. Validation/review belongs to useSummaryGeneration, not a second model probe. */
export function SummaryGeneratorButtonGroup({
  modelConfig, setModelConfig, onSaveModelConfig, onGenerateSummary, onStopGeneration,
  customPrompt, summaryStatus, availableTemplates, selectedTemplate, onTemplateSelect,
  hasTranscripts = true, hasSummary = false, isModelConfigLoading = false,
  onOpenModelSettings, languageSlot,
}: SummaryGeneratorButtonGroupProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const working = ['processing', 'summarizing', 'regenerating'].includes(summaryStatus);
  useEffect(() => { onOpenModelSettings?.(() => setSettingsOpen(true)); }, [onOpenModelSettings]);
  const generate = async () => {
    if (submitting || working || isModelConfigLoading || !hasTranscripts) return;
    setSubmitting(true);
    try { await onGenerateSummary(customPrompt); } finally { setSubmitting(false); }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {working ? (
        <Button type="button" variant="outline" onClick={onStopGeneration} aria-label="Cancel summary and action generation"><Square size={14} /> Cancel generation</Button>
      ) : (
        <Button type="button" variant={hasSummary ? 'outline' : 'default'} className={hasSummary ? '' : 'h-11 rounded-xl px-5 text-sm font-semibold'}
          onClick={() => void generate()} disabled={submitting || isModelConfigLoading || !hasTranscripts}>
          {submitting || isModelConfigLoading ? <Loader2 size={17} className="animate-spin motion-reduce:animate-none" /> : <Sparkles size={17} />}
          {isModelConfigLoading ? 'Loading AI settings…' : hasSummary ? 'Regenerate' : summaryStatus === 'error' ? 'Retry summary & actions' : 'Generate AI summary & actions'}
        </Button>
      )}
      {languageSlot}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogTrigger asChild><Button type="button" variant="outline" disabled={working} aria-label="Choose AI model"><Settings size={16} /> AI model</Button></DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Choose your summary model</DialogTitle>
          <ModelSettingsModal modelConfig={modelConfig} setModelConfig={setModelConfig} skipInitialFetch layout="dialog"
            onSave={async config => { await onSaveModelConfig(config); setSettingsOpen(false); }} />
        </DialogContent>
      </Dialog>
      {availableTemplates.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" variant="outline" disabled={working} aria-label="Choose summary template"><FileText size={16} /> Template</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {availableTemplates.map(template => <DropdownMenuItem key={template.id} title={template.description}
              onClick={() => onTemplateSelect(template.id, template.name)} className="flex items-center justify-between gap-3">
              {template.name}{template.id === selectedTemplate && <Check size={14} />}
            </DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
