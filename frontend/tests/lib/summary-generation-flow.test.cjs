// Runs the actual generation hook and consent helpers with deterministic hook/IPC
// doubles. This is not React DOM, a model benchmark, or a native end-to-end test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const compile = relative => ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, reportDiagnostics: true,
}).outputText;
function harness(options = {}) {
  const slots = []; let cursor = 0; let dirty = true; let effects = []; let result;
  const calls = []; const reviews = []; const painted = []; const toasts = [];
  let current = options.initial || { status: 'idle', data: null };
  let poll;
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const config = options.config || { provider: 'openai-codex', model: 'chosen-model', ollamaEndpoint: null };
  const turns = [{ id: 't1', text: 'We agreed to revise the report.', audio_start_time: 0 }, { id: 't2', text: 'Alex will send it on Friday.', audio_start_time: 10 }];
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, next => { const value = typeof next === 'function' ? next(slots[i].value) : next; if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; if (!slots[i]) slots[i] = { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { deps, value: fn }; return slots[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !equal(slots[i].deps, deps)) { const old = slots[i]; slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const sidebar = { startSummaryPolling(id, process, callback) { poll = callback; }, stopSummaryPolling() { poll = null; } };
  const modules = {
    react,
    '@tauri-apps/api/core': { async invoke(command, args) {
      calls.push({ command, args });
      if (options.onInvoke) await options.onInvoke(command, args, storage);
      switch (command) {
        case 'api_get_summary': return current;
        case 'api_get_model_config': return { ...config };
        case 'is_recording': return options.recording || false;
        case 'builtin_ai_is_model_ready': return options.modelReady !== false;
        case 'api_get_meeting_transcripts': return options.incomplete ? { transcripts: [turns[0]], total_count: 2, has_more: true } : { transcripts: args.limit === 1 ? [turns[0]] : turns, total_count: 2, has_more: args.limit === 1 };
        case 'api_get_meeting_notes': return { notesMarkdown: 'PRIVATE OBSERVATION' };
        case 'api_get_manual_notes': if (options.notesError) throw Error('notes unavailable'); return { content: 'MEETING NOTE' };
        case 'api_process_transcript': current = { ...current, status: 'processing' }; return { process_id: 'p1' };
        case 'api_refresh_meeting_intelligence': if (options.projectionError) throw Error('disk busy'); return { actions: [] };
        case 'api_cancel_summary': current = { ...current, status: 'cancelled' }; return { message: 'Cancelled' };
        default: throw Error(`Unmocked invocation: ${command}`);
      }
    } },
    sonner: { toast: Object.fromEntries(['info','warning','error'].map(kind => [kind, (...args) => toasts.push({ kind, args })])) },
    '@/components/Sidebar/SidebarProvider': { useSidebar: () => sidebar },
    '@/lib/speaker-labels': { withSpeakerPrefix: (_turn, text) => text },
    '@/services/momentNotesService': { flushOpenNotes: () => options.flushNotes?.(storage) || Promise.resolve(), getMomentNotesSummary: async () => ({ content: 'LINKED NOTE' }) },
    '@/lib/summary-language-preferences': { readMeetingSummaryLanguage: async () => { await options.beforeLanguage?.(storage); return { language: 'en' }; }, readCachedDetectedSummaryLanguage: async () => null, detectAndCacheSummaryLanguage: async () => ({ language: 'en' }) },
  };
  const load = id => {
    if (modules[id]) return modules[id];
    const name = id.replace(/^@\/lib\//, '').replace(/^\.\//, '');
    if (!['summary-input','post-meeting-flow'].includes(name)) throw Error(`Unmocked module: ${id}`);
    const exports = {};
    vm.runInNewContext(compile(`src/lib/${name}.ts`), { exports, require: load, URL });
    modules[id] = exports; return exports;
  };
  const input = load('@/lib/summary-input');
  const flow = load('@/lib/post-meeting-flow');
  modules['@/components/Meeting/SummaryInputReview'] = { reviewSummaryInput: async (snapshot, signal) => {
    reviews.push(snapshot);
    if (options.review) return options.review(snapshot, signal, input);
    return input.approveSummaryInput(snapshot, false, '', true);
  } };
  const exports = {};
  vm.runInNewContext(compile('src/hooks/meeting-details/useSummaryGeneration.ts'), {
    exports, require: load, localStorage: storage, AbortController,
    window: { dispatchEvent: () => true }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  });
  const props = { meeting: { id: 'meeting-a', created_at: '2026-09-11' }, transcripts: turns,
    modelConfig: { provider: 'ollama', model: 'STARTUP DEFAULT' }, isModelConfigLoading: false,
    selectedTemplate: 'standard_meeting', updateMeetingTitle: () => {}, setAiSummary: value => painted.push(value),
  };
  const render = () => { let n = 0; while (dirty) { if (++n > 40) throw Error('Render loop'); dirty = false; cursor = 0; effects = []; result = exports.useSummaryGeneration(props); effects.forEach(fn => fn()); } };
  const flush = async () => { for (let n = 0; n < 40; n++) { render(); await Promise.resolve(); } render(); };
  return {
    flush, calls, reviews, painted, toasts, storage, config, flow,
    get value() { return result; },
    get jobs() { return calls.filter(c => c.command === 'api_process_transcript'); },
    get projections() { return calls.filter(c => c.command === 'api_refresh_meeting_intelligence'); },
    approveAuto(notes = false) { storage.setItem('isAutoSummary', 'true'); flow.saveAutoSummaryApproval(storage, input.summaryTarget(config.provider, config.model), notes); },
    async start(automatic = false) { await result.handleGenerateSummary('', { automatic }); await flush(); },
    async finish(envelope) { current = envelope; await poll?.(envelope); await flush(); },
  };
}
test('manual generation uses one reviewed AI request and no actions before completion', async () => {
  const h = harness(); await h.flush(); await h.start();
  assert.equal(h.jobs.length, 1); assert.equal(h.reviews.length, 1); assert.equal(h.projections.length, 0);
  assert.equal(h.jobs[0].args.model, 'openai-codex'); assert.equal(h.jobs[0].args.modelName, 'chosen-model');
  assert.match(h.jobs[0].args.customPrompt, /meetodds:actions/);
  await h.finish({ status: 'processing' }); assert.equal(h.projections.length, 0);
  await h.finish({ status: 'completed', data: { markdown: '## Actions\n- Send the report.' } });
  assert.equal(h.projections.length, 1); assert.equal(h.value.summaryStatus, 'completed');
});
test('automatic consent bypasses review but never includes private notes', async () => {
  const h = harness(); h.approveAuto(false); await h.flush(); await h.start(true);
  assert.equal(h.jobs.length, 1); assert.equal(h.reviews.length, 0);
  assert.doesNotMatch(h.jobs[0].args.text, /PRIVATE OBSERVATION|MEETING NOTE|LINKED NOTE/);
});
test('automatic meeting notes are included only under their remembered approval', async () => {
  const h = harness(); h.approveAuto(true); await h.flush(); await h.start(true);
  assert.match(h.jobs[0].args.text, /MEETING NOTE/); assert.doesNotMatch(h.jobs[0].args.text, /PRIVATE OBSERVATION/);
});
test('changed destination/model requires a new review and cancel sends nothing', async () => {
  const h = harness({ review: async () => null }); h.approveAuto(); h.config.model = 'new-model';
  await h.flush(); await h.start(true); assert.equal(h.reviews.length, 1); assert.equal(h.jobs.length, 0);
});
test('revoking automatic choice during preparation sends nothing', async () => {
  const h = harness({ flushNotes: async storage => storage.setItem('isAutoSummary', 'false') });
  h.approveAuto(); await h.flush(); await h.start(true); assert.equal(h.jobs.length, 0); assert.equal(h.reviews.length, 0);
});
test('revoking included-note consent just before dispatch sends nothing', async () => {
  const h = harness({ beforeLanguage: async storage => storage.setItem('meetodds.autoSummaryApproval.v1', 'null') });
  h.approveAuto(true); await h.flush(); await h.start(true); assert.equal(h.jobs.length, 0);
});
test('opening a meeting with an existing native job resumes without resubmission', async () => {
  const h = harness({ initial: { status: 'processing', data: null } }); await h.flush();
  assert.equal(h.value.summaryStatus, 'summarizing'); await h.start(true); assert.equal(h.jobs.length, 0);
  await h.finish({ status: 'completed', data: { markdown: '## Outcome\nDone.' } }); assert.equal(h.projections.length, 1);
});
test('unapproved automatic requests do not run after preference is disabled', async () => {
  const h = harness(); await h.flush(); await h.start(true); assert.equal(h.jobs.length, 0); assert.equal(h.reviews.length, 0);
});
test('incomplete transcript or unavailable notes fail before model dispatch', async () => {
  for (const settings of [{ incomplete: true }, { notesError: true }]) {
    const h = harness(settings); await h.flush(); await h.start();
    assert.equal(h.jobs.length, 0); assert.equal(h.value.summaryStatus, 'error');
  }
});
test('local models cannot contend with an active recording', async () => {
  const h = harness({ recording: true, config: { provider: 'builtin-ai', model: 'local-model' } });
  await h.flush(); await h.start(); assert.equal(h.jobs.length, 0); assert.equal(h.reviews.length, 0);
});
test('failed or empty provider output never projects new actions', async () => {
  for (const envelope of [{ status: 'failed', error: 'offline' }, { status: 'completed', data: {} }]) {
    const h = harness(); await h.flush(); await h.start(); await h.finish(envelope);
    assert.equal(h.projections.length, 0); assert.equal(h.value.summaryStatus, 'error');
  }
});
test('projection failure preserves the completed AI document and surfaces a warning', async () => {
  const h = harness({ projectionError: true }); await h.flush(); await h.start();
  await h.finish({ status: 'completed', data: { markdown: '## Outcome\nAgreed a plan.' } });
  assert.equal(h.value.summaryStatus, 'completed'); assert.equal(h.painted.at(-1).markdown, '## Outcome\nAgreed a plan.');
  assert.ok(h.toasts.some(t => t.kind === 'warning'));
});
test('rapid manual clicks cannot submit duplicate generation jobs', async () => {
  const h = harness(); await h.flush();
  await Promise.all([h.value.handleGenerateSummary(''), h.value.handleGenerateSummary('')]); await h.flush();
  assert.equal(h.jobs.length, 1);
});
