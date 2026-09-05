const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
function load(relative) {
  const file = path.resolve(__dirname, '../../src', relative);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const loaded = new Module(file, module); loaded._compile(compiled.outputText, file); return loaded.exports;
}
const { initialCaptureStatus, reduceCaptureStatus, captureStatusCopy, retainedAudioFromReceipt } = load('lib/capture-status.ts');
const { privateExportDefaults, canExportSrt, selectionKey, selectedSectionCount, isFormattedDocument, runExportSteps } = load('lib/export-selection.ts');
const apply = (...events) => events.reduce(reduceCaptureStatus, initialCaptureStatus);

test('stop alone never implies saved audio', () => {
  const state = apply({type:'started'}, {type:'stopped'});
  assert.equal(state.saved, 'unconfirmed'); assert.match(captureStatusCopy(state).title, /not yet confirmed/);
});
test('an actual receipt independently confirms audio and transcript files', () => {
  const state = apply({type:'started'}, {type:'saved',audioRetained:true}, {type:'stopped'});
  assert.equal(state.saved, 'audio-and-text'); assert.match(captureStatusCopy(state).detail, /summary generation may still/);
});
test('text-only receipt never claims audio playback is available', () => {
  const state = apply({type:'started'}, {type:'saved',audioRetained:false}, {type:'stopped'});
  assert.match(captureStatusCopy(state).title, /no audio retained/);
});
test('generic stop and later save events do not erase an unacknowledged save error', () => {
  const state = apply({type:'failed'}, {type:'stopped'}, {type:'saved',audioRetained:true});
  assert.equal(captureStatusCopy(state).warning, true);
});
test('new recording resets a previous receipt but does not hide a prior failure', () => {
  const state = apply({type:'saved',audioRetained:true}, {type:'failed'}, {type:'started'});
  assert.equal(state.saved, 'unconfirmed'); assert.equal(captureStatusCopy(state).warning, true);
});
test('user dismiss can acknowledge an issue', () => {
  assert.equal(captureStatusCopy(apply({type:'failed'}, {type:'dismissed'})), null);
});
test('receipt parser supports legacy paths without fabricating retained audio', () => {
  assert.equal(retainedAudioFromReceipt({audio_file:'/file.mp4'}), true);
  for (const value of [null, {}, {audio_file:''}, {audio_file:'/file.mp4',audio_retained:false}]) assert.equal(retainedAudioFromReceipt(value), false);
});
test('export defaults include no private notes, transcript or fallback substitution', () => {
  assert.deepEqual(privateExportDefaults({hasSummary:true}), {includeSummary:true,includeNotes:false,includeTranscript:false});
  assert.deepEqual(privateExportDefaults({hasSummary:false}), {includeSummary:false,includeNotes:false,includeTranscript:false});
});
test('subtitles require transcript-only plus real timing', () => {
  const selection = {includeSummary:false,includeNotes:false,includeTranscript:true};
  assert.equal(canExportSrt(true, selection), true); assert.equal(canExportSrt(false, selection), false);
  assert.equal(canExportSrt(true, {...selection,includeNotes:true}), false); assert.equal(canExportSrt(true, {...selection,includeSummary:true}), false);
});
test('snapshot identity changes when meeting or scope changes', () => {
  const selection = privateExportDefaults({hasSummary:true});
  assert.notEqual(selectionKey('a', selection), selectionKey('b', selection));
  assert.notEqual(selectionKey('a', selection), selectionKey('a', {...selection,includeNotes:true}));
  assert.equal(selectedSectionCount(selection), 1);
});
test('formatted document formats are separate from the native export enum', () => {
  assert.equal(isFormattedDocument('pdf'), true); assert.equal(isFormattedDocument('docx'), true);
  for (const f of ['markdown','text','json','srt']) assert.equal(isFormattedDocument(f), false);
});
test('canceling text does not launch a surprising second audio save dialog', async () => {
  let audio = false;
  const result = await runExportSteps({text:async()=>({cancelled:true}),audio:async()=>{ audio = true; return {cancelled:false,label:'audio'}; }});
  assert.equal(audio, false); assert.deepEqual(result, {saved:[],cancelled:true,failed:false});
});
test('partial success is preserved when the second export fails', async () => {
  const result = await runExportSteps({text:async()=>({cancelled:false,label:'notes.pdf'}),audio:async()=>{ throw new Error('disk'); }});
  assert.deepEqual(result, {saved:['notes.pdf'],cancelled:false,failed:true});
});
test('audio cancellation preserves successful text receipt', async () => {
  const result = await runExportSteps({text:async()=>({cancelled:false,label:'notes.md'}),audio:async()=>({cancelled:true})});
  assert.deepEqual(result, {saved:['notes.md'],cancelled:true,failed:false});
});
test('audio-only export performs one step', async () => {
  assert.deepEqual(await runExportSteps({audio:async()=>({cancelled:false,label:'audio.mp4'})}), {saved:['audio.mp4'],cancelled:false,failed:false});
});
test('source contract: progress has no fake safe message or percentage', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/components/Meeting/StopProgressStrip.tsx'), 'utf8');
  assert.doesNotMatch(source, /stopped and safe|CheckCircle2|w-1\/3/);
});
test('source contract: controls are semantic and formatters are reused', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/components/Meeting/ExportSheet.tsx'), 'utf8');
  assert.match(source, /type="checkbox"/); assert.match(source, /type="radio"/); assert.match(source, /import\('@\/lib\/meeting-export'\)/);
  assert.match(source, /current !== snapshot/);
});
test('source contract: sidebar has keyboard sizing and reduced-motion support', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/components/AppShell/AppShell.tsx'), 'utf8');
  assert.match(source, /aria-valuenow/); assert.match(source, /ArrowLeft/); assert.match(source, /onLostPointerCapture/);
  const css = fs.readFileSync(path.resolve(__dirname, '../../src/components/AppShell/app-shell.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion/);
});
