'use client';

import type { Block, PartialBlock } from '@blocknote/core';
import { useEffect, useImperativeHandle, useMemo, useState, type RefObject } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { BlockNoteBlock, Summary } from '@/types';
import type { BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import { blocksToMarkdownSafely } from '@/lib/blocknote-markdown';
import {
  blockNoteInitialContentForDisplay,
  legacySummaryForDisplay,
  markdownWithoutGeneratedActionsForDisplay,
  summaryWithoutGeneratedActionsForDisplay,
  type SummaryRecord,
} from '@/lib/finished-summary-projection';

function ReadOnlyBlockNote({ blocks, originalBlocks, summaryRef }: { blocks: BlockNoteBlock[]; originalBlocks: BlockNoteBlock[]; summaryRef?: RefObject<BlockNoteSummaryViewRef> }) {
  const copiedBlocks = useMemo(() => JSON.parse(JSON.stringify(blocks)) as BlockNoteBlock[], [blocks]);
  const copiedOriginalBlocks = useMemo(() => JSON.parse(JSON.stringify(originalBlocks)) as BlockNoteBlock[], [originalBlocks]);
  const initialContent = useMemo(() => blockNoteInitialContentForDisplay(copiedBlocks) as PartialBlock[], [copiedBlocks]);
  const editor = useCreateBlockNote({ initialContent: initialContent as Block[] });
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const root = document.documentElement;
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = () => {
      const explicitTheme = root.getAttribute('data-theme');
      setTheme(explicitTheme === 'light' || explicitTheme === 'dark' ? explicitTheme : systemTheme.matches ? 'dark' : 'light');
    };
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    systemTheme.addEventListener('change', updateTheme);
    return () => {
      observer.disconnect();
      systemTheme.removeEventListener('change', updateTheme);
    };
  }, []);

  useImperativeHandle(summaryRef, () => ({
    saveSummary: async () => undefined,
    getMarkdown: async () => {
      const converted = await blocksToMarkdownSafely(editor, copiedOriginalBlocks as Block[], { source: 'FinishedMeetingSummary.getMarkdown' });
      return converted.markdown || '';
    },
    isDirty: false,
  }), [copiedOriginalBlocks, editor]);
  if (!blocks.length) return null;
  return <BlockNoteView editor={editor} editable={false} theme={theme} />;
}

export default function FinishedMeetingSummary({ summary, hideGeneratedActions, summaryRef }: { summary: Summary | null; hideGeneratedActions: boolean; summaryRef: RefObject<BlockNoteSummaryViewRef> }) {
  const record = summary as SummaryRecord | null;
  const markdown = typeof record?.markdown === 'string' ? record.markdown : null;
  const blocknote = Array.isArray(record?.summary_json) ? record.summary_json as BlockNoteBlock[] : null;
  const projectedBlocknote = useMemo(() => blocknote && hideGeneratedActions ? summaryWithoutGeneratedActionsForDisplay(blocknote) : blocknote, [blocknote, hideGeneratedActions]);
  const blocknoteKey = useMemo(() => blocknote ? JSON.stringify(blocknote) : '', [blocknote]);
  const legacy = record && !markdown && !blocknote ? legacySummaryForDisplay(record, hideGeneratedActions) : '';

  // Match the editor's format detection: persisted BlockNote is canonical when
  // both representations exist, while its display projection stays read-only.
  if (projectedBlocknote && blocknote) return <ReadOnlyBlockNote key={`${hideGeneratedActions ? 'actions-in-list' : 'actions-in-summary'}:${blocknoteKey}`} blocks={projectedBlocknote} originalBlocks={blocknote} summaryRef={summaryRef} />;
  if (markdown) {
    return <div className="prose prose-sm max-w-none text-text prose-headings:font-semibold prose-headings:tracking-tight prose-p:leading-7 prose-li:leading-7 prose-a:text-accent prose-strong:text-text">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{hideGeneratedActions ? markdownWithoutGeneratedActionsForDisplay(markdown) : markdown}</ReactMarkdown>
    </div>;
  }
  if (legacy) {
    return <div className="space-y-6">
      <div className="prose prose-sm max-w-none text-text prose-headings:font-semibold prose-headings:tracking-tight prose-p:leading-7 prose-li:leading-7 prose-a:text-accent prose-strong:text-text">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{legacy}</ReactMarkdown>
      </div>
    </div>;
  }
  return null;
}
