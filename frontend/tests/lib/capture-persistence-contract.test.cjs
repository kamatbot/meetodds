// Source-contract checks only. The Rust unit tests require the native Rust/Tauri toolchain.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = name => fs.readFileSync(path.resolve(__dirname, '../../src-tauri/src/audio', name), 'utf8');
const saver = source('recording_saver.rs');
const manager = source('recording_manager.rs');
const worker = source('save_worker.rs');

test('manager validates writable initialized storage before starting capture state', () => {
  assert.ok(manager.indexOf('self.recording_saver.ensure_initialized()?') < manager.indexOf('self.state.start_recording()?'));
});
test('shutdown closes and drains rather than sleeping for presumed completion', () => {
  assert.match(worker, /receiver\.close\(\)/); assert.match(worker, /receiver\.recv\(\)\.await/);
  assert.doesNotMatch(saver, /from_millis\(200\)|is_saving/); assert.match(saver, /self\.drain\(\)\.await\?/);
});
test('blocking checkpoint encoding is isolated from the async audio executor', () => {
  assert.match(saver, /spawn_blocking\(move \|\| saver\.blocking_lock\(\)\.add_chunk\(chunk\)\)/);
});
test('recovery JSON is fsynced before its atomic replacement', () => {
  assert.ok(saver.indexOf('file.as_file().sync_all()?') < saver.indexOf('file.persist(path)'));
  assert.match(saver, /File::open\(parent\)\?\.sync_all\(\)\?/);
});
test('capture identity is separate from database identity', () => {
  assert.match(saver, /capture_session_id/); assert.match(saver, /meeting_id: None/);
});
test('save errors are surfaced separately from capture-stop success', () => {
  assert.match(manager, /app\.emit\("recording-save-failed"/); assert.match(manager, /app\.emit\("recording-error"/);
  assert.match(manager, /return Err\(anyhow::Error::msg\(failure\)\)/);
});
test('transcript-only mode reaches metadata completion rather than early returning', () => {
  assert.doesNotMatch(saver, /if !should_save_audio/); assert.match(saver, /audio_retained/); assert.match(saver, /metadata\.status = "completed"/);
});
test('duration is snapshotted before force-flush cleanup', () => {
  const stop = manager.slice(manager.indexOf('pub async fn stop_streams_and_force_flush'));
  assert.ok(stop.indexOf('self.snapshot_duration()') < stop.indexOf('self.state.cleanup()'));
});
