const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/lib/finished-meeting-state.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const state = {};
vm.runInNewContext(output, { exports: state });

test('finished meeting renders a saved summary while the previous result is being updated', () => {
  assert.equal(state.getFinishedSummaryViewState({ hasSummary: true, hasTranscript: true, status: 'regenerating' }), 'generating');
  assert.equal(state.getFinishedSummaryProgressLabel('regenerating'), 'Updating the AI summary…');
});

test('a saved summary is ready and missing summaries expose retry or generation states', () => {
  assert.equal(state.getFinishedSummaryViewState({ hasSummary: true, hasTranscript: true, status: 'completed' }), 'ready');
  assert.equal(state.getFinishedSummaryViewState({ hasSummary: false, hasTranscript: true, status: 'error' }), 'failed');
  assert.equal(state.getFinishedSummaryViewState({ hasSummary: false, hasTranscript: true, status: 'idle' }), 'needs-summary');
});

test('a meeting without saved speech is empty and has no actions to show', () => {
  assert.equal(state.getFinishedSummaryViewState({ hasSummary: false, hasTranscript: false, status: 'error' }), 'empty');
  assert.deepEqual(state.visibleMeetingActions([{ status: 'dismissed' }]), []);
});

test('only persisted, non-dismissed actions are visible', () => {
  const actions = [{ id: 'open', status: 'open' }, { id: 'done', status: 'done' }, { id: 'hidden', status: 'dismissed' }];
  assert.deepEqual(state.visibleMeetingActions(actions).map(action => action.id), ['open', 'done']);
});

test('structured action presence survives dismissing the final persisted action', () => {
  assert.equal(state.rememberStructuredActionPresence(false, [{ status: 'dismissed' }]), true);
  assert.equal(state.rememberStructuredActionPresence(true, []), true);
  assert.equal(state.rememberStructuredActionPresence(false, []), false);
});
