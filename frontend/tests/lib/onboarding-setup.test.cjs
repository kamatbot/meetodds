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

test('any saved version other than the current one safely resumes at step 1; completed always carries forward', () => {
  for (const version of ['1.0', '2.0', undefined]) {
    for (const step of [1, 2, 3, 4]) {
      assert.deepEqual(setup.resolveOnboardingProgress({ version, completed: false, current_step: step }), {
        currentStep: 1,
        completed: false,
      });
      assert.deepEqual(setup.resolveOnboardingProgress({ version, completed: true, current_step: step }), {
        currentStep: 1,
        completed: true,
      });
    }
  }
  assert.equal(setup.ONBOARDING_STATUS_VERSION, '3.0');
  assert.deepEqual(setup.resolveOnboardingProgress({ version: '3.0', completed: false, current_step: 2 }),
    { currentStep: 2, completed: false });
  assert.deepEqual(setup.resolveOnboardingProgress({ version: '3.0', completed: false, current_step: 3 }),
    { currentStep: 3, completed: false });
  // An out-of-range saved step for the current version still falls back to step 1 rather than crashing.
  assert.deepEqual(setup.resolveOnboardingProgress({ version: '3.0', completed: false, current_step: 9 }),
    { currentStep: 1, completed: false });

  const storage = memoryStorage();
  assert.equal(setup.hasSavedSummaryApproval(storage, 'apple-intelligence', 'system'), false);
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

test('local consent always uses the fixed Apple Intelligence provider and model, ignoring any model hint', async () => {
  // summary-input.ts's summaryTarget() is owned by the Apple Intelligence backend work
  // landing in a parallel branch, and does not have an 'apple-intelligence' branch yet
  // (see this test file's header comment / the task report for the merge note). Stub it
  // here, mirroring its existing 'builtin-ai' on-device branch exactly, so this test still
  // exercises commitSummaryDestination's real, full behavior without editing that file.
  const summaryInputPath = require.resolve(path.resolve(__dirname, '../../src/lib/summary-input.ts'));
  const summaryInputExports = require(summaryInputPath);
  const originalSummaryTarget = summaryInputExports.summaryTarget;
  summaryInputExports.summaryTarget = (provider, model, endpoint) => provider === 'apple-intelligence'
    ? { provider, model, destination: 'on-device', local: true, label: 'Apple Intelligence · on this device' }
    : originalSummaryTarget(provider, model, endpoint);

  const storage = memoryStorage();
  let autoSummary = false;
  let persistedProvider;
  let committed;
  try {
    committed = await setup.commitSummaryDestination({
      storage,
      destination: 'local',
      authenticated: false,
      model: 'ignored-model-hint',
      persistAndReadConfiguration: async (provider, model) => { persistedProvider = provider; return { provider, model }; },
      setAutoSummary: (enabled) => {
        autoSummary = enabled;
        storage.setItem('isAutoSummary', String(enabled));
      },
    });
  } finally {
    summaryInputExports.summaryTarget = originalSummaryTarget;
  }
  assert.equal(persistedProvider, 'apple-intelligence');
  assert.equal(committed.model, setup.APPLE_INTELLIGENCE_MODEL);
  assert.equal(committed.model, 'system');
  assert.equal(committed.target.local, true);
  assert.equal(autoSummary, true);
  assert.ok(readAutoSummaryApproval(storage, committed.target));
});

test('Apple Speech locale defaults to a supported system locale, otherwise en-US', () => {
  const locales = [{ id: 'en-US' }, { id: 'fr-FR' }, { id: 'de-DE' }];
  assert.equal(setup.defaultAppleSpeechLocale('fr-FR', locales), 'fr-FR');
  // Case and separator differences (as browsers/OS report locales) still match.
  assert.equal(setup.defaultAppleSpeechLocale('de_DE', locales), 'de-DE');
  assert.equal(setup.defaultAppleSpeechLocale('FR-fr', locales), 'fr-FR');
  // Unsupported, missing, or empty system locales all fall back to en-US.
  assert.equal(setup.defaultAppleSpeechLocale('ja-JP', locales), 'en-US');
  assert.equal(setup.defaultAppleSpeechLocale(null, locales), 'en-US');
  assert.equal(setup.defaultAppleSpeechLocale(undefined, locales), 'en-US');
  assert.equal(setup.defaultAppleSpeechLocale('en-US', []), 'en-US');
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

test('onboarding exposes exactly three stages: summary AI, spoken language, permissions', () => {
  const root = path.resolve(__dirname, '../../src/components/onboarding');
  const flow = fs.readFileSync(path.join(root, 'OnboardingFlow.tsx'), 'utf8');
  const welcome = fs.readFileSync(path.join(root, 'steps/WelcomeStep.tsx'), 'utf8');
  const language = fs.readFileSync(path.join(root, 'steps/LanguageStep.tsx'), 'utf8');
  const permissions = fs.readFileSync(path.join(root, 'steps/PermissionsStep.tsx'), 'utf8');
  assert.match(flow, /currentStep === 1/);
  assert.match(flow, /currentStep === 2/);
  assert.match(flow, /currentStep === 3/);
  assert.doesNotMatch(flow, /currentStep === 4/);
  assert.doesNotMatch(flow, /SetupOverviewStep|DownloadProgressStep/);
  assert.match(welcome, /totalSteps=\{3\}/);
  assert.match(language, /totalSteps=\{3\}/);
  assert.match(permissions, /totalSteps=\{3\}/);
  assert.match(permissions, /invoke<CapturePreflight>\('run_capture_preflight'/);
  assert.match(permissions, /saveApprovedCapture\(/);
  assert.match(permissions, /loadApprovedCapture\(/);
  assert.match(permissions, /disabled=\{!approvedCapture \|\| busy !== null\}/);
  assert.match(permissions, /completeOnboarding\(\(\) =>/);
  assert.match(permissions, /setTranscriptModelConfig\(\{ provider: 'appleSpeech', model: selectedLanguage/);
  const context = fs.readFileSync(path.resolve(__dirname, '../../src/contexts/OnboardingContext.tsx'), 'utf8');
  assert.match(context, /api_get_model_config/);
  assert.match(context, /hasSavedSummaryApproval/);
  assert.match(context, /api_get_transcript_config/);
  assert.match(context, /provider: 'appleSpeech'/);
  assert.match(context, /completed: true,/);
});

test("no owned onboarding file still references the removed Parakeet/Whisper/built-in-LLM download machinery", () => {
  const root = path.resolve(__dirname, '../../src');
  const files = [
    'components/onboarding/OnboardingFlow.tsx',
    'components/onboarding/OnboardingContainer.tsx',
    'components/onboarding/steps/WelcomeStep.tsx',
    'components/onboarding/steps/LanguageStep.tsx',
    'components/onboarding/steps/PermissionsStep.tsx',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /[Pp]arakeet/, `${file} must not reference Parakeet`);
    assert.doesNotMatch(source, /[Ww]hisper[^M]/, `${file} must not reference Whisper`);
    assert.doesNotMatch(source, /builtin-ai/, `${file} must not reference the removed built-in LLM provider`);
    assert.doesNotMatch(source, /qwen/i, `${file} must not reference Qwen`);
  }

  // OnboardingContext.tsx keeps writing the `parakeet`/`summary` JSON keys on every save:
  // the Rust ModelStatus struct (onboarding.rs, not owned by this change) requires them on
  // every deserialize with no #[serde(default)], so dropping the keys would break the save
  // call outright. The value is now always the inert placeholder 'not_applicable' — no
  // Parakeet feature, command, or model name is referenced any more.
  const context = fs.readFileSync(path.join(root, 'contexts/OnboardingContext.tsx'), 'utf8');
  assert.doesNotMatch(context, /parakeet_[a-z]+|PARAKEET_MODEL|DEFAULT_PARAKEET_MODEL|provider: 'parakeet'|parakeet-tdt/,
    'OnboardingContext.tsx must not reference any Parakeet command, constant, model name, or provider value');
  assert.match(context, /parakeet: 'not_applicable'/);
  assert.doesNotMatch(context, /[Ww]hisper[^M]/);
  assert.doesNotMatch(context, /builtin-ai/);
  assert.doesNotMatch(context, /qwen/i);
});

test('Apple Intelligence unavailability still leaves ChatGPT selectable, and the reason is shown', () => {
  const welcome = fs.readFileSync(path.resolve(__dirname, '../../src/components/onboarding/steps/WelcomeStep.tsx'), 'utf8');
  assert.match(welcome, /getAppleIntelligenceStatus/);
  assert.match(welcome, /appleIntelligenceAvailable = appleIntelligence\?\.available === true/);
  // The Apple Intelligence tile is disabled while unavailable...
  assert.match(welcome, /disabled=\{!appleIntelligenceAvailable\}/);
  // ...but the ChatGPT tile carries no such gate, and stays reachable via the same handler either way.
  const chatgptButtonBlock = welcome.slice(welcome.indexOf("chooseDestination('chatgpt')"), welcome.indexOf("chooseDestination('chatgpt')") + 400);
  assert.doesNotMatch(chatgptButtonBlock, /disabled=/);
  assert.match(welcome, /appleIntelligence\?\.reason/);
  // An unavailable status with no prior explicit choice steers a fresh user to ChatGPT instead of a dead end.
  assert.match(welcome, /!status\.available && !readSummaryDestination\(window\.localStorage\)/);
  assert.match(welcome, /selectSummaryDestination\('chatgpt'\)/);
});

test('Apple Speech preparation (asset download) runs only from an explicit button click, never automatically', () => {
  const language = fs.readFileSync(path.resolve(__dirname, '../../src/components/onboarding/steps/LanguageStep.tsx'), 'utf8');
  const permissions = fs.readFileSync(path.resolve(__dirname, '../../src/components/onboarding/steps/PermissionsStep.tsx'), 'utf8');
  // LanguageStep never calls apple_speech_prepare itself; it only wires the callback the
  // shared AppleSpeechSettings component invokes from its own explicit button handler.
  assert.doesNotMatch(language, /apple_speech_prepare|prepareAppleSpeech\(/);
  assert.match(language, /onPreparedLocale=/);
  for (const [file, source] of [['LanguageStep.tsx', language], ['PermissionsStep.tsx', permissions]]) {
    const effects = source.match(/useEffect\([\s\S]*?\n  \}, \[[^\]]*\]\);/g) || [];
    assert.ok(effects.every((effect) => !effect.includes('run_capture_preflight') && !effect.includes('prepareAppleSpeech') && !effect.includes('apple_speech_prepare')),
      `${file} must never trigger a download/preflight from inside a useEffect`);
  }
});

test('a user who already completed onboarding is marked completed regardless of the saved step, and skips it again', () => {
  // The saved contract layout.tsx reads (`get_onboarding_status().completed`) never changes:
  // any legacy or current version with completed=true must resolve to completed=true.
  for (const version of ['1.0', '2.0', '3.0', undefined]) {
    assert.equal(setup.resolveOnboardingProgress({ version, completed: true, current_step: 4 }).completed, true);
  }
  const context = fs.readFileSync(path.resolve(__dirname, '../../src/contexts/OnboardingContext.tsx'), 'utf8');
  // Loading a saved status always adopts its `completed` flag as-is.
  assert.match(context, /setCompleted\(progress\.completed\)/);
  // The auto-save effect must never fire once onboarding is already completed.
  assert.match(context, /if \(completed \|\| isCompletingRef\.current\) return;/);
});
