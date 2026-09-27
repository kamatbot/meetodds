const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/lib/finished-summary-projection.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const projection = {};
vm.runInNewContext(output, { exports: projection });

test('markdown reading projection hides only generated actions and keeps source unchanged', () => {
  const saved = '# Meeting\n\n## Meeting outcome\nShip the smaller release.\n\n<!-- meetodds:actions -->\n## Action items\n- Send the report.\n\n<!-- meetodds:questions -->\n## Open questions\nShould calendar wait?\n\n<!-- meetodds:end -->';
  const displayed = projection.markdownWithoutGeneratedActionsForDisplay(saved);
  assert.match(displayed, /Meeting outcome/);
  assert.match(displayed, /Open questions/);
  assert.doesNotMatch(displayed, /Send the report|Action items/);
  assert.equal(saved.includes('Send the report'), true);
});

test('provider action markers hide a translated action heading from the reading view', () => {
  const saved = '## Ergebnis\nFreigabe für die kleinere Version.\n\n<!-- meetodds:actions -->\n## Aufgaben\n- Bericht am Freitag senden.\n\n<!-- meetodds:questions -->\n## Offene Fragen\nKalender später?';
  const displayed = projection.markdownWithoutGeneratedActionsForDisplay(saved);
  assert.match(displayed, /Freigabe für die kleinere Version/);
  assert.match(displayed, /Offene Fragen/);
  assert.doesNotMatch(displayed, /Aufgaben|Bericht am Freitag/);
});

test('unmarked user-authored task headings remain visible in markdown summaries', () => {
  const saved = '## Tasks\nReview the notes.\n\n## Next steps\nAsk for feedback.\n\n## Action items\nKeep this user-authored section.';
  assert.equal(projection.markdownWithoutGeneratedActionsForDisplay(saved), saved);
});

test('unmarked BlockNote task headings remain visible in the reading projection', () => {
  const saved = [
    { id: 'tasks', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Tasks' }] },
    { id: 'task-body', type: 'paragraph', content: [{ type: 'text', text: 'Review the notes.' }] },
    { id: 'next-steps', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Next steps' }] },
  ];
  assert.equal(Array.from(projection.summaryWithoutGeneratedActionsForDisplay(saved), block => block.id).join(','), 'tasks,task-body,next-steps');
});

test('BlockNote reading projection hides only marked actions without changing saved blocks', () => {
  const saved = [
    { id: 'outcome', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Meeting outcome' }] },
    { id: 'decision', type: 'paragraph', content: [{ type: 'text', text: 'Ship the smaller release.' }] },
    { id: 'marker-actions', type: 'paragraph', content: [{ type: 'text', text: '<!-- meetodds:actions -->' }] },
    { id: 'actions', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Action items' }] },
    { id: 'task', type: 'bulletListItem', content: [{ type: 'text', text: 'Send the report.' }] },
    { id: 'marker-questions', type: 'paragraph', content: [{ type: 'text', text: '<!-- meetodds:questions -->' }] },
    { id: 'questions', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Open questions' }] },
  ];
  const displayed = projection.summaryWithoutGeneratedActionsForDisplay(saved);
  assert.equal(Array.from(displayed, block => block.id).join(','), 'outcome,decision,questions');
  assert.equal(saved.length, 7);
  assert.equal(saved[4].content[0].text, 'Send the report.');
});

test('action-only BlockNote summaries with structured actions project to valid empty display content', () => {
  const structuredActions = [{ id: 'persisted-task' }];
  const saved = [
    { id: 'marker-actions', type: 'paragraph', content: [{ type: 'text', text: '<!-- meetodds:actions -->' }] },
    { id: 'actions', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Action items' }] },
    { id: 'task', type: 'bulletListItem', content: [{ type: 'text', text: 'Send the report.' }] },
    { id: 'marker-questions', type: 'paragraph', content: [{ type: 'text', text: '<!-- meetodds:questions -->' }] },
  ];
  const displayed = structuredActions.length
    ? projection.summaryWithoutGeneratedActionsForDisplay(saved)
    : saved;
  const initialContent = projection.blockNoteInitialContentForDisplay(displayed);
  assert.equal(displayed.length, 0);
  assert.equal(initialContent.length, 1);
  assert.equal(initialContent[0].type, 'paragraph');
  assert.equal(saved[2].content[0].text, 'Send the report.');
});

test('BlockNote action markers suppress translated task headings in the reading projection', () => {
  const saved = [
    { id: 'summary', type: 'paragraph', content: [{ type: 'text', text: 'Der kleinere Umfang wurde vereinbart.' }] },
    { id: 'marker-actions', type: 'paragraph', content: [{ type: 'text', text: '<!-- meetodds:actions -->' }] },
    { id: 'translated-actions', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Aufgaben' }] },
    { id: 'task', type: 'bulletListItem', content: [{ type: 'text', text: 'Bericht senden.' }] },
    { id: 'marker-questions', type: 'paragraph', content: [{ type: 'text', text: '<!-- meetodds:questions -->' }] },
    { id: 'questions', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Offene Fragen' }] },
  ];
  const displayed = projection.summaryWithoutGeneratedActionsForDisplay(saved);
  assert.equal(Array.from(displayed, block => block.id).join(','), 'summary,questions');
  assert.equal(saved.length, 6);
});

test('legacy action sections are omitted from reading view but kept in their saved object', () => {
  const saved = {
    _section_order: ['Outcome', 'ActionItems', 'Tasks', 'NextSteps', 'Discussion'],
    Outcome: { title: 'Meeting outcome', blocks: [{ content: 'Ship the smaller release.' }] },
    ActionItems: { title: 'Action items', blocks: [{ content: 'Send the report.' }] },
    Tasks: { title: 'Tasks', blocks: [{ content: 'Review the notes.' }] },
    NextSteps: { title: 'Next steps', blocks: [{ content: 'Ask for feedback.' }] },
    Discussion: { title: 'Discussion', blocks: [{ content: 'Calendar can wait.' }] },
  };
  const displayed = projection.legacySummaryForDisplay(saved);
  assert.match(displayed, /Meeting outcome/);
  assert.match(displayed, /Calendar can wait/);
  assert.match(displayed, /Review the notes/);
  assert.match(displayed, /Ask for feedback/);
  assert.doesNotMatch(displayed, /Send the report/);
  assert.equal(saved.ActionItems.blocks[0].content, 'Send the report.');
  assert.match(projection.legacySummaryForDisplay(saved, false), /Send the report/);
});
