const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const file = path.resolve(__dirname, '../../src/lib/calendar-awareness.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const loaded = new Module(file, module);
loaded._compile(compiled.outputText, file);
const { selectSuggestedCalendarEvent, selectNextCalendarEvent, shouldNotifyForCalendarEvent } = loaded.exports;

const MIN = 60_000;
const now = 2_000_000_000_000;
const event = (id, startMinutes, duration = 30, extra = {}) => ({
  id,
  title: id,
  startAtMs: now + startMinutes * MIN,
  endAtMs: now + (startMinutes + duration) * MIN,
  allDay: false,
  attendeeCount: 2,
  ...extra,
});

test('suggests the meeting inside the 15 minute preparation window', () => {
  assert.equal(selectSuggestedCalendarEvent([event('later', 12)], new Set(), now).id, 'later');
  assert.equal(selectSuggestedCalendarEvent([event('too-far', 16)], new Set(), now), null);
});

test('keeps an active meeting suggested and skips dismissed meetings', () => {
  const active = event('active', -8, 45);
  const next = event('next', 7);
  assert.equal(selectSuggestedCalendarEvent([next, active], new Set(), now).id, 'active');
  assert.equal(selectSuggestedCalendarEvent([active, next], new Set(['active']), now).id, 'next');
});

test('all-day and already-ended meetings are ignored', () => {
  assert.equal(selectSuggestedCalendarEvent([
    event('all-day', -60, 1440, { allDay: true }),
    event('ended', -60, 20),
  ], new Set(), now), null);
});

test('next meeting selection is chronological rather than input order', () => {
  assert.equal(selectNextCalendarEvent([event('later', 30), event('soon', 5)], new Set(), now).id, 'soon');
});

test('notification policy only fires around the meeting boundary', () => {
  assert.equal(shouldNotifyForCalendarEvent(event('soon', 2), now), true);
  assert.equal(shouldNotifyForCalendarEvent(event('later', 3), now), false);
  assert.equal(shouldNotifyForCalendarEvent(event('active', -5, 30), now), true);
  assert.equal(shouldNotifyForCalendarEvent(event('stale', -20, 5), now), false);
});
