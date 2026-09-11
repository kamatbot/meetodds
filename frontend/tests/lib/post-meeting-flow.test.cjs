const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
function load(name) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, 'src/lib', name + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, URL, require: id => load(id.replace('./', '')) });
  return exports;
}
const f = load('post-meeting-flow');
const target = { provider: 'openai-codex', model: 'chosen-model', destination: 'https://chatgpt.com/backend-api/codex', local: false, label: 'ChatGPT' };
function storage() { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; }
test('saved transcript alone cannot expose the outcome', () => assert.equal(f.postMeetingPhase(null, 'idle'), 'ready'));
test('empty summary objects and blank markdown are not outcomes', () => { assert.equal(f.postMeetingPhase({}, 'completed'), 'ready'); assert.equal(f.postMeetingPhase({ markdown: '  ' }, 'completed'), 'ready'); });
test('a completed AI summary exposes the outcome', () => assert.equal(f.postMeetingPhase({ markdown: '## Meeting outcome\nAgreed to ship.' }, 'completed'), 'outcome'));
test('generation keeps even a previous outcome behind a progress state', () => assert.equal(f.postMeetingPhase({ markdown: 'Previous summary' }, 'regenerating'), 'generating'));
test('first-generation failure is actionable; failed regeneration retains previous output', () => { assert.equal(f.postMeetingPhase(null, 'error'), 'error'); assert.equal(f.postMeetingPhase({ markdown: 'Previous' }, 'error'), 'outcome'); });
test('automatic processing requires explicit saved consent', () => { const s = storage(); s.setItem('isAutoSummary', 'true'); assert.equal(f.readAutoSummaryApproval(s, target), null); });
test('consent is bound to provider/model/destination and excludes personal notes', () => { const s = storage(); s.setItem('isAutoSummary', 'true'); f.saveAutoSummaryApproval(s, target, false); assert.equal(f.readAutoSummaryApproval(s, target).includeManualNotes, false); for (const field of ['provider', 'model', 'destination']) assert.equal(f.readAutoSummaryApproval(s, { ...target, [field]: 'changed' }), null); });
test('disabling automatic summaries revokes bypass even with a saved approval', () => { const s = storage(); f.saveAutoSummaryApproval(s, target, true); s.setItem('isAutoSummary', 'false'); assert.equal(f.readAutoSummaryApproval(s, target), null); });
test('corrupt consent fails closed', () => { const s = storage(); s.setItem('isAutoSummary', 'true'); s.setItem(f.AUTO_SUMMARY_APPROVAL_KEY, '{'); assert.equal(f.readAutoSummaryApproval(s, target), null); });
test('one automatic attempt per meeting, reloads included', () => { const s = storage(); assert.equal(f.claimAutomaticSummary(s, 'one'), true); assert.equal(f.claimAutomaticSummary(s, 'one'), false); assert.equal(f.claimAutomaticSummary(s, 'two'), true); });
test('blocked storage does not start accidental background processing', () => assert.equal(f.claimAutomaticSummary({ getItem() { throw Error('blocked'); }, setItem() {} }, 'one'), false));
test('model output contract supports translated headings and explicit unknown metadata', () => { assert.ok(f.POST_MEETING_INSTRUCTIONS.includes('<!-- meetodds:actions -->')); assert.match(f.POST_MEETING_INSTRUCTIONS, /never guess names or deadlines/); assert.match(f.POST_MEETING_INSTRUCTIONS, /NOT a transcript fragment/); });
