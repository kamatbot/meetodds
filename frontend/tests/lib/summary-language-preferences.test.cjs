const { beforeEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const compile = file => ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const invokeMock = {
  calls: [],
  queue: [],
  mockReset() { this.calls = []; this.queue = []; },
  mockResolvedValueOnce(value) { this.queue.push({ value }); return this; },
  invoke(command, args) {
    this.calls.push({ command, args });
    const next = this.queue.shift();
    return Promise.resolve(next ? next.value : null);
  },
};

function loadPreferences() {
  const languages = {};
  vm.runInNewContext(compile('src/lib/summary-languages.ts'), { exports: languages });
  const exports = {};
  vm.runInNewContext(compile('src/lib/summary-language-preferences.ts'), {
    exports,
    require: name => {
      if (name === '@tauri-apps/api/core') return { invoke: invokeMock.invoke.bind(invokeMock) };
      if (name === '@/lib/summary-languages') return languages;
      throw new Error(`Unmocked module: ${name}`);
    },
    window: global.window,
    console,
  });
  return exports;
}

function installLocalStorage() {
  const values = new Map();
  global.window = {
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
      clear: () => values.clear(),
    },
  };
  return values;
}

function installFailingLocalStorage() {
  global.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => { throw new Error('quota exceeded'); },
      removeItem: () => {},
      clear: () => {},
    },
  };
}

describe('summary language local fallback', () => {
  let storageValues;

  beforeEach(() => {
    invokeMock.mockReset();
    storageValues = installLocalStorage();
  });

  test('reads summary language from local fallback when meeting has no folder', async () => {
    const prefs = loadPreferences();
    storageValues.set('summaryLanguageFallback:meeting-1', 'fr');
    invokeMock.mockResolvedValueOnce({ language: null, storage: 'local_fallback' });
    await assert.doesNotReject(async () => {
      assert.deepEqual(JSON.parse(JSON.stringify(await prefs.readMeetingSummaryLanguage('meeting-1'))), { language: 'fr', storage: 'local_fallback' });
    });
  });

  test('saves summary language locally when command reports no folder', async () => {
    const prefs = loadPreferences();
    invokeMock.mockResolvedValueOnce({ language: null, storage: 'local_fallback' });
    assert.deepEqual(JSON.parse(JSON.stringify(await prefs.saveMeetingSummaryLanguage('meeting-1', 'es'))), { language: 'es', storage: 'local_fallback' });
    assert.equal(storageValues.get('summaryLanguageFallback:meeting-1'), 'es');
  });

  test('clears local fallback when Auto is saved for a folderless meeting', async () => {
    const prefs = loadPreferences();
    storageValues.set('summaryLanguageFallback:meeting-1', 'de');
    invokeMock.mockResolvedValueOnce({ language: null, storage: 'local_fallback' });
    assert.deepEqual(JSON.parse(JSON.stringify(await prefs.saveMeetingSummaryLanguage('meeting-1', null))), { language: null, storage: 'local_fallback' });
    assert.equal(storageValues.has('summaryLanguageFallback:meeting-1'), false);
  });

  test('caches detected language locally when meeting has no folder', async () => {
    const prefs = loadPreferences();
    invokeMock.mockResolvedValueOnce({ language: null, storage: 'local_fallback' });
    await prefs.saveCachedDetectedSummaryLanguage('meeting-1', 'pt');
    assert.equal(storageValues.get('detectedSummaryLanguageFallback:meeting-1'), 'pt');
  });

  test('rejects when folderless summary language cannot be persisted locally', async () => {
    installFailingLocalStorage();
    const prefs = loadPreferences();
    invokeMock.mockResolvedValueOnce({ language: null, storage: 'local_fallback' });
    await assert.rejects(prefs.saveMeetingSummaryLanguage('meeting-1', 'it'), /Failed to save summary language on this device/);
  });
});
