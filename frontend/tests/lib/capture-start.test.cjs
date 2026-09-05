const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const file = path.resolve(__dirname, '../../src/lib/capture-start.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const loaded = new Module(file, module); loaded._compile(compiled.outputText, file);
const { createCaptureStartGate, captureStartMessage } = loaded.exports;

test('multiple simultaneous entry points start only one recorder', async () => {
  const gate = createCaptureStartGate(); let release; let count = 0;
  const block = new Promise(r => { release = r; });
  const first = gate.run(async () => { count += 1; await block; });
  assert.equal(gate.pending, true);
  assert.equal(await gate.run(async () => { count += 1; }), false);
  release(); assert.equal(await first, true); assert.equal(count, 1); assert.equal(gate.pending, false);
});
test('start errors release the gate for a deliberate retry', async () => {
  const gate = createCaptureStartGate(); await assert.rejects(gate.run(async () => { throw new Error('permission'); }));
  assert.equal(gate.pending, false); assert.equal(await gate.run(async () => {}), true);
});
test('model setup messages do not assume Parakeet', () => {
  assert.match(captureStartMessage('Whisper model unavailable'), /selected transcription model/i);
  assert.doesNotMatch(captureStartMessage('Whisper model unavailable'), /Parakeet/);
});
test('permissions, downloads and storage have distinct actionable messages', () => {
  assert.match(captureStartMessage('permission denied'), /system settings/);
  assert.match(captureStartMessage('model downloading'), /downloading/);
  assert.match(captureStartMessage('disk full'), /free space/);
});
test('unknown failures do not leak raw operational content', () => {
  assert.doesNotMatch(captureStartMessage('unexpected secret=xyz'), /xyz/);
});
test('all entry points use selected-model native validation and notifications are isolated', () => {
  const hook = fs.readFileSync(path.resolve(__dirname, '../../src/hooks/useRecordingStart.ts'), 'utf8');
  assert.doesNotMatch(hook, /parakeet_has_available_models|checkParakeetReady|alert\(/);
  assert.match(hook, /try \{ await showRecordingNotification\(\); \}/);
  assert.match(hook, /recordingService\.isRecording\(\)/);
});
