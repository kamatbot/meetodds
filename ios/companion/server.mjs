#!/usr/bin/env node
import { createServer } from 'node:https';
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { BridgeError, withCodex, readAccountAndModels, createSummary, safeEnvironment } from './protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOME = join(HERE, '.private');
const TEMPLATE_IDS = ['standard_meeting', 'daily_standup', 'mayur_product_review', 'mayur_decision_review', 'mayur_pm_one_on_one'];
export function authorized(header, token) {
  if (typeof header !== 'string' || header.length > 512) return false;
  const left = createHash('sha256').update(header).digest();
  const right = createHash('sha256').update(`Bearer ${token}`).digest();
  return timingSafeEqual(left, right);
}
export function validateInput(body, templates) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['input', 'templateID', 'model'].includes(key))) throw new BridgeError(400, 'Only meeting text, template and model may be submitted.');
  if (typeof body.input !== 'string' || Buffer.byteLength(body.input) > 512_000) throw new BridgeError(413, 'Meeting text is too large.');
  let evidence; try { evidence = JSON.parse(body.input); } catch { throw new BridgeError(400, 'Invalid meeting evidence.'); }
  if (!evidence || typeof evidence.transcript !== 'string' || !evidence.transcript.trim() || Object.keys(evidence).some(key => !['transcript', 'personalNotes'].includes(key)) || (evidence.personalNotes != null && typeof evidence.personalNotes !== 'string')) throw new BridgeError(400, 'A finalized transcript and optional personal notes are required.');
  if (!Object.hasOwn(templates, body.templateID)) throw new BridgeError(400, 'Unknown template.');
  if (body.model != null && (typeof body.model !== 'string' || body.model.length > 150)) throw new BridgeError(400, 'Invalid model.');
  return { input: body.input, template: templates[body.templateID], model: body.model ?? null };
}
async function bodyJSON(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new BridgeError(415, 'Use JSON meeting text, not an audio upload.');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length; if (size > 600_000) throw new BridgeError(413, 'Input limit exceeded.'); chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BridgeError(400, 'Invalid JSON.'); }
}
export function handler({ token, templates, execute }) {
  let busy = false;
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => { if (!response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); } };
    if (request.headers.origin || !authorized(request.headers.authorization, token)) { send(401, { error: 'Pair this device before using the companion.' }); return; }
    if (!((request.method === 'GET' && request.url === '/v1/status') || (request.method === 'POST' && request.url === '/v1/summary'))) { send(404, { error: 'Not found.' }); return; }
    if (busy) { send(409, { error: 'The companion is busy. No request was queued.' }); return; }
    busy = true;
    const abort = new AbortController();
    const disconnect = () => { if (!response.writableEnded) abort.abort(); };
    response.on('close', disconnect);
    const deadline = setTimeout(() => abort.abort(), 175_000);
    try {
      const input = request.method === 'POST' ? validateInput(await bodyJSON(request), templates) : null;
      const result = await execute(input, abort.signal);
      send(200, result);
    } catch (error) { send(error instanceof BridgeError ? error.status : 503, { error: error instanceof BridgeError ? error.message : 'The companion could not complete this request. Check ChatGPT sign-in and Codex availability on the Mac.' }); }
    finally { clearTimeout(deadline); response.off('close', disconnect); busy = false; }
  };
}
async function initialize(home, publicURL) {
  const url = new URL(publicURL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Use a root HTTPS URL reachable from your iPhone.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!/^[a-zA-Z0-9.:-]+$/.test(hostname)) throw new Error('Invalid host name.');
  await mkdir(home, { recursive: true, mode: 0o700 }); await chmod(home, 0o700);
  const token = randomBytes(32).toString('base64url');
  const cert = join(home, 'certificate.pem'); const key = join(home, 'private-key.pem');
  await writeFile(join(home, 'pairing.lock'), '', { flag: 'wx', mode: 0o600 });
  const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365', '-keyout', key, '-out', cert, '-subj', '/CN=MeetOdds Companion', '-addext', `subjectAltName=${isIP(hostname) ? 'IP' : 'DNS'}:${hostname}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (openssl.status !== 0) throw new Error('OpenSSL could not create the companion certificate. Use a new directory and check your OpenSSL installation.');
  await chmod(key, 0o600); await chmod(cert, 0o600);
  const certificate = new X509Certificate(await readFile(cert));
  const pairing = { url: url.origin, token, fingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase() };
  await writeFile(join(home, 'pairing.json'), JSON.stringify(pairing, null, 2), { flag: 'wx', mode: 0o600 });
  const codexHome = join(home, 'codex'); await mkdir(codexHome, { mode: 0o700 });
  await writeFile(join(codexHome, 'config.toml'), 'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "keyring"\nweb_search = "disabled"\n[history]\npersistence = "none"\n', { mode: 0o600 });
  console.log('Pairing text (contains a secret; paste directly into MeetOdds Settings, do not share publicly):');
  console.log(JSON.stringify(pairing));
}
async function main() {
  const [command, value, ...rest] = process.argv.slice(2);
  const home = resolve(process.env.MEETODDS_COMPANION_HOME || DEFAULT_HOME);
  if (command === 'init') { if (!value || rest.length) throw new Error('Usage: node server.mjs init https://your-mac.local:9417'); await initialize(home, value); return; }
  if (command === 'login') {
    const result = spawnSync('codex', ['login'], { env: safeEnvironment(join(home, 'codex')), stdio: 'inherit' });
    if (result.status !== 0) throw new Error('ChatGPT sign-in did not complete.'); return;
  }
  if (command !== 'serve') throw new Error('Commands: init <https-url>, login, serve [bind-address]. Node 22+ and official Codex CLI are required.');
  const config = JSON.parse(await readFile(join(home, 'pairing.json'), 'utf8'));
  const templates = Object.fromEntries(await Promise.all(TEMPLATE_IDS.map(async id => [id, JSON.parse(await readFile(join(HERE, '../../frontend/src-tauri/templates', `${id}.json`), 'utf8'))])));
  const codexHome = join(home, 'codex');
  const execute = (input, signal) => withCodex(codexHome, signal, (rpc, cwd) => input ? createSummary(rpc, { ...input, cwd, signal }) : readAccountAndModels(rpc));
  const server = createServer({ key: await readFile(join(home, 'private-key.pem')), cert: await readFile(join(home, 'certificate.pem')), minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, handler({ token: config.token, templates, execute }));
  server.requestTimeout = 180_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  server.maxConnections = 8;
  const port = Number(new URL(config.url).port || 443);
  server.listen(port, value || '127.0.0.1', () => console.log(`MeetOdds companion listening on ${value || '127.0.0.1'}:${port}. No meeting content is logged.`));
  process.once('SIGINT', () => { server.closeAllConnections(); server.close(); });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
