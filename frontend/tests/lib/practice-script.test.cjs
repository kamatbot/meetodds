const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
function load(relative) {
  const file = path.resolve(__dirname, '../../src', relative);
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(file, module); loaded._compile(result.outputText, file);
  return loaded.exports;
}
const { needsReadableScript, createReadableScriptCache } = load('lib/practice-script.ts');
const { tutorSpeechArguments, isCurrentSpanishReply } = load('lib/spanish.ts');

test('Hindi and Chinese script detection never rewrites Latin languages', () => {
  assert.equal(needsReadableScript('आप कैसे हैं?', 'hi'), true);
  assert.equal(needsReadableScript('你好', 'zh'), true);
  assert.equal(needsReadableScript('Aap kaise hain?', 'hi'), false);
  assert.equal(needsReadableScript('Nǐ hǎo', 'zh'), false);
  assert.equal(needsReadableScript('¿Cómo estás?', 'es'), false);
  assert.equal(needsReadableScript('Ça va ?', 'fr'), false);
});

test('Roman Hindi passes through unchanged without any conversion call', async () => {
  const readable = createReadableScriptCache(() => { throw Error('must not call'); });
  assert.equal(await readable('Aap kaise hain?', 'hi'), 'Aap kaise hain?');
  assert.equal(await readable('¿Qué tal?', 'es'), '¿Qué tal?');
});

test('display conversion is cached, coalesces requests and leaves canonical speech intact', async () => {
  let calls = 0;
  const readable = createReadableScriptCache(async () => { calls++; return 'nǐ hǎo'; });
  const text = '你好';
  const a = readable(text, 'zh'), b = readable(text, 'zh');
  assert.equal(a, b);
  assert.equal(await a, 'nǐ hǎo');
  assert.equal(await readable(text, 'zh'), 'nǐ hǎo');
  assert.equal(text, '你好');
  assert.equal(calls, 1);
});

test('display cache is language-scoped, bounded and retries failures', async () => {
  let calls = 0;
  const readable = createReadableScriptCache(async (_text, language) => {
    calls++;
    if (calls === 1) throw new Error('temporary failure');
    return `${language} readable`;
  });
  await assert.rejects(readable('你好', 'zh'));
  assert.equal(await readable('你好', 'zh'), 'zh readable');
  assert.equal(calls, 2);
  for (let i = 0; i < 130; i++) await readable(`你好 ${i}`, 'zh');
  await readable('你好', 'zh');
  assert.equal(calls, 133);
});

test('empty or untranslated native display results are not cached as successful romanization', async () => {
  for (const invalid of ['', '你好']) {
    const readable = createReadableScriptCache(async () => invalid);
    await assert.rejects(readable('你好', 'zh'));
  }
});

test('voice receives a native speech field, never the rendered transliteration', () => {
  const event = { text: 'Aap kaise hain?', speechText: 'आप कैसे हैं?', requestId: 'r', sessionId: 's', repeat: false };
  const payload = tutorSpeechArguments(event, 'es_MX', 115, 'hi');
  assert.equal(payload.text, 'Aap kaise hain?');
  assert.equal(payload.speechText, 'आप कैसे हैं?');
  assert.equal(payload.language, 'hi');
  const chinese = tutorSpeechArguments({ ...event, text: '你好', speechText: undefined }, 'es_MX', 165, 'zh');
  assert.equal(chinese.text, '你好');
  assert.equal(chinese.speechText, undefined);
  assert.equal(isCurrentSpanishReply(event, 's', 'new-request', false), false);
  assert.equal(isCurrentSpanishReply(event, 's', 'r', true), false);
});

test('every play route uses the central native gate; display and cancellation boundaries stay separate', () => {
  const host = fs.readFileSync(path.resolve(__dirname, '../../src-tauri/src/spanish/commands.rs'), 'utf8');
  assert.match(host, /write_all\(prepared\.speech_text\.as_bytes\(\)\)/);
  assert.doesNotMatch(host, /arg\(&text\)\.spawn\(\)/);
  assert.match(host, /control\.generation != generation \|\| cancel\.is_cancelled\(\)/);
  assert.match(host, /allow_external_text: false/);
  const ui = fs.readFileSync(path.resolve(__dirname, '../../src/components/Spanish/SpanishPractice.tsx'), 'utf8');
  assert.match(ui, /tutorSpeechArguments\(event, profile\.variety, rate, profile\.language\)/);
  assert.match(ui, /hearTutorLine\(turn\.text\)/);
  assert.doesNotMatch(ui, /spanish_speak[^\n]*(display|romanized|pinyin)/);
  const display = fs.readFileSync(path.resolve(__dirname, '../../src/components/Spanish/PracticeText.tsx'), 'utf8');
  assert.match(display, /result\?\.source === text && result\.language === language/);
  assert.match(display, /current = false/);
  assert.doesNotMatch(display, /spanish_speak/);
});
