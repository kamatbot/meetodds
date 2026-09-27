const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = (loaded, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  loaded._compile(compiled.outputText, filename);
};

const setupPath = path.resolve(__dirname, '../../src/lib/onboarding-setup.ts');
const setup = require(setupPath);
const { summaryTarget } = require(path.resolve(__dirname, '../../src/lib/summary-input.ts'));
const { readAutoSummaryApproval, AUTO_SUMMARY_APPROVAL_KEY } = require(path.resolve(__dirname, '../../src/lib/post-meeting-flow.ts'));

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('legacy wizard steps map into two stages and completed users remain complete', () => {
  for (const step of [1, 2, 3]) {
    assert.deepEqual(setup.resolveOnboardingProgress({ version: '1.0', completed: false, current_step: step }), {
      currentStep: 1,
      completed: false,
    });
  }
  assert.deepEqual(setup.resolveOnboardingProgress({ version: '1.0', completed: false, current_step: 4 }), {
    currentStep: 2,
    completed: false,
  });
  assert.deepEqual(setup.resolveOnboardingProgress({ version: '1.0', completed: true, current_step: 4 }), {
    currentStep: 2,
    completed: true,
  });
  assert.equal(setup.resolveOnboardingProgress({ version: '2.0', completed: false, current_step: 2 }).currentStep, 2);
  const storage = memoryStorage();
  assert.equal(setup.hasSavedSummaryApproval(storage, 'builtin-ai', 'qwen3.5:4b'), false);
  assert.equal(storage.getItem('isAutoSummary'), null);
  const permissions = fs.readFileSync(path.resolve(__dirname, '../../src/components/onboarding/steps/PermissionsStep.tsx'), 'utf8');
  assert.match(permissions, /goPrevious/);
});

test('choosing a summary destination persists only that choice, never consent', () => {
  const storage = memoryStorage();
  setup.saveSummaryDestination(storage, 'chatgpt');
  assert.equal(setup.readSummaryDestination(storage), 'chatgpt');
  assert.equal(storage.getItem('isAutoSummary'), null);
  assert.equal(storage.getItem(AUTO_SUMMARY_APPROVAL_KEY), null);
  setup.saveSummaryDestination(storage, 'local');
  assert.equal(setup.readSummaryDestination(storage), 'local');
  assert.equal(storage.getItem('isAutoSummary'), null);
});

test('failed ChatGPT auth never saves configuration or automatic-summary approval', async () => {
  const storage = memoryStorage();
  let saved = false;
  let autoSummary = false;
  await assert.rejects(setup.commitSummaryDestination({
    storage,
    destination: 'chatgpt',
    authenticated: false,
    availableModels: ['gpt-5.6-sol'],
    persistAndReadConfiguration: async () => { saved = true; return { provider: 'openai-codex', model: 'gpt-5.6-sol' }; },
    setAutoSummary: (enabled) => { autoSummary = enabled; },
  }), /Connect your ChatGPT account/);
  assert.equal(saved, false);
  assert.equal(autoSummary, false);
  assert.equal(storage.getItem('isAutoSummary'), null);
  assert.equal(storage.getItem(AUTO_SUMMARY_APPROVAL_KEY), null);
});

test('failed or mismatched provider config never writes consent', async () => {
  const failedStorage = memoryStorage();
  await assert.rejects(setup.commitSummaryDestination({
    storage: failedStorage,
    destination: 'chatgpt',
    authenticated: true,
    availableModels: ['gpt-5.6-sol'],
    persistAndReadConfiguration: async () => { throw new Error('save failed'); },
    setAutoSummary: () => assert.fail('consent must not be enabled'),
  }), /save failed/);
  assert.equal(failedStorage.getItem(AUTO_SUMMARY_APPROVAL_KEY), null);

  const mismatchStorage = memoryStorage();
  await assert.rejects(setup.commitSummaryDestination({
    storage: mismatchStorage,
    destination: 'chatgpt',
    authenticated: true,
    availableModels: ['gpt-5.6-sol'],
    persistAndReadConfiguration: async () => ({ provider: 'openai-codex', model: 'other-model' }),
    setAutoSummary: () => assert.fail('consent must not be enabled'),
  }), /did not match/);
  assert.equal(mismatchStorage.getItem(AUTO_SUMMARY_APPROVAL_KEY), null);
});

test('successful ChatGPT consent uses the verified available model and bound target', async () => {
  const storage = memoryStorage();
  let autoSummary = false;
  const committed = await setup.commitSummaryDestination({
    storage,
    destination: 'chatgpt',
    authenticated: true,
    availableModels: [{ id: ' ' }, { id: 'gpt-5.6-terra' }, { id: 'gpt-5.6-sol' }],
    persistAndReadConfiguration: async (provider, model) => ({ provider, model }),
    setAutoSummary: (enabled) => {
      autoSummary = enabled;
      storage.setItem('isAutoSummary', String(enabled));
    },
  });
  assert.equal(committed.model, 'gpt-5.6-terra');
  assert.equal(committed.target.destination, 'https://chatgpt.com/backend-api/codex');
  assert.equal(autoSummary, true);
  assert.deepEqual(readAutoSummaryApproval(storage, summaryTarget('openai-codex', 'gpt-5.6-terra')),
    { version: 1, target: committed.target, includeManualNotes: true });
});

test('an existing available ChatGPT model remains the actual selected target', async () => {
  const storage = memoryStorage();
  const committed = await setup.commitSummaryDestination({
    storage,
    destination: 'chatgpt',
    authenticated: true,
    availableModels: ['gpt-5.6-terra', 'gpt-5.6-sol'],
    model: 'gpt-5.6-sol',
    persistAndReadConfiguration: async (provider, model) => ({ provider, model }),
    setAutoSummary: () => {},
  });
  assert.equal(committed.model, 'gpt-5.6-sol');
  assert.equal(committed.target.model, 'gpt-5.6-sol');
});

test('local consent binds only after builtin model configuration is saved', async () => {
  const storage = memoryStorage();
  let autoSummary = false;
  const committed = await setup.commitSummaryDestination({
    storage,
    destination: 'local',
    authenticated: false,
    model: 'qwen3.5:4b',
    persistAndReadConfiguration: async (provider, model) => ({ provider, model }),
    setAutoSummary: (enabled) => {
      autoSummary = enabled;
      storage.setItem('isAutoSummary', String(enabled));
    },
  });
  assert.equal(committed.target.local, true);
  assert.equal(committed.target.model, 'qwen3.5:4b');
  assert.equal(autoSummary, true);
  assert.ok(readAutoSummaryApproval(storage, committed.target));
});

test('capture readiness requires writable storage, real usable sources, silence acknowledgement and informed consent', () => {
  const result = {
    microphone: { deviceName: 'Built-in Microphone', status: 'signal' },
    systemAudio: { deviceName: 'MacBook Speakers', status: 'signal' },
    storageWritable: true,
    recordingFolder: '/Users/test/MeetOdds',
    storageMessage: 'Temporary local file write succeeded.',
    audioRetained: true,
  };
  assert.deepEqual(setup.resolveApprovedCaptureChoice(result, true, false, true), {
    microphone: 'Built-in Microphone',
    systemAudio: 'MacBook Speakers',
  });
  assert.deepEqual(setup.resolveApprovedCaptureChoice(result, false, false, true), {
    microphone: 'Built-in Microphone',
    systemAudio: null,
  });
  assert.equal(setup.resolveApprovedCaptureChoice({ ...result, storageWritable: false }, true, false, true), null);
  assert.equal(setup.resolveApprovedCaptureChoice({ ...result, recordingFolder: '' }, true, false, true), null);
  assert.equal(setup.resolveApprovedCaptureChoice({ ...result, audioRetained: undefined }, true, false, true), null);
  assert.equal(setup.resolveApprovedCaptureChoice({ ...result, microphone: { deviceName: null, status: 'permission_denied' } }, false, false, true), null);
  assert.equal(setup.resolveApprovedCaptureChoice({ ...result, systemAudio: { deviceName: 'MacBook Speakers', status: 'no_frames' } }, true, false, true), null);
  assert.equal(setup.resolveApprovedCaptureChoice({ ...result, microphone: { deviceName: 'Built-in Microphone', status: 'silent' } }, false, false, true), null);
  assert.equal(setup.resolveApprovedCaptureChoice({ ...result, microphone: { deviceName: 'Built-in Microphone', status: 'silent' } }, false, true, true)?.microphone, 'Built-in Microphone');
  assert.equal(setup.resolveApprovedCaptureChoice(result, true, false, false), null);
});

test('tested capture identity includes both configured sources and explicit microphone-only choice', () => {
  const selection = { microphone: null, systemAudio: 'USB Audio', includeSystem: false };
  assert.equal(setup.sameCaptureSelection(selection, { ...selection }), true);
  assert.equal(setup.sameCaptureSelection(selection, { ...selection, includeSystem: true }), false);
  assert.equal(setup.sameCaptureSelection(selection, { ...selection, microphone: 'Other Mic' }), false);
});

test('model readiness uses the exact selected model and respects destination requirements', () => {
  const models = [
    { name: 'parakeet-other', status: 'Available' },
    { name: 'parakeet-tdt-0.6b-v3-int8', status: { Downloading: 99 } },
  ];
  assert.equal(setup.isExactModelAvailable(models, 'parakeet-tdt-0.6b-v3-int8'), false);
  assert.equal(setup.isExactModelAvailable([...models, { name: 'parakeet-tdt-0.6b-v3-int8', status: 'Available' }], 'parakeet-tdt-0.6b-v3-int8'), true);
  assert.equal(setup.onboardingModelsReady('local', true, false), false);
  assert.equal(setup.onboardingModelsReady('local', true, true), true);
  assert.equal(setup.onboardingModelsReady('chatgpt', true, false), true);
  assert.equal(setup.onboardingModelsReady('chatgpt', false, true), false);
});

test('failed automatic model startup is one-shot per target while explicit retry still runs', async () => {
  const gate = setup.createDownloadStartGate();
  let starts = 0;
  const fail = () => {
    starts += 1;
    return Promise.reject(new Error('download failed'));
  };

  await assert.rejects(gate.startOnce('builtin-ai:qwen3.5:4b', fail), /download failed/);
  assert.equal(gate.startOnce('builtin-ai:qwen3.5:4b', fail), null);
  assert.equal(starts, 1, 'a provider rerender after failure must not restart the same target');

  await gate.retry(async () => {
    starts += 1;
  });
  assert.equal(starts, 2, 'the explicit Retry action bypasses the startup one-shot');
  assert.equal(gate.startOnce('builtin-ai:qwen3.5:4b', fail), null);
  assert.ok(gate.startOnce('builtin-ai:qwen3.5:2b', async () => undefined), 'a new exact model gets its own startup attempt');

  const context = fs.readFileSync(path.resolve(__dirname, '../../src/contexts/OnboardingContext.tsx'), 'utf8');
  assert.match(context, /downloadStartGateRef = useRef/);
  assert.match(context, /const startBackgroundDownloads = useCallback/);
  assert.match(context, /startOnce\(`parakeet:\$\{PARAKEET_MODEL\}`/);
  assert.match(context, /startOnce\(`builtin-ai:\$\{summaryModel\}`/);
  assert.match(context, /downloadStartGateRef\.current!\.retry\(\(\) => invoke\('parakeet_retry_download'/);
  assert.match(context, /downloadStartGateRef\.current!\.retry\(\(\) => requestSummaryModelDownload\(modelName\)\)/);
});

test('onboarding exposes exactly two stages and capture preflight runs only after an explicit action', () => {
  const root = path.resolve(__dirname, '../../src/components/onboarding');
  const flow = fs.readFileSync(path.join(root, 'OnboardingFlow.tsx'), 'utf8');
  const welcome = fs.readFileSync(path.join(root, 'steps/WelcomeStep.tsx'), 'utf8');
  const permissions = fs.readFileSync(path.join(root, 'steps/PermissionsStep.tsx'), 'utf8');
  assert.match(flow, /currentStep === 1/);
  assert.match(flow, /currentStep === 2/);
  assert.doesNotMatch(flow, /currentStep === [34]/);
  assert.doesNotMatch(flow, /SetupOverviewStep|DownloadProgressStep/);
  assert.match(welcome, /totalSteps=\{2\}/);
  assert.match(permissions, /totalSteps=\{2\}/);
  assert.match(permissions, /invoke<CapturePreflight>\('run_capture_preflight'/);
  assert.match(permissions, /saveApprovedCapture\(/);
  assert.match(permissions, /loadApprovedCapture\(/);
  assert.match(permissions, /disabled=\{!approvedCapture \|\| !modelsReady \|\| busy !== null\}/);
  assert.match(permissions, /completeOnboarding\(\(\) =>/);
  assert.match(permissions, /setTranscriptModelConfig\(\{ provider: 'parakeet'/);
  const context = fs.readFileSync(path.resolve(__dirname, '../../src/contexts/OnboardingContext.tsx'), 'utf8');
  assert.match(context, /api_get_model_config/);
  assert.match(context, /builtin_ai_is_model_ready/);
  assert.match(context, /hasSavedSummaryApproval/);
  assert.match(context, /api_get_transcript_config/);
  assert.match(context, /isExactModelAvailable\(models, PARAKEET_MODEL\)/);
  const effects = permissions.match(/useEffect\([\s\S]*?\n  \}, \[[^\]]*\]\);/g) || [];
  assert.ok(effects.every((effect) => !effect.includes('run_capture_preflight')));
});
