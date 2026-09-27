import type { BlockNoteBlock, SummaryDataResponse } from '@/types';

export type SummaryRecord = SummaryDataResponse & Record<string, unknown>;
const SECTION_MARKER = /^\s*<!--\s*meetodds:(outcome|decisions|actions|questions|end)\s*-->\s*$/i;

function textOfBlock(block: BlockNoteBlock): string {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';
  return block.content.map(item => {
    if (!item || typeof item !== 'object') return '';
    const value = item as { text?: unknown };
    return typeof value.text === 'string' ? value.text : '';
  }).join('');
}

/** Display-only projection; callers must keep the original summary for editing and export. */
export function summaryWithoutGeneratedActionsForDisplay(blocks: BlockNoteBlock[]): BlockNoteBlock[] {
  const result: BlockNoteBlock[] = [];
  let omittedByActionMarker = false;

  for (const block of blocks) {
    const marker = SECTION_MARKER.exec(textOfBlock(block));
    if (marker) {
      if (marker[1].toLowerCase() === 'actions') omittedByActionMarker = true;
      else if (omittedByActionMarker && ['questions', 'end'].includes(marker[1].toLowerCase())) omittedByActionMarker = false;
      continue;
    }
    if (!omittedByActionMarker) result.push(block);
  }
  return result;
}

/** BlockNote requires at least one initial block; use a local placeholder for a display-only empty projection. */
export function blockNoteInitialContentForDisplay(blocks: BlockNoteBlock[]): BlockNoteBlock[] {
  return blocks.length ? blocks : [{ id: 'finished-summary-empty-projection', type: 'paragraph', content: [] }];
}

/** Removes the explicitly marked generated action section from the reading view only. */
export function markdownWithoutGeneratedActionsForDisplay(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const result: string[] = [];
  let omittedByActionMarker = false;

  for (const line of lines) {
    const marker = SECTION_MARKER.exec(line);
    if (marker) {
      if (marker[1].toLowerCase() === 'actions') omittedByActionMarker = true;
      else if (omittedByActionMarker && ['questions', 'end'].includes(marker[1].toLowerCase())) omittedByActionMarker = false;
      continue;
    }
    if (!omittedByActionMarker) result.push(line);
  }
  return result.join('\n').trim();
}

export function legacySummaryForDisplay(summary: SummaryRecord, hideGeneratedActions = true): string {
  const orderedKeys = Array.isArray(summary._section_order)
    ? summary._section_order.filter((key): key is string => typeof key === 'string')
    : Object.keys(summary);
  const sections = orderedKeys.flatMap(key => {
    const normalizedKey = key.replace(/[_\s-]/g, '').toLowerCase();
    if (key === 'MeetingName' || key === '_section_order' || (hideGeneratedActions && normalizedKey === 'actionitems')) return [];
    const section = summary[key] as { title?: unknown; blocks?: unknown } | undefined;
    if (!section || !Array.isArray(section.blocks)) return [];
    const title = typeof section.title === 'string' ? section.title : key;
    const content = section.blocks.map((block: { content?: unknown }) => typeof block?.content === 'string' ? block.content : '').filter(Boolean).join('\n\n');
    return content ? [`## ${title}\n\n${content}`] : [];
  });
  return sections.join('\n\n');
}
