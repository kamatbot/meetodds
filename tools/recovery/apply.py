from pathlib import Path

def edit(path, old, new, count=1):
    p=Path(path); s=p.read_text()
    if s.count(old)!=count: raise RuntimeError(f'{path}: expected {count}, found {s.count(old)}: {old[:100]}')
    p.write_text(s.replace(old,new))
def region(path, first, last, replacement):
    p=Path(path); s=p.read_text()
    if s.count(first)!=1: raise RuntimeError(f'{path}: ambiguous start')
    start=s.index(first); end=s.index(last,start); p.write_text(s[:start]+replacement+s[end:])

p='frontend/src/components/AISummary/BlockNoteSummaryView.tsx'
edit(p, 'onSave?: (data: { markdown?: string; summary_json?: BlockNoteBlock[] }) => void;', 'onSave?: (data: { markdown?: string; summary_json?: BlockNoteBlock[] }) => void | Promise<void>;')
edit(p, '  const isContentLoaded = useRef(false);', '  const isContentLoaded = useRef(false);\n  const editRevision = useRef(0);\n  const hasEdited = useRef(false);\n  const savePending = useRef(false);')
edit(p, '      setCurrentBlocks(blocks);', '      editRevision.current += 1; hasEdited.current = true;\n      setCurrentBlocks(blocks);')
edit(p, '    if (!onSave || !isDirty) return;\n\n    setIsSaving(true);', '    if (!onSave || !isDirty) return;\n    if (savePending.current) throw new Error("A summary save is still running. Try again after it finishes.");\n    savePending.current = true;\n    const revision = editRevision.current;\n    setIsSaving(true);')
edit(p, '      onSave(saveData);\n\n      setIsDirty(false);', '      await onSave(saveData);\n      if (revision !== editRevision.current) throw new Error("New edits were made while saving. Save them before continuing.");\n      setIsDirty(false);')
edit(p, "      alert('Failed to save changes. Please try again.');", "      throw err;")
edit(p, '    } finally {\n      setIsSaving(false);', '    } finally {\n      savePending.current = false;\n      setIsSaving(false);')
edit(p, 'fallbackMarkdown: data?.markdown,', 'fallbackMarkdown: hasEdited.current ? undefined : data?.markdown,', count=2)
edit(p, 'const blocks = currentBlocks.length > 0', 'const blocks = hasEdited.current || currentBlocks.length > 0')
edit(p, '          if (data?.markdown) {', '          if (!hasEdited.current && data?.markdown) {')
s=Path(p).read_text(); s='\n'.join(line for line in s.split('\n') if "console.log('🔍 data:'" not in line); Path(p).write_text(s)

p='frontend/src/hooks/meeting-details/useMeetingData.ts'
edit(p, 'const [, setIsSummaryDirty] = useState(false);', 'const [isSummaryDirty, setIsSummaryDirty] = useState(false);')
edit(p, '    setAiSummary(newSummary);', '    setAiSummary(newSummary);\n    setIsSummaryDirty(true);')
edit(p, "        setError('Failed to save meeting summary: Unknown error');\n      }", "        setError('Failed to save meeting summary: Unknown error');\n      }\n      throw error;")
edit(p, '        await handleSaveMeetingTitle();', '        if (!await handleSaveMeetingTitle()) throw new Error("Meeting title could not be saved");')
edit(p, '      } else if (aiSummary) {', '      } else if (aiSummary && isSummaryDirty) {')
edit(p, '      toast.success("Changes saved successfully");', '      setIsSummaryDirty(false);')
edit(p, '      toast.error("Failed to save changes", { description: String(error) });', '      toast.error("Failed to save changes", { description: "Your unsaved edits are still available. Retry before exporting or generating a new summary." });\n      throw error;')
edit(p, '[isTitleDirty, handleSaveMeetingTitle, aiSummary, handleSaveSummary]', '[isTitleDirty, isSummaryDirty, handleSaveMeetingTitle, aiSummary, handleSaveSummary]')

p='frontend/src/components/Meeting/ExportSheet.tsx'
edit(p, 'initialInfo?: MeetingExportInfo | null }', "initialInfo?: MeetingExportInfo | null; initialFormat?: ExportFormatChoice }")
edit(p, '({ meetingId, open, onOpenChange }: ExportSheetProps)', "({ meetingId, open, onOpenChange, initialFormat = 'markdown' }: ExportSheetProps)")
edit(p, "setIncludeAudio(false); setFormat('markdown');", 'setIncludeAudio(false); setFormat(initialFormat);')
edit(p, '[meetingId, open, retry]);', '[meetingId, open, retry, initialFormat]);')
p='frontend/src/components/MeetingDetails/SummaryPanel.tsx'
edit(p, "import { exportMeetingSummary, type MeetingExportFormat } from '@/lib/meeting-export';", "import type { MeetingExportFormat } from '@/lib/meeting-export';\nimport ExportSheet from '@/components/Meeting/ExportSheet';")
edit(p, '  const [exportingFormat, setExportingFormat] = useState<MeetingExportFormat | null>(null);', '  const [exportingFormat, setExportingFormat] = useState<MeetingExportFormat | null>(null);\n  const [exportOpen, setExportOpen] = useState(false);\n  const [exportFormat, setExportFormat] = useState<MeetingExportFormat>("markdown");')
region(p, '  const handleExport = async (format: MeetingExportFormat) => {', '\n  const generateSafely =', '''  const handleExport = async (format: MeetingExportFormat) => {
    if (exportingFormat) return;
    setExportingFormat(format);
    try {
      await onSaveAll();
      setExportFormat(format);
      setExportOpen(true);
    } catch {
      toast.error('Save your current summary edits before exporting');
    } finally { setExportingFormat(null); }
  };
''')
edit(p, '    <div className="flex-1 min-w-0 flex flex-col bg-bg overflow-hidden">', '    <div className="flex-1 min-w-0 flex flex-col bg-bg overflow-hidden">\n      <ExportSheet meetingId={meeting.id} open={exportOpen} onOpenChange={setExportOpen} initialFormat={exportFormat} />')
edit(p, '                onSave={onSaveAll}', '                onSave={() => onSaveAll().catch(() => undefined)}')
edit(p, '            <BlockNoteSummaryView\n', '            <BlockNoteSummaryView\n              key={meeting.id}\n')
p='frontend/src/app/meeting/page.tsx'
edit(p, '      <MeetingHeader\n', '      <MeetingHeader\n        key={meetingDetails.id}\n')
edit(p, '        <PageContent\n', '        <PageContent\n          key={meetingDetails.id}\n')
edit(p, '<AudioPlayer meetingId={meetingDetails.id} />', '<AudioPlayer key={meetingDetails.id} meetingId={meetingDetails.id} />')

p='frontend/src-tauri/src/api/meeting_export.rs'
region(p, '    let audio_path = row.2.and_then(|folder| {', '\n\n    Ok(MeetingExportBundle', '    let audio_path = row.2.and_then(|folder| recording_audio_path(Path::new(&folder)));')
edit(p, 'fn summary_has_content(summary: &Value) -> bool {', '''fn recording_audio_path(folder: &Path) -> Option<PathBuf> {
    let folder = folder.canonicalize().ok()?;
    let metadata = std::fs::read(folder.join("metadata.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let name = metadata.as_ref().and_then(|value| value.get("audio_file")).and_then(Value::as_str);
    if name == Some("") { return None; }
    let name = name.unwrap_or("audio.mp4");
    let relative = Path::new(name);
    if relative.components().count() != 1 || relative.file_name()?.to_str()? != name { return None; }
    let path = folder.join(relative).canonicalize().ok()?;
    if path.parent() != Some(folder.as_path()) || !path.is_file() { return None; }
    Some(path)
}

fn summary_has_content(summary: &Value) -> bool {''')
# Do not leak an internal cached summary in JSON, and do not truncate a destination on audio copy failure.
edit(p, '        std::fs::copy(source, &destination)\n            .map_err(|error| format!("Failed to export meeting audio: {error}"))?;', '        let parent = destination.parent().ok_or_else(|| "Invalid audio export destination".to_string())?;\n        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;\n        let mut original = std::fs::File::open(source).map_err(|e| e.to_string())?;\n        std::io::copy(&mut original, temporary.as_file_mut()).map_err(|e| e.to_string())?;\n        temporary.as_file().sync_all().map_err(|e| e.to_string())?;\n        temporary.persist(&destination).map_err(|e| e.to_string())?;')
s=Path(p).read_text(); pos=s.rfind('\n}')
s=s[:pos]+'''
    #[test]
    fn playback_uses_the_committed_recovery_filename_and_rejects_path_escape() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("audio-recovered-example.mp4"), b"audio").unwrap();
        let metadata = directory.path().join("metadata.json");
        std::fs::write(&metadata, br#"{"audio_file":"audio-recovered-example.mp4"}"#).unwrap();
        assert!(super::recording_audio_path(directory.path()).unwrap().ends_with("audio-recovered-example.mp4"));
        std::fs::write(&metadata, br#"{"audio_file":"../secret.mp4"}"#).unwrap();
        assert!(super::recording_audio_path(directory.path()).is_none());
        std::fs::write(&metadata, br#"{"audio_file":""}"#).unwrap();
        assert!(super::recording_audio_path(directory.path()).is_none());
    }
'''+s[pos:]; Path(p).write_text(s)
p='tools/recovery/check-types.cjs'
edit(p, 'let introduced = 0;', "for (const [key,count] of before) console.log(`Baseline (${count}): ${key}`);\nlet introduced = 0;")
print('Unified exports and fixed false save acknowledgement in summary editing.')
