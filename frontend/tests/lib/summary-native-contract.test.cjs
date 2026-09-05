// These are integration source contracts, not execution of Rust/Tauri unit tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.resolve(__dirname, '../../src-tauri/src/summary', p), 'utf8');
const commands = read('commands.rs');
const gate = read('execution_gate.rs');
test('native ownership precedes any destructive process reset', () => {
  assert.ok(commands.indexOf('SummaryLease::acquire(&m_id)?') < commands.indexOf('SummaryProcessesRepository::create_or_reset_process'));
});
test('lease ownership survives until the native background task returns', () => {
  const spawned = commands.slice(commands.indexOf('tauri::async_runtime::spawn(async move'));
  assert.ok(spawned.indexOf('.await;') < spawned.indexOf('drop(lease)'));
});
test('the registry is native, synchronized, and released on drop', () => {
  assert.match(gate, /Arc<Mutex<HashSet<String>>>/); assert.match(gate, /impl Drop for SummaryLease/);
  assert.match(gate, /active.remove\(&self.meeting_id\)/);
});
test('built-in local jobs respect capture before resetting a process', () => {
  assert.ok(commands.indexOf('recording_commands::is_recording().await') < commands.indexOf('SummaryProcessesRepository::create_or_reset_process'));
});
test('summary polling no longer logs meeting titles', () => {
  assert.doesNotMatch(commands, /log_info!\("Fetched meeting title/);
  assert.doesNotMatch(commands, /has_data:.*meeting_name:/);
});
