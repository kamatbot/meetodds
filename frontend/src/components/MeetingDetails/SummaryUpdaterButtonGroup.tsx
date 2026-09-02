"use client";

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Copy, Save, Loader2, FileDown, ChevronDown, FileText, FileType2 } from 'lucide-react';
import Analytics from '@/lib/analytics';
import type { MeetingExportFormat } from '@/lib/meeting-export';

interface SummaryUpdaterButtonGroupProps {
  isSaving: boolean;
  isDirty: boolean;
  onSave: () => Promise<void>;
  onCopy: () => Promise<void>;
  onFind?: () => void;
  onOpenFolder: () => Promise<void>;
  onExport: (format: MeetingExportFormat) => Promise<void>;
  exportingFormat?: MeetingExportFormat | null;
  hasSummary: boolean;
}

const EXPORT_OPTIONS: Array<{
  format: MeetingExportFormat;
  label: string;
  description: string;
  icon: typeof FileText;
}> = [
  {
    format: 'pdf',
    label: 'PDF document',
    description: 'Paginated A4 report with headings, lists, and tables',
    icon: FileText,
  },
  {
    format: 'docx',
    label: 'Word document',
    description: 'Editable .docx with document styles and formatted tables',
    icon: FileType2,
  },
  {
    format: 'markdown',
    label: 'Markdown',
    description: 'Portable .md source with meeting metadata',
    icon: FileDown,
  },
];

export function SummaryUpdaterButtonGroup({
  isSaving,
  isDirty,
  onSave,
  onCopy,
  onExport,
  exportingFormat = null,
  hasSummary,
}: SummaryUpdaterButtonGroupProps) {
  const isExporting = exportingFormat !== null;

  const handleExport = (format: MeetingExportFormat) => {
    Analytics.trackButtonClick(`export_summary_${format}`, 'meeting_details');
    void onExport(format);
  };

  return (
    <ButtonGroup>
      <Button
        variant="outline"
        size="sm"
        className={isDirty ? 'bg-green-200' : ''}
        title={isSaving ? 'Saving' : 'Save Changes'}
        onClick={() => {
          Analytics.trackButtonClick('save_changes', 'meeting_details');
          void onSave();
        }}
        disabled={isSaving}
      >
        {isSaving ? (
          <>
            <Loader2 className="animate-spin" />
            <span className="hidden lg:inline">Saving...</span>
          </>
        ) : (
          <>
            <Save />
            <span className="hidden lg:inline">Save</span>
          </>
        )}
      </Button>

      <Button
        variant="outline"
        size="sm"
        title="Copy Summary"
        onClick={() => {
          Analytics.trackButtonClick('copy_summary', 'meeting_details');
          void onCopy();
        }}
        disabled={!hasSummary}
        className="cursor-pointer"
      >
        <Copy />
        <span className="hidden lg:inline">Copy</span>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            title="Export formatted summary"
            disabled={!hasSummary || isExporting}
            className="cursor-pointer"
          >
            {isExporting ? <Loader2 className="animate-spin" /> : <FileDown />}
            <span className="hidden lg:inline">
              {isExporting ? `Exporting ${exportingFormat?.toUpperCase()}...` : 'Export'}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          {EXPORT_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <DropdownMenuItem
                key={option.format}
                onSelect={() => handleExport(option.format)}
                disabled={isExporting}
                className="items-start gap-3 py-3"
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium">{option.label}</div>
                  <div className="mt-0.5 text-xs leading-4 text-muted-foreground">
                    {option.description}
                  </div>
                </div>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
