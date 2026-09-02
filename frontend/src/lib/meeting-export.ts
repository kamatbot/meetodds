import { downloadDir, join } from '@tauri-apps/api/path';
import { exists, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { buildDocx, buildPdf } from './meeting-export-formats';

export type MeetingExportFormat = 'pdf' | 'docx' | 'markdown';

export interface MeetingExportInput {
  format: MeetingExportFormat;
  title: string;
  createdAt?: string;
  markdown: string;
}

export interface MeetingExportResult {
  format: MeetingExportFormat;
  filename: string;
  path: string | null;
  destination: 'Downloads' | 'Browser downloads';
  bytes: number;
}

const MIME_TYPES: Record<MeetingExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  markdown: 'text/markdown;charset=utf-8',
};

function sanitizeFilename(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');

  return (normalized || 'Meeting notes').slice(0, 110);
}

function formatDateForFilename(value?: string): string {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return [
    safeDate.getFullYear(),
    String(safeDate.getMonth() + 1).padStart(2, '0'),
    String(safeDate.getDate()).padStart(2, '0'),
  ].join('-');
}

function formatMeetingDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
}

function stripDuplicateLeadingTitle(markdown: string, title: string): string {
  const lines = markdown.trim().split(/\r?\n/);
  const first = lines[0]?.replace(/^#\s+/, '').trim().toLocaleLowerCase();
  if (first && first === title.trim().toLocaleLowerCase()) {
    lines.shift();
    while (lines[0]?.trim() === '') lines.shift();
  }
  return lines.join('\n').trim();
}

export function buildFormattedMarkdown(input: Omit<MeetingExportInput, 'format'>): string {
  const title = input.title.trim() || 'Meeting notes';
  const meetingDate = formatMeetingDate(input.createdAt);
  const content = stripDuplicateLeadingTitle(input.markdown, title);
  const metadata = meetingDate ? `\n\n**Meeting date:** ${meetingDate}` : '';
  const body = content ? `\n\n---\n\n${content}` : '';
  return `# ${title}${metadata}${body}\n`;
}

function extensionFor(format: MeetingExportFormat): string {
  return format === 'markdown' ? 'md' : format;
}

async function nextAvailablePath(directory: string, filename: string): Promise<{ path: string; filename: string }> {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';

  for (let index = 0; index < 1000; index += 1) {
    const candidateName = index === 0 ? filename : `${base} (${index})${extension}`;
    const candidatePath = await join(directory, candidateName);
    if (!(await exists(candidatePath))) return { path: candidatePath, filename: candidateName };
  }

  throw new Error('Could not find an available export filename in Downloads.');
}

function triggerBrowserDownload(filename: string, data: string | Uint8Array, mimeType: string): void {
  if (typeof document === 'undefined') {
    throw new Error('File export requires a desktop or browser environment.');
  }

  let blobPart: BlobPart;
  if (typeof data === 'string') {
    blobPart = data;
  } else {
    // TypeScript 5.9 preserves ArrayBufferLike on Uint8Array, which can include
    // SharedArrayBuffer. Copy into a fresh ArrayBuffer-backed view for Blob.
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    blobPart = copy.buffer;
  }

  const blob = new Blob([blobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportMeetingSummary(input: MeetingExportInput): Promise<MeetingExportResult> {
  const title = input.title.trim() || 'Meeting notes';
  const markdown = buildFormattedMarkdown({
    title,
    createdAt: input.createdAt,
    markdown: input.markdown,
  });
  const filename = `${sanitizeFilename(title)} - ${formatDateForFilename(input.createdAt)}.${extensionFor(input.format)}`;

  const data: string | Uint8Array = input.format === 'markdown'
    ? markdown
    : input.format === 'docx'
      ? buildDocx(markdown, { title, createdAt: input.createdAt })
      : buildPdf(markdown, { title, createdAt: input.createdAt });
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data).length : data.length;

  try {
    const directory = await downloadDir();
    const target = await nextAvailablePath(directory, filename);
    if (typeof data === 'string') {
      await writeTextFile(target.path, data);
    } else {
      await writeFile(target.path, data);
    }

    return {
      format: input.format,
      filename: target.filename,
      path: target.path,
      destination: 'Downloads',
      bytes,
    };
  } catch (desktopError) {
    console.warn('Desktop export was unavailable; falling back to browser download.', desktopError);
    triggerBrowserDownload(filename, data, MIME_TYPES[input.format]);
    return {
      format: input.format,
      filename,
      path: null,
      destination: 'Browser downloads',
      bytes,
    };
  }
}
