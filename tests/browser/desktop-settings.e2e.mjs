import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createServer as createProbe } from 'node:net';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { startDesktopAgent } from '../../src/server/desktop/agent.js';
import { desktopConfig } from '../../src/shared/desktop-config.js';
import { buildDesktop } from '../../scripts/desktop.ts';
import { SetupService } from '../../src/server/setup/service.js';
import { setupFixture } from '../helpers/setup-fixture.js';
import { launchOptions, root } from '../helpers/browser-runtime.mjs';

const home = await mkdtemp(join(tmpdir(), 'desktop-ui-')), directory = join(home, 'desktop');
const output = await buildDesktop(join(root, '.artifacts/desktop-ui'));
const remote = setupFixture(directory);
const agent = await startDesktopAgent({ home, directory, command: [Bun.which('node'), join(root, 'tests/fixtures/desktop-gateway.mjs')], serviceFactory: deployment => new SetupService({ ...remote, deployment }) });
const server = createServer(async (req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!/^[a-z.-]+$/.test(name)) { res.writeHead(404); res.end(); return; }
  try { res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' })[extname(name)] || 'application/octet-stream'); res.end(await readFile(join(output, name))); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
try {
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1160, height: 850 }, locale: 'en-US' });
  await context.exposeBinding('nativeOperation', async (_source, action, body) => {
    try { return { ok: true, value: await agent.dispatch(action, body) }; }
    catch (error) { return { ok: false, error: error.message, status: error.status }; }
  });
  await context.addInitScript(() => { window.desktop = { invoke: (action, body) => window.nativeOperation(action, body) }; });
  let page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.locator('[name=cwd]').waitFor();
  await page.waitForFunction(() => document.querySelector('[name=cwd]').value.length > 0);
  assert.equal(await page.locator('[data-panel=configuration]').isVisible(), true);
  const port = await new Promise(resolve => { const probe = createProbe(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
  await page.locator('[name=codex]').fill(process.execPath); await page.locator('[name=port]').fill(String(port)); await page.locator('[name=autostart]').uncheck();
  await page.locator('#checkDependencies').click(); await page.waitForFunction(() => document.querySelectorAll('#dependencies li').length === 3);
  assert.match(await page.locator('#dependencies').innerText(), /codex/);
  await page.locator('#save').click(); await page.waitForFunction(() => !document.querySelector('[data-panel=overview]').hidden);
  await page.locator('#start').click(); await page.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Running');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}`)).json()).fixture, true);
  const pid = (await agent.dispatch('status')).local.pid;
  await page.screenshot({ path: join(root, '.artifacts/desktop-overview.png'), fullPage: true });
  await page.close(); // Closing a settings client cannot own gateway lifetime.
  assert.equal((await agent.dispatch('status')).local.pid, pid);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}`)).json()).pid, pid);
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Running');
  await page.locator('[data-page=configuration]').click(); assert.equal(await page.locator('#save').isDisabled(), true);
  await page.locator('[data-page=overview]').click(); await page.locator('#stop').click(); await page.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Stopped');
  await page.locator('[data-page=configuration]').click(); await page.locator('[name=language]').selectOption('zh'); await page.locator('[name=theme]').selectOption('dark');
  assert.equal(await page.locator('#pageTitle').textContent(), '网关设置');
  await page.locator('[name=codex]').fill('/opt/tools/codex');
  await page.screenshot({ path: join(root, '.artifacts/desktop-settings-dark-zh.png'), fullPage: true });
  await page.locator('[data-page=remote]').click(); await page.locator('[name=token]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-stage=account]').isVisible(), true);
  await page.waitForFunction(() => document.querySelector('[data-stage=account] h2').textContent === '连接 Cloudflare');
  await page.screenshot({ path: join(root, '.artifacts/desktop-remote-zh.png'), fullPage: true });
  await page.locator('[data-page=configuration]').click();
  await page.setViewportSize({ width: 720, height: 820 }); await page.screenshot({ path: join(root, '.artifacts/desktop-settings-compact.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('PASS: desktop initialization, dependency checks, start/stop, window-independent lifetime, settings locking, shared remote wizard, themes, localization and compact layout');
} finally {
  await browser?.close(); await agent.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true });
}
