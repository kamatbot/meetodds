// The built-in local LLM ("builtin-ai", Qwen/Gemma downloads) this file used to cover is
// being removed in a parallel branch, and onboarding no longer offers or downloads a local
// summary model at all (Apple Intelligence has none to download). This file now covers the
// on-device summary option's onboarding lib: src/lib/apple-intelligence.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const modulePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'lib',
  'apple-intelligence.ts'
);

function loadAppleIntelligenceModule(invoke) {
  const source = fs.readFileSync(modulePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: (name) => {
      if (name !== '@tauri-apps/api/core') throw new Error(`Unmocked module ${name}`);
      return { invoke };
    },
  });
  return module.exports;
}

// Statuses come back from a module evaluated in a separate vm context (a different realm),
// so they are compared field-by-field rather than with a strict deepEqual, which would also
// (unhelpfully) compare cross-realm prototype identity.

{
  const { getAppleIntelligenceStatus } = loadAppleIntelligenceModule(async (command) => {
    assert.equal(command, 'api_apple_intelligence_status');
    return { available: true, reason: null };
  });
  const status = await getAppleIntelligenceStatus();
  assert.equal(status.available, true, 'an available Mac reports the native status untouched');
  assert.equal(status.reason, null);
}

{
  const { getAppleIntelligenceStatus } = loadAppleIntelligenceModule(async () => ({
    available: false,
    reason: 'This Mac does not meet the Apple Intelligence hardware requirements.',
  }));
  const status = await getAppleIntelligenceStatus();
  assert.equal(status.available, false, 'an unavailable Mac keeps the native reason so ChatGPT remains the offered alternative');
  assert.equal(status.reason, 'This Mac does not meet the Apple Intelligence hardware requirements.');
}

{
  // The native command is being added by another workstream in parallel; until it lands
  // (or if it ever regresses), invoke() throws and this must fail closed, not crash onboarding.
  const { getAppleIntelligenceStatus } = loadAppleIntelligenceModule(async () => {
    throw new Error('command api_apple_intelligence_status not found');
  });
  const status = await getAppleIntelligenceStatus();
  assert.equal(status.available, false, 'a missing or failing command fails closed instead of throwing, so ChatGPT stays selectable');
  assert.equal(status.reason, 'Apple Intelligence status is unavailable');
}

console.log('apple-intelligence tests passed');
