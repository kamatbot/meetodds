const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const compile = file => ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function harness(stored = null, nativeEnabled = true) {
  const calls = [];
  const storage = new Map(stored === null ? [] : [['meetodds.liveCaptions.visible', stored]]);
  const exported = {};
  vm.runInNewContext(compile('src/services/livePreviewPreference.ts'), {
    exports: exported,
    window: { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } },
    require: name => {
      if (name !== '@tauri-apps/api/core') throw Error(`Unmocked module ${name}`);
      return { invoke: (command, args) => { calls.push({ command, args }); return Promise.resolve(command === 'get_live_preview_enabled' ? nativeEnabled : undefined); } };
    },
  });
  return { ...exported, calls, storage };
}

test('legacy off migrates to native before recording can start', async () => {
  const h = harness('false');
  assert.equal(await h.hydrateLivePreviewPreference(), false);
  await h.ensureLivePreviewPreferenceSynced();
  assert.equal(JSON.stringify(h.calls), JSON.stringify([{ command: 'set_live_preview_enabled', args: { enabled: false } }]));
});

test('no legacy preference reads native state without a blind true reset', async () => {
  const h = harness(null, false);
  assert.equal(await h.hydrateLivePreviewPreference(), false);
  assert.equal(JSON.stringify(h.calls), JSON.stringify([{ command: 'get_live_preview_enabled' }]));
});

test('a rejected toggle reads and retains the actual native preference', async () => {
  const calls = [];
  const exported = {};
  vm.runInNewContext(compile('src/services/livePreviewPreference.ts'), {
    exports: exported,
    window: { localStorage: { getItem: () => null, setItem: () => {} } },
    require: () => ({ invoke: (command, args) => {
      calls.push({ command, args });
      if (command === 'set_live_preview_enabled' && args.enabled === false) return Promise.reject(new Error('write failed'));
      if (command === 'get_live_preview_enabled') return Promise.resolve(true);
      return Promise.resolve();
    } }),
  });
  assert.equal(await exported.setLivePreviewPreference(false), true);
  await exported.ensureLivePreviewPreferenceSynced();
  assert.equal(calls.at(-1).command, 'get_live_preview_enabled');
});

test('both recording start paths wait for the preference barrier', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const calls = [];
  const exported = {};
  vm.runInNewContext(compile('src/services/recordingService.ts'), {
    exports: exported,
    require: name => {
      if (name === '@tauri-apps/api/core') return { invoke: (command, args) => { calls.push({ command, args }); return Promise.resolve(); } };
      if (name === '@tauri-apps/api/event') return { listen: () => Promise.resolve(() => {}) };
      if (name === './livePreviewPreference') return { ensureLivePreviewPreferenceSynced: () => barrier };
      throw Error(`Unmocked module ${name}`);
    },
  });
  const service = new exported.RecordingService();
  const plain = service.startRecording();
  const configured = service.startRecordingWithDevices('Mic', null, 'Meeting');
  await Promise.resolve();
  assert.equal(calls.length, 0);
  release();
  await Promise.all([plain, configured]);
  assert.deepEqual(calls.map(call => call.command), ['start_recording', 'start_recording_with_devices_and_meeting']);
});

test('caption bridge removes the 30-per-minute heartbeat and cleans up its overlay', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/Captions/LiveCaptionBridge.tsx'), 'utf8');
  const provider = fs.readFileSync(path.join(root, 'src/contexts/LiveMeetingTranslationContext.tsx'), 'utf8');
  assert.equal(source.includes('setInterval('), false);
  assert.match(source, /lastPublishedEnabled\.current === false/);
  assert.match(source, /overlay\.current\?\.hide/);
  assert.match(provider, /captionsHydrated && captionsVisible \? livePreview : null/);
});

test('rapid off/on toggles serialize native writes and retain the final preference', async () => {
  const h = harness('true');
  await Promise.all([h.setLivePreviewPreference(false), h.setLivePreviewPreference(true)]);
  assert.deepEqual(h.calls.map(call => call.args?.enabled), [true, false, true]);
  assert.equal(h.storage.get('meetodds.liveCaptions.visible'), 'true');
});

test('a recovered failed toggle cannot leave storage stale after a queued successful toggle', async () => {
  const storage = new Map([['meetodds.liveCaptions.visible', 'true']]);
  const exported = {};
  vm.runInNewContext(compile('src/services/livePreviewPreference.ts'), {
    exports: exported,
    window: { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } },
    require: () => ({ invoke: (command, args) => {
      if (command === 'set_live_preview_enabled' && args.enabled === false) return Promise.reject(new Error('write failed'));
      if (command === 'get_live_preview_enabled') return Promise.resolve(false);
      return Promise.resolve();
    } }),
  });
  assert.deepEqual(await Promise.all([
    exported.setLivePreviewPreference(false),
    exported.setLivePreviewPreference(true),
  ]), [false, true]);
  assert.equal(storage.get('meetodds.liveCaptions.visible'), 'true', 'a reload reads the final confirmed native preference');
});

test('latest successful toggle re-enables hydrated caption consumers after interleaved sync work', () => {
  const source = fs.readFileSync(path.join(root, 'src/contexts/TranscriptContext.tsx'), 'utf8');
  assert.match(source, /if \(request === captionsRequestRef\.current\) \{[\s\S]*confirmedCaptionsVisibleRef\.current = actual;[\s\S]*setCaptionsHydrated\(true\);/);
  assert.match(source, /catch \{[\s\S]*if \(request !== captionsRequestRef\.current\) return;/);
});

test('a failed first toggle recovers in-chain before a queued second toggle and start barrier', async () => {
  let failFirst;
  const calls = [];
  const exported = {};
  vm.runInNewContext(compile('src/services/livePreviewPreference.ts'), {
    exports: exported,
    window: { localStorage: { getItem: () => 'true', setItem: () => {} } },
    require: () => ({ invoke: (command, args) => {
      calls.push({ command, args });
      if (command === 'set_live_preview_enabled' && args.enabled === false) {
        return new Promise((resolve, reject) => { failFirst = reject; });
      }
      if (command === 'get_live_preview_enabled') return Promise.resolve(false);
      return Promise.resolve();
    } }),
  });
  const off = exported.setLivePreviewPreference(false);
  const on = exported.setLivePreviewPreference(true);
  let started = false;
  const barrier = exported.ensureLivePreviewPreferenceSynced().then(() => { started = true; });
  for (let i = 0; i < 50 && !failFirst; i++) await Promise.resolve();
  assert.equal(started, false);
  assert.equal(typeof failFirst, 'function');
  failFirst(new Error('write failed'));
  assert.equal(await off, false);
  assert.equal(await on, true);
  await barrier;
  assert.equal(started, true);
  assert.deepEqual(calls.map(call => [call.command, call.args?.enabled]), [
    ['set_live_preview_enabled', true],
    ['set_live_preview_enabled', false],
    ['get_live_preview_enabled', undefined],
    ['set_live_preview_enabled', true],
  ]);
});

test('native hydration failure fails closed and blocks the recording-start barrier', async () => {
  const calls = [];
  const exported = {};
  vm.runInNewContext(compile('src/services/livePreviewPreference.ts'), {
    exports: exported,
    window: { localStorage: { getItem: () => null, setItem: () => {} } },
    require: () => ({ invoke: command => {
      calls.push(command);
      return Promise.reject(new Error('native unavailable'));
    } }),
  });
  await assert.rejects(exported.hydrateLivePreviewPreference(), /native unavailable/);
  await assert.rejects(exported.ensureLivePreviewPreferenceSynced(), /native unavailable/);
  assert.deepEqual(calls, ['get_live_preview_enabled']);
});

test('a failed write and failed recovery read rejects start until explicit retry succeeds', async () => {
  let recover = false;
  let getCount = 0;
  const calls = [];
  const exported = {};
  vm.runInNewContext(compile('src/services/livePreviewPreference.ts'), {
    exports: exported,
    window: { localStorage: { getItem: () => null, setItem: () => {} } },
    require: () => ({ invoke: (command, args) => {
      calls.push({ command, args });
      if (command === 'get_live_preview_enabled') {
        getCount += 1;
        return (getCount === 1 || recover) ? Promise.resolve(true) : Promise.reject(new Error('read failed'));
      }
      if (command === 'set_live_preview_enabled') return Promise.reject(new Error('write failed'));
      return Promise.reject(new Error('unexpected command'));
    } }),
  });
  await exported.hydrateLivePreviewPreference();
  const toggle = exported.setLivePreviewPreference(false);
  await assert.rejects(toggle, /read failed/);
  await assert.rejects(exported.ensureLivePreviewPreferenceSynced(), /read failed/);
  recover = true;
  assert.equal(await exported.retryLivePreviewPreferenceHydration(), true);
  await exported.ensureLivePreviewPreferenceSynced();
  assert.equal(calls.filter(call => call.command === 'get_live_preview_enabled').length, 3);
});
