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
let failNext, holdNext, releaseHeld;
try {
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1160, height: 850 }, locale: 'en-US' });
  await context.exposeBinding('nativeOperation', async (_source, action, body) => {
    try {
      if (action === failNext) { failNext = null; throw new Error('Gateway could not start. Check dependencies and retry.'); }
      if (action === holdNext) { holdNext = null; await new Promise(resolve => { releaseHeld = resolve; }); }
      return { ok: true, value: await agent.dispatch(action, body) };
    }
    catch (error) { return { ok: false, error: error.message, status: error.status }; }
  });
  await context.addInitScript(() => {
    window.__statusReplies = 0; window.__panelEntries = [];
    document.addEventListener('animationstart', event => { if (event.target.matches('[data-panel]')) window.__panelEntries.push(event.target.dataset.panel); });
    window.desktop = { invoke: async (action, body) => { const result = await window.nativeOperation(action, body); if (action === 'status') window.__statusReplies++; return result; } };
  });
  let page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.locator('[name=cwd]').waitFor();
  await page.waitForFunction(() => document.querySelector('[name=cwd]').value.length > 0);
  assert.equal(await page.locator('[data-panel=configuration]').isVisible(), true);
  const port = await new Promise(resolve => { const probe = createProbe(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
  await page.locator('[name=codex]').fill(process.execPath); await page.locator('[name=port]').fill(String(port)); await page.locator('label:has([name=autostart]) .settings-switch').click();
  await page.locator('#checkDependencies').click(); await page.waitForFunction(() => document.querySelectorAll('#dependencies li').length === 3);
  assert.match(await page.locator('#dependencies').innerText(), /codex/);
  await page.locator('#save').click(); await page.waitForFunction(() => !document.querySelector('[data-panel=overview]').hidden);
  assert.equal(await page.locator('#message').textContent(), 'Settings saved.');
  failNext = 'start'; await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#message').dataset.kind === 'error');
  assert.match(await page.locator('#message').textContent(), /could not start/);
  await page.waitForFunction(() => !document.querySelector('#start').disabled);
  assert.equal(await page.locator('#start').getAttribute('aria-busy'), null);
  holdNext = 'start'; await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#start').getAttribute('aria-busy') === 'true');
  assert.equal(await page.locator('#start').isDisabled(), true);
  assert.equal(await page.locator('#message').textContent(), 'Working…');
  assert.equal(await page.locator('#start').evaluate(node => getComputedStyle(node, '::after').animationName), 'settings-spin');
  releaseHeld();
  await page.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Running' && !document.querySelector('#start').hasAttribute('aria-busy'));
  assert.equal(await page.locator('#message').textContent(), 'Gateway started.');
  const entries = await page.evaluate(() => window.__panelEntries.length);
  const replies = await page.evaluate(() => window.__statusReplies);
  await page.waitForFunction(count => window.__statusReplies > count, replies);
  assert.equal(await page.evaluate(() => window.__panelEntries.length), entries, 'Status polling must not replay panel entry motion');
  assert.equal(await page.locator('.hero-mark').evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}`)).json()).fixture, true);
  const pid = (await agent.dispatch('status')).local.pid;
  await page.screenshot({ path: join(root, '.artifacts/desktop-overview.png'), fullPage: true, animations: 'disabled' });
  await page.close(); // Closing a settings client cannot own gateway lifetime.
  assert.equal((await agent.dispatch('status')).local.pid, pid);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}`)).json()).pid, pid);
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Running');
  await page.locator('[data-page=configuration]').click(); assert.equal(await page.locator('#save').isDisabled(), true);
  await page.locator('[name=language]').selectOption('zh');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN' && !document.querySelector('[name=language]').disabled);
  assert.equal((await agent.dispatch('status')).config.language, 'zh');
  assert.equal((await agent.dispatch('status')).local.pid, pid, 'Language switching must preserve the running gateway');
  await page.reload(); await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  await page.locator('[data-page=configuration]').click();
  await page.locator('[name=language]').selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en' && !document.querySelector('[name=language]').disabled);
  await page.locator('[data-page=overview]').click(); await page.locator('#stop').click(); await page.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Stopped');
  await page.locator('[data-page=configuration]').click(); await page.locator('[name=language]').selectOption('zh'); await page.locator('[name=theme]').selectOption('dark');
  await page.waitForFunction(() => document.querySelector('#pageTitle').textContent === '网关设置' && !document.querySelector('[name=language]').disabled);
  assert.equal(await page.locator('#pageTitle').textContent(), '网关设置');
  const languagePicker = page.locator('[data-select=desktopLanguage]');
  await languagePicker.focus(); await page.keyboard.press('ArrowDown');
  await page.getByRole('option', { name: 'English', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await languagePicker.getAttribute('aria-expanded'), 'false');
  assert.equal(await languagePicker.evaluate(node => node === document.activeElement), true);
  const terminal = page.locator('[name=terminal]'); await terminal.focus(); await page.keyboard.press('Space');
  assert.equal(await terminal.isChecked(), true); await page.keyboard.press('Space');
  assert.equal(await terminal.isChecked(), false);
  await page.locator('[name=codex]').fill('/opt/tools/codex');
  await page.locator('.desktop-main').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: join(root, '.artifacts/desktop-settings-dark-zh.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(24, 24, 24)');
  assert.equal(await page.locator('[data-page=overview]').evaluate(node => { const sample = document.createElement('span'); sample.style.color = 'var(--app-text-secondary)'; document.body.append(sample); const matches = getComputedStyle(node).color === getComputedStyle(sample).color; sample.remove(); return matches; }), true);
  await page.locator('#dependencies').evaluate(node => { for (const code of node.querySelectorAll('code')) code.textContent = '/opt/tools/' + code.closest('li').querySelector('strong').textContent; });
  await page.locator('h2[data-text=Appearance]').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(root, '.artifacts/desktop-settings-controls-zh.png'), fullPage: true, animations: 'disabled' });
  await page.locator('[data-page=remote]').click(); await page.locator('[name=token]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-stage=account]').isVisible(), true);
  await page.waitForFunction(() => document.querySelector('[data-stage=account] h2').textContent === '连接 Cloudflare');
  await page.screenshot({ path: join(root, '.artifacts/desktop-remote-zh.png'), fullPage: true, animations: 'disabled' });
  await page.locator('[data-page=configuration]').click();
  await page.setViewportSize({ width: 720, height: 820 }); await page.screenshot({ path: join(root, '.artifacts/desktop-settings-compact.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 660, height: 540 });
  await page.locator('[data-page=diagnostics]').click();
  await page.locator('#events li').first().waitFor();
  assert.equal(await page.locator('#events time').count() > 0, true);
  await page.screenshot({ path: join(root, '.artifacts/desktop-diagnostics-compact.png'), animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.querySelector('.desktop-main').scrollWidth > document.querySelector('.desktop-main').clientWidth), false);
  await page.locator('[data-page=overview]').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-page=overview]').getAttribute('aria-current'), 'page');
  await page.evaluate(() => { for (const name of ['configuration', 'diagnostics', 'overview']) document.querySelector(`[data-page=${name}]`).click(); });
  await page.waitForFunction(() => document.querySelector('[data-panel=overview]').getAnimations().length === 0);
  assert.equal(await page.locator('[data-panel]:visible').count(), 1);
  assert.equal(await page.locator('[data-panel][hidden]').evaluateAll(nodes => nodes.every(node => node.getAnimations().length === 0)), true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[data-page=configuration]').click();
  assert.equal(await page.locator('[data-panel=configuration]').evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.equal(await page.locator('.settings-switch').first().evaluate(node => getComputedStyle(node, '::after').transitionDuration), '0s');
  await page.locator('[data-page=overview]').click();
  holdNext = 'start'; await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#start').getAttribute('aria-busy') === 'true');
  assert.equal(await page.locator('#start').evaluate(node => getComputedStyle(node, '::after').animationName), 'none');
  assert.equal(await page.locator('#message').textContent(), '正在处理…');
  releaseHeld(); await page.waitForFunction(() => !document.querySelector('#start').hasAttribute('aria-busy'));
  assert.deepEqual(errors, []);
  console.log('PASS: desktop initialization, dependency checks, start/stop, window-independent lifetime, settings locking, shared remote wizard, themes, keyboard access, operation feedback, reduced motion, polling-stable transitions and compact layout');
} finally {
  await browser?.close(); await agent.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true });
}
