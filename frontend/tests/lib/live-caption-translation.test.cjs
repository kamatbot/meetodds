// Deterministic hook/IPC harness: exercises real hook logic without native AI or React DOM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const compile = file => ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const helpers = {};
vm.runInNewContext(compile('src/lib/live-captions.ts'), { exports: helpers });
const settings = { enabled: true, sourceLanguage: 'auto', targetLanguage: 'en', displayMode: 'bilingual', speed: 'instant', engine: 'auto', contextTurns: 2, modelOverride: '', glossary: '', contextHint: '' };
const speech = (revision = 1, patch = {}) => ({ text: `Buenos días ${revision}`, source: 'microphone', speaker: 'me', speakerLabel: 'Me', revision, audioStartTime: 1, audioEndTime: 3 + revision / 2, latencyMs: 50, ...patch });
function harness() {
  const slots = []; let cursor = 0; let dirty = true; let effects = []; let result;
  let inputs = [[], speech(), 'meeting-a'];
  const listeners = new Map(); const jobs = []; const cancelled = [];
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, next => { const value = typeof next === 'function' ? next(slots[i].value) : next; if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; if (!slots[i]) slots[i] = { current: initial }; return slots[i]; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !equal(slots[i].deps, deps)) { const previous = slots[i]; slots[i] = { deps, cleanup: previous?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const modules = {
    react,
    '@tauri-apps/api/core': { invoke(command, args) {
      if (command === 'api_translate_live_text') return new Promise((resolve, reject) => jobs.push({ args, resolve, reject }));
      if (command === 'api_prepare_live_translation') return Promise.resolve({ provider: 'openai-codex', model: 'account-model', warmed: false });
      if (command === 'api_cancel_live_translation') { cancelled.push(args.requestId); return Promise.resolve(true); }
      return Promise.resolve();
    } },
    '@tauri-apps/api/event': { listen: async (name, handler) => { listeners.set(name, handler); return () => listeners.delete(name); } },
    '@/lib/live-captions': helpers,
    '@/lib/live-translation': { DEFAULT_LIVE_TRANSLATION_SETTINGS: { ...settings, enabled: false }, loadLiveTranslationSettings: () => ({ ...settings }), saveLiveTranslationSettings: () => {}, liveTranslationSegmentKey: t => t.sequence_id === undefined ? t.id : `sequence-${t.sequence_id}` },
  };
  const exported = {};
  vm.runInNewContext(compile('src/hooks/useLiveTranslation.ts'), { exports: exported, require: name => { if (!modules[name]) throw Error(`Unmocked module ${name}`); return modules[name]; }, queueMicrotask, console });
  const render = () => { let count = 0; while (dirty) { if (++count > 50) throw Error('Render loop'); dirty = false; cursor = 0; effects = []; result = exported.useLiveTranslation(...inputs); effects.forEach(fn => fn()); } };
  const flush = async () => { for (let i = 0; i < 10; i++) { render(); await Promise.resolve(); } render(); };
  return {
    flush, jobs, cancelled, get value() { return result; },
    async input(preview, session = inputs[2], transcripts = inputs[0]) { inputs = [transcripts, preview, session]; dirty = true; await flush(); },
    async update(patch) { result.updateSettings(patch); await flush(); },
    async delta(job, text) { listeners.get('live-translation-delta')?.({ payload: { requestId: job.args.requestId, text, provider: 'mock' } }); await flush(); },
    async status(job, payload) { listeners.get('live-translation-status')?.({ payload: { requestId: job.args.requestId, ...payload } }); await flush(); },
    async finish(job, text = 'Good morning') { job.resolve({ translatedText: text, targetLanguage: job.args.targetLanguage, provider: 'mock', model: 'mock', latencyMs: 800, firstWordLatencyMs: 600, cached: false }); await flush(); },
    async fail(job, message = 'provider timeout') { job.reject(new Error(message)); await flush(); },
    async retry() { result.retryPreviewTranslation(); await flush(); },
  };
}
test('auto mode allows a balanced timeout budget without delaying fast streamed output', async () => {
  const h = harness(); await h.flush(); assert.equal(h.jobs[0].args.speedMode, 'balanced');
});
test('a slow in-flight translation survives successive ASR revisions', async () => {
  const h = harness(); await h.flush(); const first = h.jobs[0]; assert.ok(first);
  await h.input(speech(2)); await h.input(speech(3));
  assert.equal(h.jobs.length, 1, 'coalesces new previews rather than parallel duplicate inference');
  await h.delta(first, 'Good'); assert.equal(h.value.previewTranslation.translatedText, 'Good');
  await h.finish(first, 'Good morning');
  assert.equal(h.jobs.length, 2); assert.equal(h.jobs[1].args.text, speech(3).text);
  assert.equal(h.value.previewTranslation.translatedText, 'Good morning', 'keeps the last target-language phrase while newer words translate');
});
test('fallback status does not erase already translated target-language text', async () => {
  const h = harness(); await h.flush(); const first = h.jobs[0];
  await h.delta(first, 'Good morning');
  await h.status(first, { event: 'fallback', reason: 'slow provider', nextProvider: 'backup', nextModel: 'fast' });
  assert.equal(h.value.previewTranslation.translatedText, 'Good morning');
  assert.equal(h.value.previewTranslation.status, 'translating');
});
test('a failed preview exposes retry and retry starts a fresh request', async () => {
  const h = harness(); await h.flush(); const first = h.jobs[0];
  await h.fail(first, 'subscription stream timed out');
  assert.equal(h.value.previewTranslation.status, 'error');
  assert.match(h.value.lastError, /timed out/);
  await h.retry();
  assert.equal(h.jobs.length, 2);
  assert.notEqual(h.jobs[1].args.requestId, first.args.requestId);
});
test('source changes invalidate old translated words', async () => {
  const h = harness(); await h.flush(); const first = h.jobs[0];
  await h.input(speech(2, { source: 'system', audioStartTime: 10, audioEndTime: 12 }));
  assert.ok(h.cancelled.includes(first.args.requestId));
  await h.delta(first, 'Stale speaker'); assert.equal(h.value.previewTranslation, undefined);
  await h.finish(first, 'Stale speaker'); assert.notEqual(h.value.previewTranslation?.translatedText, 'Stale speaker');
});
test('language changes reject outstanding previous-language results', async () => {
  const h = harness(); await h.flush(); const first = h.jobs[0];
  await h.update({ targetLanguage: 'fr' }); await h.finish(first, 'Old English');
  assert.notEqual(h.value.previewTranslation?.translatedText, 'Old English');
  const next = h.jobs[h.jobs.length - 1]; assert.equal(next.args.targetLanguage, 'fr');
  await h.finish(next, 'Bonjour'); assert.equal(h.value.previewTranslation.translatedText, 'Bonjour');
});
test('hiding captions cancels preview work without generating source-language fallback', async () => {
  const h = harness(); await h.flush(); const first = h.jobs[0];
  await h.input(null); assert.ok(h.cancelled.includes(first.args.requestId));
  await h.finish(first); assert.equal(h.value.previewTranslation, undefined);
});
test('new session invalidates old jobs even for matching audio ranges', async () => {
  const h = harness(); await h.flush(); const first = h.jobs[0];
  await h.input(speech(1), 'meeting-b'); await h.finish(first, 'Previous meeting');
  assert.notEqual(h.value.previewTranslation?.translatedText, 'Previous meeting');
  assert.equal(h.jobs.length, 2);
});
test('canonical translation remains available when live preview clears', async () => {
  const h = harness(); await h.flush(); const first = h.jobs[0];
  const turn = { id: 'turn1', sequence_id: 8, text: 'Buenos días', speaker_label: 'Me' };
  await h.input(null, 'meeting-a', [turn]);
  const canonical = h.jobs.find(j => !j.args.requestId.startsWith('live-preview'));
  assert.ok(canonical); await h.finish(canonical, 'Good morning everyone');
  assert.equal(h.value.translations['sequence-8'].translatedText, 'Good morning everyone');
  await h.finish(first, 'Stale preview');
  assert.equal(h.value.previewTranslation, undefined);
});
