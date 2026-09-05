const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const file = path.resolve(__dirname, '../../src/lib/notes-autosave.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const loaded = new Module(file, module); loaded._compile(compiled.outputText, file);
const { createNotesSaveQueue, readNotesDraft, writeNotesDraft, clearAcknowledgedDraft, discardNotesDraft } = loaded.exports;
const memory = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) }; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('coalesces queued older writes but preserves the latest', async () => {
  const written = []; const q = createNotesSaveQueue(async (id, value) => { written.push([id, value]); });
  const a = q.save('a', 'old'); const b = q.save('a', 'new');
  assert.equal(await a, 'superseded'); assert.equal(await b, 'saved');
  await q.idle('a'); assert.deepEqual(written, [['a', 'new']]);
});
test('in-flight old save cannot finish after newer save', async () => {
  const gate = deferred(); const written = [];
  const q = createNotesSaveQueue(async (id, value) => { if (value === 'old') await gate.promise; written.push(value); });
  const a = q.save('a', 'old'); await Promise.resolve();
  const b = q.save('a', 'new'); gate.resolve();
  assert.equal(await a, 'superseded'); assert.equal(await b, 'saved'); assert.deepEqual(written, ['old', 'new']);
});
test('failure does not poison the save queue and idle resolves', async () => {
  let fail = true; const q = createNotesSaveQueue(async () => { if (fail) throw new Error('disk'); });
  await assert.rejects(q.save('a', 'old')); fail = false;
  assert.equal(await q.save('a', 'retry'), 'saved'); await q.idle('a');
});
test('different meetings do not block or overwrite each other', async () => {
  const gate = deferred(); const q = createNotesSaveQueue(async id => { if (id === 'a') await gate.promise; });
  const a = q.save('a', 'A'); assert.equal(await q.save('b', 'B'), 'saved'); gate.resolve(); await a;
});
test('recovery draft is scoped to meeting and preserves its saved base', () => {
  const s = memory(); const draft = { version: 1, meetingId: 'a/b', base: 'saved', value: 'edited' };
  writeNotesDraft(s, draft); assert.deepEqual(readNotesDraft(s, 'a/b'), draft); assert.equal(readNotesDraft(s, 'b'), null);
});
test('older acknowledgement cannot clear a newer local draft', () => {
  const s = memory(); writeNotesDraft(s, { version: 1, meetingId: 'a', base: '', value: 'new' });
  clearAcknowledgedDraft(s, 'a', 'old'); assert.equal(readNotesDraft(s, 'a').value, 'new');
  clearAcknowledgedDraft(s, 'a', 'new'); assert.equal(readNotesDraft(s, 'a'), null);
});
test('malformed and wrong-meeting drafts are not restored', () => {
  const s = memory(); s.setItem('meetodds:notes-draft:v1:a', '{broken'); assert.equal(readNotesDraft(s, 'a'), null);
  s.setItem('meetodds:notes-draft:v1:a', JSON.stringify({ version: 1, meetingId: 'b', base: '', value: 'secret' })); assert.equal(readNotesDraft(s, 'a'), null);
});
test('storage failures remain visible to caller; explicit discard removes only this meeting', () => {
  const broken = { setItem() { throw new Error('quota'); } };
  assert.throws(() => writeNotesDraft(broken, { version: 1, meetingId: 'a', base: '', value: '' }));
  const s = memory(); for (const id of ['a', 'b']) writeNotesDraft(s, { version: 1, meetingId: id, base: '', value: id });
  discardNotesDraft(s, 'a'); assert.equal(readNotesDraft(s, 'a'), null); assert.equal(readNotesDraft(s, 'b').value, 'b');
});
