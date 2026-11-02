import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const root = resolve(import.meta.dirname, '../..');
const fixture = mkdtempSync(join(tmpdir(), 'codex-remote-web-test-'));
const rpcLog = join(fixture, 'turns.jsonl');
const port = await new Promise((resolvePort, reject) => { const probe = createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolvePort(port)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn(['bun', 'run', 'src/server/index.ts'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: fixture, CODEX_WEBUI_CWD: fixture, CODEX_WEBUI_REVIEW_ROOT: fixture, CODEX_WEBUI_ENABLE_TERMINAL: 'false', CODEX_WEBUI_ENABLE_REVIEW_WRITE: 'false', CODEX_WEBUI_FIXTURE_LOG: rpcLog, PATH: `${join(root, 'tests/fixtures')}${delimiter}${process.env.PATH}` }, stdout: 'ignore', stderr: 'ignore' });
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await (await fetch(`${base}/api/health`)).json()).codex) break; } catch {}
    if (attempt >= 100) throw new Error('Fixture server did not start');
    await Bun.sleep(50);
  }
  const capabilities = (await (await fetch(`${base}/api/config`)).json()).capabilities;
  assert.deepEqual(capabilities, { terminal: false, reviewWrite: false });
  assert.equal((await fetch(`${base}/api/review/patch`, { method: 'POST', body: '{}' })).status, 403);
  const terminalStatus = await new Promise((resolveStatus, reject) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/terminal`);
    ws.on('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolveStatus(response.statusCode); });
    ws.on('error', () => {});
    ws.on('open', () => { ws.close(); reject(new Error('Terminal unexpectedly opened')); });
  });
  assert.equal(terminalStatus, 403);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => { if (window !== window.top) return; delete globalThis.Notification; localStorage.setItem('codex-webui-locale', 'en'); });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.models.length > 0);
  assert.equal(await page.locator('#settingsTaskNotifyToggle').isDisabled(), true);
  assert.equal(await page.locator('[data-bottom-panel-action=terminal]').isDisabled(), true);

  const switched = await page.evaluate(async () => {
    const d = globalThis.__codexWebuiDebug;
    await Promise.all([d.openThread('thread-A'), d.openThread('thread-B')]);
    return d.state.active.id;
  });
  assert.equal(switched, 'thread-B');
  const foreignVisible = await page.evaluate(() => {
    const d = globalThis.__codexWebuiDebug;
    d.notify('item/started', { threadId: 'thread-A', turnId: 'other-turn', item: { id: 'other-message', type: 'agentMessage', text: 'FOREIGN_MESSAGE' } });
    return document.querySelector('#conversation').textContent.includes('FOREIGN_MESSAGE');
  });
  assert.equal(foreignVisible, false);

  await page.locator('#prompt').fill('/plan');
  await page.locator('[data-autocomplete-id="plan"]').click();
  await page.locator('#prompt').fill('Plan this fixture task');
  await page.locator('#composer').evaluate(form => form.requestSubmit());
  // Dispatch persists a receipt before reaching the fixture. Wait for its
  // actual complete JSONL record, not an assumed 100ms disk/network budget.
  let turn;
  const deadline = Date.now() + 10000;
  while (!turn && Date.now() < deadline) {
    try {
      turn = readFileSync(rpcLog, 'utf8').split('\n').slice(0, -1)
        .map(line => JSON.parse(line)).find(message => message.method === 'turn/start');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!turn) await Bun.sleep(25);
  }
  assert.ok(turn, 'Native turn/start was not recorded within 10s');
  assert.equal(turn.params.collaborationMode.mode, 'plan');
  assert.equal(turn.params.collaborationMode.settings.model, 'gpt-test-fixture');

  await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('input-thread'));
  await page.locator('[data-user-input-request]').waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-user-input-request]').waitFor();
  const otherContext = await browser.newContext();
  await otherContext.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-active-thread', 'input-thread'); });
  const other = await otherContext.newPage(); await other.goto(base, { waitUntil: 'networkidle' });
  await other.locator('[data-user-input-request]').waitFor();
  await page.locator('[data-user-input-request] input[value="0"]').check();
  await page.locator('[data-user-input-request] button[type=submit]').click();
  await page.locator('[data-user-input-request]').waitFor({ state: 'detached' });
  await other.locator('[data-user-input-request]').waitFor({ state: 'detached' });
  const stale = await fetch(`${base}/api/codex/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'fixture-question', result: { answers: { choice: { answers: ['A'] } } } }) });
  assert.equal(stale.status, 400);
  assert.deepEqual(errors, []);
  console.log('PASS: missing notification API, thread isolation, navigation race, native plan mode, question replay and multi-client resolution');
  await otherContext.close(); await context.close();
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await server.exited;
  rmSync(fixture, { recursive: true, force: true });
}
