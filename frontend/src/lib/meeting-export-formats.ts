export interface ExportDocumentMetadata {
  title: string;
  createdAt?: string;
}

interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

interface HeadingBlock {
  kind: 'heading';
  level: number;
  runs: InlineRun[];
}

interface ParagraphBlock {
  kind: 'paragraph';
  runs: InlineRun[];
}

interface ListItemBlock {
  kind: 'list-item';
  ordered: boolean;
  index?: number;
  depth: number;
  runs: InlineRun[];
}

interface QuoteBlock {
  kind: 'quote';
  runs: InlineRun[];
}

interface CodeBlock {
  kind: 'code';
  text: string;
}

interface DividerBlock {
  kind: 'divider';
}

interface TableBlock {
  kind: 'table';
  rows: InlineRun[][][];
}

type MarkdownBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListItemBlock
  | QuoteBlock
  | CodeBlock
  | DividerBlock
  | TableBlock;

const textEncoder = new TextEncoder();

function normalizeInlineText(text: string): string {
  return text
    .replace(/\\([\\`*_[\]{}()#+\-.!>|])/g, '$1')
    .replace(/<br\s*\/?\s*>/gi, '\n');
}

function pushRun(runs: InlineRun[], run: InlineRun): void {
  if (!run.text) return;
  const previous = runs[runs.length - 1];
  if (
    previous &&
    previous.bold === run.bold &&
    previous.italic === run.italic &&
    previous.code === run.code
  ) {
    previous.text += run.text;
    return;
  }
  runs.push(run);
}

function parseInline(input: string): InlineRun[] {
  const text = normalizeInlineText(input);
  const runs: InlineRun[] = [];
  const tokenPattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > cursor) {
      pushRun(runs, { text: text.slice(cursor, match.index) });
    }

    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      pushRun(runs, { text: token.slice(2, -2), bold: true });
    } else if (token.startsWith('`')) {
      pushRun(runs, { text: token.slice(1, -1), code: true });
    } else if (token.startsWith('*') || token.startsWith('_')) {
      pushRun(runs, { text: token.slice(1, -1), italic: true });
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        pushRun(runs, { text: `${link[1]} (${link[2]})` });
      } else {
        pushRun(runs, { text: token });
      }
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) {
    pushRun(runs, { text: text.slice(cursor) });
  }

  return runs.length > 0 ? runs : [{ text }];
}

function runsToText(runs: InlineRun[]): string {
  return runs.map((run) => run.text).join('');
}

function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  const paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', runs: parseInline(paragraph.join(' ').trim()) });
    paragraph.length = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();

    if (/^```/.test(line.trim())) {
      flushParagraph();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        codeLines.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: 'code', text: codeLines.join('\n') });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const nextLine = lines[index + 1]?.trimEnd() ?? '';
    if (line.includes('|') && isTableDivider(nextLine)) {
      flushParagraph();
      const rows: InlineRun[][][] = [splitTableRow(line).map(parseInline)];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]).map(parseInline));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: 'table', rows });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        runs: parseInline(heading[2].replace(/\s+#+\s*$/, '')),
      });
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      flushParagraph();
      blocks.push({ kind: 'divider' });
      continue;
    }

    const unordered = rawLine.match(/^(\s*)[-+*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      blocks.push({
        kind: 'list-item',
        ordered: false,
        depth: Math.floor(unordered[1].replace(/\t/g, '  ').length / 2),
        runs: parseInline(unordered[2]),
      });
      continue;
    }

    const ordered = rawLine.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      blocks.push({
        kind: 'list-item',
        ordered: true,
        index: Number.parseInt(ordered[2], 10),
        depth: Math.floor(ordered[1].replace(/\t/g, '  ').length / 2),
        runs: parseInline(ordered[3]),
      });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: 'quote', runs: parseInline(quote[1]) });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function docxRun(run: InlineRun): string {
  const properties = [
    run.bold ? '<w:b/><w:bCs/>' : '',
    run.italic ? '<w:i/><w:iCs/>' : '',
    run.code
      ? '<w:rFonts w:ascii="Menlo" w:hAnsi="Menlo"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>'
      : '',
  ].join('');

  const textParts = run.text.split('\n');
  const body = textParts
    .map((part, index) => `${index > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEscape(part)}</w:t>`)
    .join('');

  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${body}</w:r>`;
}

function docxRuns(runs: InlineRun[]): string {
  return runs.map(docxRun).join('');
}

function docxParagraph(
  runs: InlineRun[],
  options: {
    style?: string;
    indent?: number;
    before?: number;
    after?: number;
    keepNext?: boolean;
  } = {},
): string {
  const properties = [
    options.style ? `<w:pStyle w:val="${options.style}"/>` : '',
    options.indent ? `<w:ind w:left="${options.indent}"/>` : '',
    options.before || options.after
      ? `<w:spacing w:before="${options.before ?? 0}" w:after="${options.after ?? 0}"/>`
      : '',
    options.keepNext ? '<w:keepNext/>' : '',
  ].join('');

  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${docxRuns(runs)}</w:p>`;
}

function docxTable(table: TableBlock): string {
  const columnCount = Math.max(1, ...table.rows.map((row) => row.length));
  const columnWidth = Math.floor(9000 / columnCount);
  const grid = Array.from({ length: columnCount }, () => `<w:gridCol w:w="${columnWidth}"/>`).join('');

  const rows = table.rows
    .map((row, rowIndex) => {
      const cells = Array.from({ length: columnCount }, (_, columnIndex) => row[columnIndex] ?? [{ text: '' }]);
      return `<w:tr>${cells
        .map((cell) => {
          const shading = rowIndex === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF7"/>' : '';
          const cellRuns = rowIndex === 0
            ? cell.map((run) => ({ ...run, bold: true }))
            : cell;
          return `<w:tc><w:tcPr><w:tcW w:w="${columnWidth}" w:type="dxa"/>${shading}<w:tcMar><w:top w:w="90" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tcMar></w:tcPr>${docxParagraph(cellRuns, { after: 0 })}</w:tc>`;
        })
        .join('')}</w:tr>`;
    })
    .join('');

  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}

function blocksToDocumentXml(blocks: MarkdownBlock[]): string {
  const body = blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading': {
          const style = block.level === 1 ? 'Title' : `Heading${Math.min(block.level - 1, 5)}`;
          return docxParagraph(block.runs, { style, before: block.level === 1 ? 0 : 260, after: 120, keepNext: true });
        }
        case 'paragraph':
          return docxParagraph(block.runs, { after: 140 });
        case 'list-item': {
          const marker = block.ordered ? `${block.index ?? 1}. ` : '• ';
          return docxParagraph([{ text: marker, bold: true }, ...block.runs], {
            indent: 360 + block.depth * 360,
            after: 70,
          });
        }
        case 'quote':
          return docxParagraph(block.runs.map((run) => ({ ...run, italic: true })), {
            style: 'Quote',
            indent: 420,
            after: 140,
          });
        case 'code':
          return docxParagraph([{ text: block.text, code: true }], { style: 'Code', after: 140 });
        case 'divider':
          return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="8" w:color="CBD5E1"/></w:pBdr><w:spacing w:before="140" w:after="180"/></w:pPr></w:p>';
        case 'table':
          return `${docxTable(block)}<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>`;
        default:
          return '';
      }
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 wp14">
  <w:body>
    ${body}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="540" w:footer="540" w:gutter="0"/>
      <w:cols w:space="708"/>
      <w:docGrid w:linePitch="360"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Aptos"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:color w:val="1F2937"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:after="220"/></w:pPr><w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display"/><w:b/><w:color w:val="172554"/><w:sz w:val="38"/><w:szCs w:val="38"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1D4ED8"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="1E3A8A"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="334155"/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:i/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="420"/><w:pBdr><w:left w:val="single" w:sz="14" w:space="12" w:color="60A5FA"/></w:pBdr></w:pPr><w:rPr><w:i/><w:color w:val="475569"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/><w:ind w:left="240" w:right="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:uiPriority w:val="59"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

function littleEndian16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function littleEndian32(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) !== 0 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    crcTable[value] = current >>> 0;
  }
  return crcTable;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function createStoredZip(entries: ZipEntry[], timestamp = new Date()): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const { date, time } = dosDateTime(timestamp);
  let localOffset = 0;

  for (const entry of entries) {
    const name = textEncoder.encode(entry.name);
    const checksum = crc32(entry.data);
    const localHeader = concatBytes([
      littleEndian32(0x04034b50),
      littleEndian16(20),
      littleEndian16(0x0800),
      littleEndian16(0),
      littleEndian16(time),
      littleEndian16(date),
      littleEndian32(checksum),
      littleEndian32(entry.data.length),
      littleEndian32(entry.data.length),
      littleEndian16(name.length),
      littleEndian16(0),
      name,
    ]);
    localParts.push(localHeader, entry.data);

    centralParts.push(
      concatBytes([
        littleEndian32(0x02014b50),
        littleEndian16(20),
        littleEndian16(20),
        littleEndian16(0x0800),
        littleEndian16(0),
        littleEndian16(time),
        littleEndian16(date),
        littleEndian32(checksum),
        littleEndian32(entry.data.length),
        littleEndian32(entry.data.length),
        littleEndian16(name.length),
        littleEndian16(0),
        littleEndian16(0),
        littleEndian16(0),
        littleEndian16(0),
        littleEndian32(0),
        littleEndian32(localOffset),
        name,
      ]),
    );

    localOffset += localHeader.length + entry.data.length;
  }

  const local = concatBytes(localParts);
  const central = concatBytes(centralParts);
  const end = concatBytes([
    littleEndian32(0x06054b50),
    littleEndian16(0),
    littleEndian16(0),
    littleEndian16(entries.length),
    littleEndian16(entries.length),
    littleEndian32(central.length),
    littleEndian32(local.length),
    littleEndian16(0),
  ]);

  return concatBytes([local, central, end]);
}

function validDate(value?: string): Date {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function buildDocx(markdown: string, metadata: ExportDocumentMetadata): Uint8Array {
  const blocks = parseMarkdown(markdown);
  const createdAt = validDate(metadata.createdAt);
  const createdIso = createdAt.toISOString();
  const documentXml = blocksToDocumentXml(blocks);

  const entries: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`),
    },
    {
      name: '_rels/.rels',
      data: textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`),
    },
    { name: 'word/document.xml', data: textEncoder.encode(documentXml) },
    { name: 'word/styles.xml', data: textEncoder.encode(DOCX_STYLES) },
    {
      name: 'word/_rels/document.xml.rels',
      data: textEncoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'),
    },
    {
      name: 'docProps/core.xml',
      data: textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(metadata.title)}</dc:title>
  <dc:creator>Notes</dc:creator>
  <cp:lastModifiedBy>Notes</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${createdIso}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${createdIso}</dcterms:modified>
</cp:coreProperties>`),
    },
    {
      name: 'docProps/app.xml',
      data: textEncoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Notes</Application><AppVersion>1.0</AppVersion></Properties>'),
    },
  ];

  return createStoredZip(entries, createdAt);
}

type PdfFont = 'F1' | 'F2' | 'F3' | 'F4';

interface PdfPage {
  commands: string[];
}

const PDF_WIDTH = 595.28;
const PDF_HEIGHT = 841.89;
const PDF_MARGIN = 54;
const PDF_BOTTOM = 48;

const WIN_ANSI: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  'ƒ': 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  'ˆ': 0x88,
  '‰': 0x89,
  'Š': 0x8a,
  '‹': 0x8b,
  'Œ': 0x8c,
  'Ž': 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  'š': 0x9a,
  '›': 0x9b,
  'œ': 0x9c,
  'ž': 0x9e,
  'Ÿ': 0x9f,
  '→': 0x2192,
};

function encodeWinAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text.normalize('NFC')) {
    const codePoint = character.codePointAt(0) ?? 0x3f;
    if (codePoint <= 0x7f || (codePoint >= 0xa0 && codePoint <= 0xff)) {
      bytes.push(codePoint);
    } else if (character === '→') {
      bytes.push(0x2d, 0x3e);
    } else {
      bytes.push(WIN_ANSI[character] ?? 0x3f);
    }
  }
  return bytes;
}

function pdfHex(text: string): string {
  return encodeWinAnsi(text)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function pdfText(text: string, x: number, y: number, size: number, font: PdfFont): string {
  return `BT /${font} ${size.toFixed(2)} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm <${pdfHex(text)}> Tj ET`;
}

function wrapText(text: string, maxWidth: number, size: number, mono = false): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [''];
  const averageWidth = size * (mono ? 0.6 : 0.51);
  const maxCharacters = Math.max(8, Math.floor(maxWidth / averageWidth));
  const words = normalized.split(' ');
  const lines: string[] = [];
  let current = '';

  const pushLongWord = (word: string): void => {
    let remainder = word;
    while (remainder.length > maxCharacters) {
      lines.push(remainder.slice(0, maxCharacters));
      remainder = remainder.slice(maxCharacters);
    }
    current = remainder;
  };

  for (const word of words) {
    if (!current) {
      if (word.length > maxCharacters) pushLongWord(word);
      else current = word;
      continue;
    }

    if (`${current} ${word}`.length <= maxCharacters) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      if (word.length > maxCharacters) pushLongWord(word);
      else current = word;
    }
  }

  if (current || lines.length === 0) lines.push(current);
  return lines;
}

class PdfLayout {
  readonly pages: PdfPage[] = [];
  private page: PdfPage;
  private y = PDF_HEIGHT - PDF_MARGIN;

  constructor() {
    this.page = this.newPage();
  }

  private newPage(): PdfPage {
    const page: PdfPage = { commands: [] };
    this.pages.push(page);
    this.page = page;
    this.y = PDF_HEIGHT - PDF_MARGIN;
    return page;
  }

  ensureSpace(height: number): void {
    if (this.y - height < PDF_BOTTOM) this.newPage();
  }

  addSpacing(points: number): void {
    this.ensureSpace(points);
    this.y -= points;
  }

  addRule(indent = 0): void {
    this.ensureSpace(16);
    const start = PDF_MARGIN + indent;
    this.page.commands.push(`0.78 G 0.7 w ${start.toFixed(2)} ${this.y.toFixed(2)} m ${(PDF_WIDTH - PDF_MARGIN).toFixed(2)} ${this.y.toFixed(2)} l S 0 G`);
    this.y -= 16;
  }

  addTextBlock(
    text: string,
    options: {
      size: number;
      font: PdfFont;
      indent?: number;
      before?: number;
      after?: number;
      lineHeight?: number;
      prefix?: string;
    },
  ): void {
    const indent = options.indent ?? 0;
    const before = options.before ?? 0;
    const after = options.after ?? 0;
    const lineHeight = options.lineHeight ?? options.size * 1.4;
    if (before) this.addSpacing(before);

    const prefix = options.prefix ?? '';
    const prefixWidth = prefix ? Math.max(18, prefix.length * options.size * 0.52) : 0;
    const available = PDF_WIDTH - PDF_MARGIN * 2 - indent - prefixWidth;
    const lines = wrapText(text, available, options.size, options.font === 'F4');
    this.ensureSpace(lines.length * lineHeight + after);

    lines.forEach((line, lineIndex) => {
      if (lineIndex === 0 && prefix) {
        this.page.commands.push(pdfText(prefix, PDF_MARGIN + indent, this.y, options.size, 'F2'));
      }
      this.page.commands.push(
        pdfText(line, PDF_MARGIN + indent + prefixWidth, this.y, options.size, options.font),
      );
      this.y -= lineHeight;
    });
    this.y -= after;
  }

  addQuote(text: string): void {
    const indent = 18;
    const size = 10;
    const lines = wrapText(text, PDF_WIDTH - PDF_MARGIN * 2 - indent - 12, size);
    const height = lines.length * 14 + 12;
    this.ensureSpace(height);
    const top = this.y + 3;
    const bottom = this.y - lines.length * 14 + 3;
    this.page.commands.push(`0.35 0.55 0.9 RG 2.2 w ${(PDF_MARGIN + 3).toFixed(2)} ${top.toFixed(2)} m ${(PDF_MARGIN + 3).toFixed(2)} ${bottom.toFixed(2)} l S 0 G`);
    for (const line of lines) {
      this.page.commands.push(pdfText(line, PDF_MARGIN + indent, this.y, size, 'F3'));
      this.y -= 14;
    }
    this.y -= 12;
  }

  addCode(text: string): void {
    const lines = text.split('\n').flatMap((line) => wrapText(line || ' ', PDF_WIDTH - PDF_MARGIN * 2 - 18, 8.5, true));
    const height = lines.length * 12 + 16;
    this.ensureSpace(height);
    const top = this.y + 5;
    const bottom = this.y - lines.length * 12 - 7;
    this.page.commands.push(`0.96 g ${PDF_MARGIN.toFixed(2)} ${bottom.toFixed(2)} ${(PDF_WIDTH - PDF_MARGIN * 2).toFixed(2)} ${(top - bottom).toFixed(2)} re f 0 g`);
    for (const line of lines) {
      this.page.commands.push(pdfText(line, PDF_MARGIN + 9, this.y - 2, 8.5, 'F4'));
      this.y -= 12;
    }
    this.y -= 12;
  }

  addTable(table: TableBlock): void {
    const columnCount = Math.max(1, ...table.rows.map((row) => row.length));
    const tableWidth = PDF_WIDTH - PDF_MARGIN * 2;
    const columnWidth = tableWidth / columnCount;
    const fontSize = columnCount >= 6 ? 6.6 : columnCount >= 4 ? 7.4 : 8.2;
    const lineHeight = fontSize * 1.35;

    table.rows.forEach((row, rowIndex) => {
      const wrappedCells = Array.from({ length: columnCount }, (_, columnIndex) => {
        const text = runsToText(row[columnIndex] ?? [{ text: '' }]);
        return wrapText(text, columnWidth - 8, fontSize);
      });
      const lineCount = Math.max(1, ...wrappedCells.map((cell) => cell.length));
      const rowHeight = lineCount * lineHeight + 10;
      this.ensureSpace(rowHeight + 4);
      const rowBottom = this.y - rowHeight;

      if (rowIndex === 0) {
        this.page.commands.push(`0.91 0.94 0.98 rg ${PDF_MARGIN.toFixed(2)} ${rowBottom.toFixed(2)} ${tableWidth.toFixed(2)} ${rowHeight.toFixed(2)} re f 0 g`);
      }

      for (let column = 0; column < columnCount; column += 1) {
        const x = PDF_MARGIN + column * columnWidth;
        this.page.commands.push(`0.76 G 0.45 w ${x.toFixed(2)} ${rowBottom.toFixed(2)} ${columnWidth.toFixed(2)} ${rowHeight.toFixed(2)} re S 0 G`);
        wrappedCells[column].forEach((line, lineIndex) => {
          this.page.commands.push(
            pdfText(
              line,
              x + 4,
              this.y - 4 - fontSize - lineIndex * lineHeight,
              fontSize,
              rowIndex === 0 ? 'F2' : 'F1',
            ),
          );
        });
      }
      this.y = rowBottom;
    });
    this.y -= 14;
  }

  addFooters(title: string): void {
    this.pages.forEach((page, index) => {
      const pageLabel = `${index + 1} / ${this.pages.length}`;
      page.commands.push(`0.78 G 0.5 w ${PDF_MARGIN.toFixed(2)} 34 m ${(PDF_WIDTH - PDF_MARGIN).toFixed(2)} 34 l S 0 G`);
      page.commands.push(pdfText(title.slice(0, 72), PDF_MARGIN, 20, 7.5, 'F1'));
      page.commands.push(pdfText(pageLabel, PDF_WIDTH - PDF_MARGIN - 28, 20, 7.5, 'F1'));
    });
  }
}

function blocksToPdfPages(blocks: MarkdownBlock[], title: string): PdfPage[] {
  const layout = new PdfLayout();

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const sizes = [22, 17, 14, 12, 11, 10.5];
        layout.addTextBlock(runsToText(block.runs), {
          size: sizes[Math.min(block.level, 6) - 1],
          font: 'F2',
          before: block.level === 1 ? 0 : 8,
          after: block.level === 1 ? 12 : 7,
          lineHeight: sizes[Math.min(block.level, 6) - 1] * 1.2,
        });
        break;
      }
      case 'paragraph':
        layout.addTextBlock(runsToText(block.runs), { size: 10, font: 'F1', after: 8, lineHeight: 14 });
        break;
      case 'list-item':
        layout.addTextBlock(runsToText(block.runs), {
          size: 9.8,
          font: 'F1',
          indent: block.depth * 16,
          prefix: block.ordered ? `${block.index ?? 1}.` : '•',
          after: 4,
          lineHeight: 13.5,
        });
        break;
      case 'quote':
        layout.addQuote(runsToText(block.runs));
        break;
      case 'code':
        layout.addCode(block.text);
        break;
      case 'divider':
        layout.addRule();
        break;
      case 'table':
        layout.addTable(block);
        break;
      default:
        break;
    }
  }

  layout.addFooters(title);
  return layout.pages;
}

function pdfInfoDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function buildPdf(markdown: string, metadata: ExportDocumentMetadata): Uint8Array {
  const blocks = parseMarkdown(markdown);
  const pages = blocksToPdfPages(blocks, metadata.title);
  const objects = new Map<number, string>();
  const fontObjects: Array<[number, string]> = [
    [3, 'Helvetica'],
    [4, 'Helvetica-Bold'],
    [5, 'Helvetica-Oblique'],
    [6, 'Courier'],
  ];

  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  for (const [id, font] of fontObjects) {
    objects.set(id, `<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`);
  }

  const pageIds: number[] = [];
  pages.forEach((page, index) => {
    const pageId = 7 + index * 2;
    const streamId = pageId + 1;
    pageIds.push(pageId);
    const stream = `${page.commands.join('\n')}\n`;
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_WIDTH.toFixed(2)} ${PDF_HEIGHT.toFixed(2)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${streamId} 0 R >>`,
    );
    objects.set(streamId, `<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  });

  objects.set(2, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
  const infoId = 7 + pages.length * 2;
  const createdAt = validDate(metadata.createdAt);
  objects.set(
    infoId,
    `<< /Title <${pdfHex(metadata.title)}> /Creator (Notes) /Producer (Notes formatted export) /CreationDate (${pdfInfoDate(createdAt)}) >>`,
  );

  const maxId = infoId;
  const offsets = new Array<number>(maxId + 1).fill(0);
  let output = '%PDF-1.4\n% Notes formatted export\n';
  for (let id = 1; id <= maxId; id += 1) {
    const body = objects.get(id);
    if (!body) throw new Error(`PDF object ${id} was not generated`);
    offsets[id] = output.length;
    output += `${id} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = output.length;
  output += `xref\n0 ${maxId + 1}\n`;
  output += '0000000000 65535 f \n';
  for (let id = 1; id <= maxId; id += 1) {
    output += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return textEncoder.encode(output);
}
