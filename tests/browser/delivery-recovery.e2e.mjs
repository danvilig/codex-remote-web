import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { root } from '../helpers/browser-runtime.mjs';

// Real HTTP and WS gateway, deterministic native fixture. No model or credentials.
const temp = await mkdtemp('/tmp/crw-delivery-recovery-');
const home = join(temp, 'home'), project = join(temp, 'project'), log = join(temp, 'native.jsonl');
await Promise.all([mkdir(home), mkdir(project)]);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, CODEX_HOME: home, CODEX_AUTH_PATH: join(home, 'absent.json'), CODEX_WEBUI_APP_SERVER_MODE: 'isolated', CODEX_WEBUI_AUTH_MODE: 'local', CODEX_WEBUI_CWD: project, CODEX_WEBUI_REVIEW_ROOT: project, CODEX_WEBUI_ENABLE_TERMINAL: 'false', CODEX_WEBUI_FIXTURE_CONVERSATION_TOOLS: 'true', CODEX_WEBUI_FIXTURE_LOG: log, PATH: join(root, 'tests/fixtures') + delimiter + process.env.PATH, HOST: '127.0.0.1', PORT: String(port) };
let server, ws, sequence = 0;
const pending = new Map();
async function start() {
  server = Bun.spawn(['bun', 'src/server/index.ts'], { cwd: root, env, stdout: 'ignore', stderr: Bun.file(join(temp, 'gateway.log')) });
  await wait(async () => { try { return (await (await fetch(base + '/api/health')).json()).codex; } catch { return false; } });
}
async function wait(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do { const value = await predicate(); if (value) return value; await Bun.sleep(40); } while (Date.now() < deadline);
  throw Error('Timed out waiting for delivery state: ' + await readFile(join(temp, 'gateway.log'), 'utf8').catch(() => ''));
}
async function rpc(method, params = {}) {
  const response = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ id: ++sequence, method, params }) });
  return response.json();
}
function wsRpc(method, params) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error('WS reply timeout')); }, 15000); pending.set(id, value => { clearTimeout(timer); resolve(value); }); ws.send(JSON.stringify({ type: 'rpc', id, method, params })); }); }
const records = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const nativeCount = async id => (await records()).filter(item => item.params?.clientUserMessageId === id && ['turn/start', 'turn/steer'].includes(item.method)).length;
const queue = async () => (await rpc('host/delivery/list', { threadId: 'thread-A' })).result.entries;
try {
  await start();
  ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  ws.on('message', raw => { const value = JSON.parse(String(raw)); if (pending.has(value.id)) { const resolve = pending.get(value.id); pending.delete(value.id); resolve(value); } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const id = randomUUID(), params = { threadId: 'thread-A', clientUserMessageId: id, input: [{ type: 'text', text: 'Deduplicated transport submission [wait]' }] };
  const replies = await Promise.all([rpc('turn/start', params), wsRpc('turn/start', params)]);
  assert(replies.every(value => ['rpc/result', 'rpc/error'].includes(value.type)));
  const receipt = await wait(async () => { const value = (await rpc('host/submissions/get', { id })).result; return value?.status === 'accepted' && value; });
  assert.equal(await nativeCount(id), 1, 'HTTP/WS same UUID dispatches only once');
  assert.equal((await rpc('turn/start', params)).result.turn.id, receipt.result.turn.id);
  assert.equal(await nativeCount(id), 1);
  assert.equal((await rpc('turn/start', { ...params, input: [{ type: 'text', text: 'Different payload' }] })).code, 'SUBMISSION_CONFLICT');

  // A browser may disappear after enqueue; worker execution is server-owned.
  const queuedId = randomUUID(), queuedParams = { threadId: 'thread-A', cwd: project, model: 'gpt-test-fixture', effort: 'high', approvalPolicy: 'on-request', input: [{ type: 'text', text: 'Background delivery [wait]' }] };
  assert.equal((await rpc('host/delivery/mutate', { action: 'enqueue', payload: { id: queuedId, threadId: 'thread-A', params: queuedParams, text: 'Background delivery [wait]' } })).type, 'rpc/result');
  await wait(async () => (await queue()).find(entry => entry.id === queuedId && entry.status === 'waiting'));
  ws.close(); ws = null;
  await rpc('turn/interrupt', { threadId: 'thread-A', turnId: receipt.result.turn.id });
  // An interrupted predecessor intentionally pauses pending messages.
  const paused = await wait(async () => (await queue()).find(entry => entry.id === queuedId && entry.status === 'paused'));
  assert.equal((await rpc('host/delivery/mutate', { action: 'resume', payload: { id: queuedId, version: paused.version - 1 } })).type, 'rpc/error');
  await rpc('host/delivery/mutate', { action: 'resume', payload: { id: queuedId, version: paused.version } });
  await wait(async () => await nativeCount(queuedId) === 1);
  const queuedReceipt = await wait(async () => { const value = (await rpc('host/submissions/get', { id: queuedId })).result; return value?.status === 'accepted' && value; });
  assert.equal(queuedReceipt.result.turn.status, 'inProgress');
  const nativeQueued = (await records()).find(item => item.params?.clientUserMessageId === queuedId);
  assert.equal(nativeQueued.params.effort, 'high');
  assert.equal(nativeQueued.params.approvalPolicy, 'on-request');

  const restartId = randomUUID();
  await rpc('host/delivery/mutate', { action: 'enqueue', payload: { id: restartId, threadId: 'thread-A', params: queuedParams, text: 'Paused after restart' } });
  await wait(async () => (await queue()).find(entry => entry.id === restartId && entry.status === 'waiting'));
  server.kill('SIGTERM'); await server.exited; server = null;
  await start();
  assert.equal((await queue()).find(entry => entry.id === restartId).status, 'paused');
  await Bun.sleep(1100);
  assert.equal(await nativeCount(restartId), 0, 'restart never auto-replays queued messages');
  assert.equal((await rpc('host/submissions/get', { id })).result.status, 'accepted');

  const denied = await fetch(base + '/api/settings/developer-tools', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.example' }, body: JSON.stringify({ action: 'cleanup.preview' }) });
  assert.equal(denied.status, 401);
  console.log('PASS: HTTP/WS duplicate protection, payload conflict, durable receipts, background queue, interruption pause, version conflict, captured settings and restart pause; native fixture only');
} finally {
  ws?.terminate();
  if (server) { server.kill('SIGTERM'); await server.exited; }
  await rm(temp, { recursive: true, force: true });
}
