import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createServer } from 'node:http';
import { AppServer, BridgeError, safeEnvironment, RESTRICTIONS, readAccountAndModels, createSummary } from '../protocol.mjs';
import { authorized, validateInput, handler } from '../server.mjs';

const TOKEN = 'x'.repeat(43);
const template = { sections: [{ title: 'Decisions', instruction: 'Only explicit decisions' }] };
const templates = { standard_meeting: template };
const input = JSON.stringify({ transcript: '[T1 @ 00:01] Ship next Tuesday.' });
function childFor(answer) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit'); };
  child.stdin = new Writable({ write(bytes, _, done) {
    try { for (const line of bytes.toString().trim().split('\n')) answer(JSON.parse(line), child); done(); } catch (error) { done(error); }
  }});
  return child;
}
function respond(child, packet) { child.stdout.write(`${JSON.stringify(packet)}\n`); }
const account = { account: { type: 'chatgpt', planType: 'plus' } };
const catalog = { data: [{ id: 'model-entry', model: 'account-model', displayName: 'Account model', isDefault: true, inputModalities: ['text'] }], nextCursor: null };

test('API credentials, base URL overrides and proxy secrets are never inherited', () => {
  const env = safeEnvironment('/isolated', { PATH: '/bin', HOME: '/home', OPENAI_API_KEY: 'secret', OPENAI_BASE_URL: 'https://evil', HTTPS_PROXY: 'secret', CODEX_HOME: '/old' });
  assert.deepEqual(env, { CODEX_HOME: '/isolated', RUST_LOG: 'off', PATH: '/bin', HOME: '/home' });
});
test('authorization requires the exact pairing token', () => {
  assert.equal(authorized(`Bearer ${TOKEN}`, TOKEN), true);
  for (const header of [undefined, '', `Bearer ${TOKEN} `, `Basic ${TOKEN}`, `Bearer ${TOKEN.slice(1)}`]) assert.equal(authorized(header, TOKEN), false);
});
test('only approved template text requests are accepted', () => {
  assert.equal(validateInput({ input, templateID: 'standard_meeting' }, templates).input, input);
  for (const body of [{ input, templateID: '../secret' }, { input, templateID: 'standard_meeting', audio: 'bytes' }, { input: '{}', templateID: 'standard_meeting' }, { input: JSON.stringify({ transcript: 'hi', url: 'evil' }), templateID: 'standard_meeting' }]) assert.throws(() => validateInput(body, templates), BridgeError);
});
test('input cap fails before creating an upstream job', () => {
  assert.throws(() => validateInput({ input: 'x'.repeat(512001), templateID: 'standard_meeting' }, templates), error => error.status === 413);
});
test('API-key account cannot be mistaken for ChatGPT subscription access', async () => {
  await assert.rejects(readAccountAndModels({ call: async () => ({ account: { type: 'apiKey' } }) }), error => error.status === 401);
});
test('model catalog pagination returns actual models rather than hard-coded fallbacks', async () => {
  let page = 0;
  const result = await readAccountAndModels({ call: async method => method === 'account/read' ? account : ++page === 1 ? { data: catalog.data, nextCursor: 'more' } : { data: [{ model: 'second', displayName: 'Other', isDefault: false }], nextCursor: null } });
  assert.equal(page, 2); assert.deepEqual(result.models.map(x => x.id), ['account-model', 'second']);
});
test('RPC initializes and rejects all incoming approval requests', async () => {
  const received = []; const child = childFor((packet, child) => {
    received.push(packet); if (packet.method === 'initialize') respond(child, { id: packet.id, result: {} });
  });
  const rpc = new AppServer(child); await rpc.initialize();
  respond(child, { id: 77, method: 'item/commandExecution/requestApproval', params: {} });
  assert.equal(received.at(-1).error.code, -32601); assert.equal(received.at(-1).id, 77);
  assert.equal(received[0].params.clientInfo.name, 'meetodds_ios_companion'); rpc.close();
});
test('early completion notifications are captured, ephemeral and restricted work is requested', async () => {
  const requests = [];
  const child = childFor((packet, child) => {
    requests.push(packet);
    const results = { 'initialize': {}, 'account/read': account, 'model/list': catalog, 'thread/start': { thread: { id: 'thread', ephemeral: true, path: null } } };
    if (packet.method === 'turn/start') {
      respond(child, { method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', text: '## Decisions\nShip next Tuesday [T1].' } } });
      respond(child, { method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
      respond(child, { id: packet.id, result: { turn: { id: 'turn' } } });
    } else if (packet.id) respond(child, { id: packet.id, result: results[packet.method] });
  });
  const rpc = new AppServer(child); await rpc.initialize();
  const result = await createSummary(rpc, { input, template, cwd: '/empty', signal: new AbortController().signal });
  assert.match(result.markdown, /T1/); assert.equal(result.model, 'account-model');
  const thread = requests.find(x => x.method === 'thread/start').params;
  assert.equal(thread.ephemeral, true); assert.deepEqual(thread.environments, []); assert.equal(thread.config['features.shell_tool'], false);
  const turn = requests.find(x => x.method === 'turn/start').params;
  assert.equal(turn.sandboxPolicy.access.type, 'restricted'); assert.deepEqual(turn.sandboxPolicy.access.readableRoots, []); assert.equal(turn.input[0].text, input); rpc.close();
});
test('non-ephemeral session fails before meeting text is submitted', async () => {
  const methods = [];
  const rpc = { call: async method => { methods.push(method); return method === 'account/read' ? account : method === 'model/list' ? catalog : { thread: { id: 'thread', ephemeral: false, path: '/saved' } }; } };
  await assert.rejects(createSummary(rpc, { input, template, cwd: '/empty' }), error => error.status === 502);
  assert.equal(methods.includes('turn/start'), false);
});
test('unknown requested model never silently switches to another model', async () => {
  const methods = [];
  const rpc = { call: async method => { methods.push(method); return method === 'account/read' ? account : catalog; } };
  await assert.rejects(createSummary(rpc, { input, template, model: 'retired', cwd: '/empty' }), error => error.status === 400);
  assert.equal(methods.includes('thread/start'), false);
});
test('HTTP surface rejects browsers, raw audio and generic proxy paths without executing anything', async () => {
  let calls = 0;
  const server = createServer(handler({ token: TOKEN, templates, execute: async () => { calls++; return { connected: true }; } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/v1/status`)).status, 401);
    assert.equal((await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.test' } })).status, 401);
    assert.equal((await fetch(`${base}/rpc`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
    assert.equal((await fetch(`${base}/v1/summary`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'audio/mp4' }, body: 'audio' })).status, 415);
    assert.equal(calls, 0);
    const status = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(status.status, 200); assert.equal(status.headers.get('cache-control'), 'no-store'); assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('capability overrides disable optional local tools and shared sessions', () => {
  assert.equal(RESTRICTIONS.web_search, 'disabled'); assert.deepEqual(RESTRICTIONS.mcp_servers, {});
  for (const key of ['features.shell_tool', 'features.unified_exec', 'features.apps', 'features.hooks', 'tools.view_image']) assert.equal(RESTRICTIONS[key], false);
});
