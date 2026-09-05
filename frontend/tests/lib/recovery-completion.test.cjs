const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const load = relative => {
  const file = path.join(root, relative);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const mod = new Module(file, module); mod._compile(js, file); return mod.exports;
};
const {createNotesSaveQueue} = load('src/lib/notes-autosave.ts');
test('compare-and-swap follows the last native acknowledgement, even when superseded in the UI', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const written = [];
  const queue = createNotesSaveQueue(async (id, value, expected) => { if (value === 'first') await gate; written.push({value,expected}); });
  const first = queue.save('meeting','first','original'); await Promise.resolve();
  const next = queue.save('meeting','second','original'); release(); await first; await next;
  assert.deepEqual(written,[{value:'first',expected:'original'},{value:'second',expected:'first'}]);
});
test('a failed write cannot become the expected saved version', async () => {
  const bases=[]; let fail=true;
  const queue=createNotesSaveQueue(async(id,value,expected)=>{ bases.push(expected); if(fail)throw new Error('NOTES_CONFLICT'); });
  await assert.rejects(queue.save('meeting','first','old')); fail=false;
  await queue.save('meeting','reviewed','remote'); assert.deepEqual(bases,['old','remote']);
});
test('native notes compare the stored text instead of trusting view-local revision counters', () => {
  const source=read('src-tauri/src/api/meeting_notes.rs'); assert.match(source,/COALESCE\(notes_markdown/); assert.match(source,/NOTES_CONFLICT/);
});
test('native export verifies the reviewed snapshot before any save dialog', () => {
  const source=read('src-tauri/src/api/meeting_export.rs');
  const command=source.slice(source.indexOf('pub async fn api_export_meeting<R'));
  assert.ok(command.indexOf('request.expected_markdown') < command.indexOf('save_dialog_path('));
  assert.match(command,/temporary.persist/);
});
test('JSON export excludes internal cache and provider metadata', () => {
  const source=read('src-tauri/src/api/meeting_export.rs');
  const start=source.indexOf('fn selected_json('); const stop=source.indexOf('fn sanitize_title_for_filename',start);
  const body=source.slice(start,stop); assert.match(body,/visible_summary/); assert.match(body,/summary_to_markdown/);
});
test('desktop write failure is not silently disguised as a browser download', () => {
  assert.match(read('src/lib/meeting-export.ts'), /if \(isTauri\(\)\) throw desktopError/);
});
test('meeting tabs retain content and have keyboard-accessible panel relationships', () => {
  const header=read('src/components/Meeting/MeetingHeader.tsx'); const panels=read('src/app/meeting-details/page-content.tsx');
  assert.match(header,/role="tablist"/); assert.match(header,/ArrowRight/); assert.match(header,/aria-controls/); assert.match(panels,/visitedTabs/); assert.match(panels,/role="tabpanel"/);
});
test('summary errors remain visible even without a previous summary', () => {
  assert.match(read('src/components/MeetingDetails/SummaryPanel.tsx'), /summaryError && <div role="alert"/);
});
