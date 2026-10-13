import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../../src/lib/speaker-labels.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { exports: module.exports, module });
const { getSpeakerPresentation, withSpeakerPrefix } = module.exports;

// A score close to one and a human-readable name must not imply reviewed identity.
for (const score of [null, 0.2, 0.99, 1]) {
  const metadata = {
    speaker: 'speaker-1', speaker_label: 'Alice',
    speaker_source: 'post-meeting-acoustic', speaker_confidence: score,
  };
  assert.equal(getSpeakerPresentation(metadata).attribution, 'estimated');
  assert.equal(withSpeakerPrefix(metadata, 'I can do it.'), 'Alice [estimated speaker]: I can do it.');
  metadata.speaker_label = 'Bob';
  assert.equal(getSpeakerPresentation(metadata).isEstimate, true, 'renaming is not confirmation');
  metadata.speaker_source = 'manual';
  assert.equal(withSpeakerPrefix(metadata, 'I can do it.'), 'Bob [confirmed speaker]: I can do it.');
}

for (const metadata of [
  {},
  { speaker: 'speaker-1', speaker_label: 'Legacy label' },
  { speaker: 'unknown', speaker_label: 'Old name', speaker_source: 'manual-unknown' },
  { speaker: 'system', speaker_source: 'unresolved-channel' },
  { speaker: null, speaker_label: 'Old name', speaker_source: 'post-meeting-acoustic' },
]) {
  assert.equal(getSpeakerPresentation(metadata).label, 'Unknown');
  assert.equal(withSpeakerPrefix(metadata, 'I can do it.'), 'Unknown [unresolved speaker]: I can do it.');
}

for (const source of [undefined, 'system', 'system-channel']) {
  const metadata = { speaker: 'system', speaker_label: 'Alice', speaker_source: source };
  assert.equal(getSpeakerPresentation(metadata).attribution, 'channel');
  assert.equal(withSpeakerPrefix(metadata, 'Yes.'), 'Other party [system audio; may include multiple speakers]: Yes.');
}

for (const source of [undefined, 'microphone', 'microphone-channel']) {
  const metadata = { speaker: 'me', speaker_label: 'Me', speaker_source: source, speaker_confidence: 1 };
  assert.equal(getSpeakerPresentation(metadata).attribution, 'channel');
  assert.equal(withSpeakerPrefix(metadata, 'Yes.'), 'Microphone [microphone audio; identity unconfirmed]: Yes.');
}

console.log('speaker attribution tests passed');
