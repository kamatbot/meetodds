from pathlib import Path

def edit(path, old, new, count=1):
    p=Path(path); s=p.read_text()
    if s.count(old)!=count: raise RuntimeError(f'{path}: expected {count}, found {s.count(old)}: {old[:100]}')
    p.write_text(s.replace(old,new))
def region(path, first, last, replacement):
    p=Path(path); s=p.read_text()
    if s.count(first)!=1: raise RuntimeError(f'{path}: first anchor not unique')
    start=s.index(first); end=s.index(last,start)
    p.write_text(s[:start]+replacement+s[end:])

p='frontend/src-tauri/src/api/meeting_notes.rs'
edit(p, '    notes_markdown: &str,\n) -> Result<bool, sqlx::Error>', '    notes_markdown: &str,\n    expected: Option<&str>,\n) -> Result<bool, sqlx::Error>')
edit(p, 'WHERE id = ? AND deleted_at IS NULL",\n    )\n    .bind(notes_markdown)', 'WHERE id = ? AND deleted_at IS NULL AND (? IS NULL OR COALESCE(notes_markdown, \'\') = ?)",\n    )\n    .bind(notes_markdown)')
edit(p, '    .bind(meeting_id)\n    .execute(pool)', '    .bind(meeting_id)\n    .bind(expected)\n    .bind(expected)\n    .execute(pool)')
edit(p, '    notes_markdown: String,\n) -> Result<(), String>', '    notes_markdown: String,\n    expected_notes_markdown: Option<String>,\n) -> Result<(), String>')
edit(p, 'save_notes(state.db_manager.pool(), meeting_id, &notes_markdown)', 'save_notes(state.db_manager.pool(), meeting_id, &notes_markdown, expected_notes_markdown.as_deref())')
edit(p, '    if !updated {\n        return Err(format!("Meeting not found: {meeting_id}"));\n    }', '    if !updated {\n        return match load_notes(state.db_manager.pool(), meeting_id).await {\n            Ok(Some(_)) => Err("NOTES_CONFLICT: Saved notes changed in another view. Review both versions before replacing them.".to_string()),\n            _ => Err("Meeting is unavailable; its notes were not overwritten".to_string()),\n        };\n    }')
edit(p, 'save_notes(&pool, "meeting-1", "# Decisions\\n- Ship it")', 'save_notes(&pool, "meeting-1", "# Decisions\\n- Ship it", None)')
edit(p, 'save_notes(&pool, "meeting-1", "should not write")', 'save_notes(&pool, "meeting-1", "should not write", None)')
s=Path(p).read_text(); pos=s.rfind('\n}')
s=s[:pos]+'''
    #[tokio::test]
    async fn stale_writer_cannot_overwrite_a_newer_saved_note() {
        let pool = test_pool().await;
        sqlx::query("INSERT INTO meetings (id) VALUES ('race')").execute(&pool).await.unwrap();
        assert!(save_notes(&pool, "race", "first", Some("")).await.unwrap());
        assert!(!save_notes(&pool, "race", "stale", Some("")).await.unwrap());
        assert_eq!(load_notes(&pool, "race").await.unwrap(), Some("first".to_string()));
        assert!(save_notes(&pool, "race", "reviewed replacement", Some("first")).await.unwrap());
    }
'''+s[pos:];Path(p).write_text(s)
p='frontend/src/lib/notes-autosave.ts'
edit(p,'write: (meetingId: string, value: string) => Promise<void>', 'write: (meetingId: string, value: string, expected?: string) => Promise<void>')
edit(p, 'latest: number; tail: Promise<void>', 'latest: number; tail: Promise<void>; acknowledged?: string')
edit(p, "save(meetingId: string, value: string): Promise<'saved' | 'superseded'>", "save(meetingId: string, value: string, expected?: string): Promise<'saved' | 'superseded'>")
edit(p, '{ latest: 0, tail: Promise.resolve() }', '{ latest: 0, tail: Promise.resolve(), acknowledged: expected }')
edit(p, '        await write(meetingId, value);', '        await write(meetingId, value, queue.acknowledged);\n        queue.acknowledged = value;')
p='frontend/src/components/Meeting/NotesEditor.tsx'
edit(p, 'async (meetingId, notesMarkdown) => {', 'async (meetingId, notesMarkdown, expectedNotesMarkdown) => {')
edit(p, '{ meetingId, notesMarkdown });', '{ meetingId, notesMarkdown, expectedNotesMarkdown });')
edit(p, 'await saves.save(meetingId, snapshot)', 'await saves.save(meetingId, snapshot, acknowledged.current)')
edit(p, "    } catch {\n      if (mounted.current && latest.current === snapshot) setSaveState('error');\n    }", "    } catch (error) {\n      if (String(error).includes('NOTES_CONFLICT') && mounted.current) {\n        blocked.current = true;\n        try {\n          const saved = await invoke<MeetingNotesResponse>('api_get_meeting_notes', { meetingId });\n          if (mounted.current) {\n            acknowledged.current = saved.notesMarkdown;\n            setConflict({ saved: saved.notesMarkdown, draft: latest.current });\n            setRecovered(true); setSaveState('error');\n          }\n        } catch { if (mounted.current) { setSaveState('error'); setLoadError('Saved notes changed but could not be read. Your local draft is retained. Retry to compare both versions.'); } }\n      } else if (mounted.current && latest.current === snapshot) setSaveState('error');\n    }")

p='frontend/src-tauri/src/api/meeting_export.rs'
edit(p,'    pub selection: MeetingExportSelection,', '    pub selection: MeetingExportSelection,\n    #[serde(default)]\n    pub expected_markdown: Option<String>,')
edit(p,'    let (extension, filter_name, content) =\n        serialize_content', '    if let Some(expected) = request.expected_markdown.as_deref() {\n        if selected_markdown(&bundle, &request.selection)? != expected {\n            return Err("Saved content changed after preview. Review it again before exporting.".to_string());\n        }\n    }\n    let (extension, filter_name, content) =\n        serialize_content')
edit(p, '    std::fs::write(&destination, content)\n        .map_err(|error| format!("Failed to write exported meeting: {error}"))?;', '    let parent = destination.parent().ok_or_else(|| "Invalid export destination".to_string())?;\n    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;\n    use std::io::Write;\n    temporary.write_all(content.as_bytes()).map_err(|e| e.to_string())?;\n    temporary.as_file().sync_all().map_err(|e| e.to_string())?;\n    temporary.persist(&destination).map_err(|e| e.to_string())?;')
region(p, '    let summary = selection\n        .include_summary', '    let notes_markdown = selection', '    let visible_summary = if selection.include_summary {\n        bundle.summary.as_ref().and_then(summary_to_markdown).map(|markdown| serde_json::json!({"markdown": markdown}))\n    } else { None };\n    let summary = visible_summary.as_ref();\n')
p='frontend/src/components/Meeting/ExportSheet.tsx'
edit(p, 'request: { meetingId, format, selection }', 'request: { meetingId, format, selection, expectedMarkdown: snapshot }')
p='frontend/src/lib/meeting-export.ts'
edit(p, "import { downloadDir, join } from '@tauri-apps/api/path';", "import { downloadDir, join } from '@tauri-apps/api/path';\nimport { isTauri } from '@tauri-apps/api/core';")
edit(p, '  } catch (desktopError) {', '  } catch (desktopError) {\n    if (isTauri()) throw desktopError;')

p='frontend/src/components/MeetingDetails/SummaryPanel.tsx'
edit(p, '      {isSummaryLoading ? (', '      {summaryError && <div role="alert" className="mx-4 my-3 rounded-control border border-border bg-surface p-3 text-ui text-danger">{summaryError}</div>}\n      {isSummaryLoading && aiSummary && <div role="status" className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 text-ui text-2"><span>{getSummaryStatusMessage(summaryStatus)} Your previous summary remains available.</span><button type="button" onClick={onStopGeneration} className="rounded-control border border-border px-3 py-1.5">Cancel</button></div>}\n      {isSummaryLoading && !aiSummary ? (')
edit(p, '          <div className="p-6 w-full">', '          <div className="p-6 w-full" aria-busy={isSummaryLoading} style={isSummaryLoading ? { pointerEvents: "none" } : undefined}>')
edit(p, '  const isSummaryLoading =', '  const generateSafely = async (prompt: string) => {\n    try { if (aiSummary) await onSaveAll(); await onGenerateSummary(prompt); }\n    catch { toast.error("Save your summary edits before generating again"); }\n  };\n  const regenerateSafely = async () => {\n    try { if (aiSummary) await onSaveAll(); await onRegenerateSummary(); }\n    catch { toast.error("Save your summary edits before regenerating"); }\n  };\n\n  const isSummaryLoading =')
s=Path(p).read_text().replace('onGenerateSummary={onGenerateSummary}', 'onGenerateSummary={generateSafely}').replace('onGenerate={() => onGenerateSummary(customPrompt)}', 'onGenerate={() => generateSafely(customPrompt)}').replace('                onRegenerateSummary();', '                void regenerateSafely();')
s=s.replace('bg-white overflow-hidden','bg-bg overflow-hidden').replace('border-gray-200','border-border').replace('text-gray-600','text-2')
Path(p).write_text(s)
p='frontend/src/components/Meeting/MeetingHeader.tsx'
edit(p, '<nav className="flex h-9 items-end gap-1 px-5 md:px-6" aria-label="Meeting detail sections">', '<nav role="tablist" className="flex h-9 items-end gap-1 px-5 md:px-6" aria-label="Meeting detail sections">')
edit(p, '              role="tab"\n              aria-selected={selected}', '              role="tab"\n              id={`meeting-tab-${tab.id}`}\n              aria-controls={`meeting-panel-${tab.id}`}\n              tabIndex={selected ? 0 : -1}\n              aria-selected={selected}\n              onKeyDown={(event) => {\n                const index = tabs.findIndex(candidate => candidate.id === tab.id);\n                const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : -1;\n                if (next >= 0) { event.preventDefault(); onTabChange(tabs[next].id); document.getElementById(`meeting-tab-${tabs[next].id}`)?.focus(); }\n              }}')
p='frontend/src/app/meeting-details/page-content.tsx'
edit(p, '  // State\n', '  const [visitedTabs, setVisitedTabs] = useState<Set<MeetingDetailTab>>(() => new Set([activeTab]));\n  useEffect(() => { setVisitedTabs(new Set([activeTab])); }, [meeting.id]);\n  useEffect(() => { setVisitedTabs(previous => new Set([...previous, activeTab])); }, [activeTab]);\n\n  // State\n')
edit(p, "{activeTab === 'summary' && (", "{(activeTab === 'summary' || visitedTabs.has('summary')) && (")
edit(p, '<div className="flex h-full min-h-0 [&>div]:!bg-bg">', '<div id="meeting-panel-summary" role="tabpanel" aria-labelledby="meeting-tab-summary" hidden={activeTab !== "summary"} className={activeTab === "summary" ? "flex h-full min-h-0 [&>div]:!bg-bg" : "hidden"}>')
edit(p, "{activeTab === 'transcript' && (", "{(activeTab === 'transcript' || visitedTabs.has('transcript')) && (")
edit(p, '<div className="flex h-full min-h-0 [&>div]:!flex [&>div]:!w-full [&>div]:!border-r-0 [&>div]:!bg-bg">', '<div id="meeting-panel-transcript" role="tabpanel" aria-labelledby="meeting-tab-transcript" hidden={activeTab !== "transcript"} className={activeTab === "transcript" ? "flex h-full min-h-0 [&>div]:!flex [&>div]:!w-full [&>div]:!border-r-0 [&>div]:!bg-bg" : "hidden"}>')
edit(p, "{activeTab === 'notes' && (\n          <NotesEditor meetingId={meeting.id} />\n        )}", "{(activeTab === 'notes' || visitedTabs.has('notes')) && (\n          <div id=\"meeting-panel-notes\" role=\"tabpanel\" aria-labelledby=\"meeting-tab-notes\" hidden={activeTab !== 'notes'} className={activeTab === 'notes' ? 'h-full' : 'hidden'}><NotesEditor meetingId={meeting.id} /></div>\n        )}")
print('Integrated stale-note protection, verified exports and stable meeting-pane UX.')
