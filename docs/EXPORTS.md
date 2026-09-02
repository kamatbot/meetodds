# Formatted meeting exports

Notes exports the current edited summary—not merely the last persisted copy—through the summary toolbar.

## Formats

| Format | Output |
| --- | --- |
| PDF | Paginated A4 report with document metadata, heading hierarchy, lists, quotes, code blocks, table grids, and page footers |
| DOCX | Editable Word document with named paragraph styles, inline emphasis, lists, quotes, code blocks, tables, and document properties |
| Markdown | Portable UTF-8 source with the meeting title and formatted meeting date |

## Save behavior

The desktop app writes to the user's Downloads directory through Tauri's filesystem and path APIs. Existing files are never overwritten: subsequent exports add ` (1)`, ` (2)`, and so on. When desktop filesystem APIs are unavailable, the same data is sent through the browser download mechanism.

Export filenames are sanitized for macOS, Windows, and Linux and include the meeting date. The implementation has no additional runtime package dependency; PDF and DOCX serialization are kept in the client export module so opening a meeting does not load an export library.

## Supported Markdown

The formatted serializers support headings, paragraphs, ordered and unordered lists, nested list indentation, block quotes, fenced code, dividers, GFM-style tables, bold, italic, inline code, and links. Unsupported Markdown remains readable as text rather than being silently discarded.
