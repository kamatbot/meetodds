'use client';

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bold, Italic, Heading2, List, ListChecks, Quote, Code2 } from 'lucide-react';

export interface MarkdownNoteEditorHandle {
  focusAndScrollEnd: () => void;
}

export function NoteMarkdown({ content }: { content: string }) {
  return <div className="prose max-w-none break-words text-sm leading-relaxed text-text prose-headings:font-semibold prose-headings:text-text prose-p:my-2 prose-a:text-accent prose-blockquote:border-accent prose-blockquote:text-2 prose-code:text-text prose-pre:bg-bg prose-pre:text-text prose-th:text-text prose-td:text-text">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      h1: ({ children }) => <h2 className="mb-3 mt-5 text-xl font-semibold leading-snug">{children}</h2>,
      h2: ({ children }) => <h2 className="mb-2.5 mt-4 text-lg font-semibold leading-snug">{children}</h2>,
      h3: ({ children }) => <h3 className="mb-2 mt-3.5 text-base font-semibold">{children}</h3>,
      p: ({ children }) => <p className="my-2">{children}</p>,
      ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
      ol: ({ children, start }) => <ol start={start} className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
      blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-accent/40 pl-4 text-2">{children}</blockquote>,
      pre: ({ children }) => <pre className="my-3 overflow-x-auto rounded-lg bg-bg p-3 text-xs leading-5 text-text">{children}</pre>,
      table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-xs">{children}</table></div>,
      th: ({ children }) => <th className="border border-border bg-bg px-2.5 py-1.5 text-left font-semibold">{children}</th>,
      td: ({ children }) => <td className="border border-border px-2.5 py-1.5 align-top">{children}</td>,
      // Never load remote pixels merely because a private note is previewed.
      img: ({ alt }) => <span className="rounded border border-border px-2 py-1 text-xs text-2">Image not loaded{alt ? `: ${alt}` : ''}</span>,
      a: ({ href, children }) => <a href={href} rel="noreferrer noopener" onClick={event => {
        event.preventDefault();
        if (href && /^(https?:|mailto:)/i.test(href)) void invoke('open_external_url', { url: href }).catch(() => undefined);
      }}>{children}</a>,
    }}>{content}</Markdown>
  </div>;
}

const MarkdownNoteEditor = forwardRef<MarkdownNoteEditorHandle, {
  value: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  onSave: () => void;
  variant?: 'default' | 'live';
  placeholder?: string;
}>(function MarkdownNoteEditor({ value, onChange, readOnly, onSave, variant = 'default', placeholder }, ref) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const live = variant === 'live';

  useImperativeHandle(ref, () => ({
    focusAndScrollEnd: () => {
      setMode('write');
      requestAnimationFrame(() => {
        const editor = input.current;
        if (editor) {
          editor.focus();
          editor.selectionStart = editor.value.length;
          editor.selectionEnd = editor.value.length;
          editor.scrollTop = editor.scrollHeight;
        }
      });
    },
  }), []);
  const insert = (prefix: string, suffix = '', sample = 'text') => {
    const editor = input.current;
    if (!editor || readOnly) return;
    editor.focus();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const selection = value.slice(start, end) || sample;
    const text = prefix + selection + suffix;
    // Native insertion retains the macOS undo stack. setRangeText is the fallback.
    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      const next = value.slice(0, start) + text + value.slice(end);
      onChange(next);
    } else onChange(editor.value);
    requestAnimationFrame(() => editor.setSelectionRange(start + prefix.length, start + prefix.length + selection.length));
  };
  const tools = [
    { title: 'Heading', Icon: Heading2, run: () => insert('\n## ', '\n', 'Heading') },
    { title: 'Bold (⌘B)', Icon: Bold, run: () => insert('**', '**') },
    { title: 'Italic (⌘I)', Icon: Italic, run: () => insert('*', '*') },
    { title: 'Bulleted list', Icon: List, run: () => insert('\n- ', '', 'Item') },
    { title: 'Checklist', Icon: ListChecks, run: () => insert('\n- [ ] ', '', 'Action') },
    { title: 'Quote', Icon: Quote, run: () => insert('\n> ', '', 'Quote') },
    { title: 'Code', Icon: Code2, run: () => insert('`', '`', 'code') },
  ];
  return <div className={`flex flex-1 flex-col ${live ? 'min-h-[460px]' : 'min-h-[360px]'}`}>
    <div className={`${live ? 'sticky top-0 z-10 -mx-2 mb-5 border-y border-border/70 bg-bg/95 px-2 py-2 backdrop-blur-sm' : 'mb-4 border-b border-border pb-2.5'} flex flex-wrap items-center gap-1`}>
      {tools.map(({ title, Icon, run }) => <button key={title} type="button" aria-label={title} title={title}
        disabled={readOnly || mode !== 'write'} onMouseDown={e => e.preventDefault()} onClick={run}
        className="inline-grid h-8 w-8 place-items-center rounded-md text-2 hover:bg-panel-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-30"><Icon className="h-4 w-4" /></button>)}
      <div className="ml-auto flex rounded-md bg-panel-2 p-0.5" role="group" aria-label="Markdown view">
        {(['write', 'preview'] as const).map(option => <button type="button" key={option} aria-pressed={mode === option}
          onClick={() => setMode(option)} className={`rounded px-2.5 py-1 text-xs font-medium ${mode === option ? 'bg-panel text-text shadow-sm' : 'text-2'}`}>
          {option === 'write' ? 'Write' : 'Preview'}</button>)}
      </div>
    </div>
    {mode === 'preview' ? <div className={`pb-12 ${live ? 'min-h-[420px] text-[15px]' : 'min-h-[300px]'}`} aria-label="Markdown preview">
      {value.trim() ? <NoteMarkdown content={value} /> : <p className="text-sm text-3">Your formatted note will appear here.</p>}
    </div> : <textarea ref={input} value={value} readOnly={readOnly} autoFocus spellCheck aria-label="Personal Markdown note"
      placeholder={placeholder || 'What stood out? Capture a thought, question, or next step…'}
      onChange={e => onChange(e.target.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || !(event.metaKey || event.ctrlKey)) return;
        const key = event.key.toLowerCase();
        if (key === 's') { event.preventDefault(); onSave(); }
        if (key === 'b') { event.preventDefault(); insert('**', '**'); }
        if (key === 'i') { event.preventDefault(); insert('*', '*'); }
        if (key === 'k') { event.preventDefault(); insert('[', '](https://)', 'link text'); }
      }}
      className={`${live ? 'min-h-[52vh] text-[15.5px] leading-[1.75] tracking-[-.005em]' : 'min-h-[45vh] text-sm leading-relaxed'} w-full flex-1 resize-y border-0 bg-transparent pb-12 font-normal text-text outline-none placeholder:text-3 read-only:opacity-60`} />}
    <p className="pb-4 pt-1 text-[10.5px] text-3">Markdown · ⌘B bold · ⌘I italic · ⌘K link · ⌘S save</p>
  </div>;
});

export default MarkdownNoteEditor;
