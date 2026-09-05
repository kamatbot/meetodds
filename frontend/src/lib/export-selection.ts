import type { MeetingExportInfo, MeetingExportSelection, MeetingExportFormat } from '@/types/meeting';
export type ExportFormatChoice = MeetingExportFormat | 'pdf' | 'docx';
export function privateExportDefaults(info: Pick<MeetingExportInfo, 'hasSummary'>): MeetingExportSelection {
  return { includeSummary: info.hasSummary, includeNotes: false, includeTranscript: false };
}
export function selectionKey(meetingId: string, selection: MeetingExportSelection): string {
  return JSON.stringify([meetingId, selection.includeSummary, selection.includeNotes, selection.includeTranscript]);
}
export function canExportSrt(hasTiming: boolean, selection: MeetingExportSelection): boolean {
  return hasTiming && selection.includeTranscript && !selection.includeNotes && !selection.includeSummary;
}
export function selectedSectionCount(selection: MeetingExportSelection): number {
  return Number(selection.includeSummary) + Number(selection.includeNotes) + Number(selection.includeTranscript);
}
export function isFormattedDocument(format: ExportFormatChoice): format is 'pdf' | 'docx' {
  return format === 'pdf' || format === 'docx';
}
export interface ExportSteps {
  text?: () => Promise<{ cancelled: boolean; label?: string | null }>;
  audio?: () => Promise<{ cancelled: boolean; label?: string | null }>;
}
/** Cancel applies to the whole pending operation; partial success is never lost in a catch. */
export async function runExportSteps(steps: ExportSteps): Promise<{ saved: string[]; cancelled: boolean; failed: boolean }> {
  const saved: string[] = [];
  try {
    for (const step of [steps.text, steps.audio]) {
      if (!step) continue;
      const result = await step();
      if (result.cancelled) return { saved, cancelled: true, failed: false };
      if (result.label) saved.push(result.label);
    }
    return { saved, cancelled: false, failed: false };
  } catch { return { saved, cancelled: false, failed: true }; }
}
