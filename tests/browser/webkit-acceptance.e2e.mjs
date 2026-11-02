import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { isolatedWorkspace } from '../helpers/isolated-workspace.mjs';
import { artifact, launchOptions } from '../helpers/browser-runtime.mjs';

// Engine emulation is deliberately labelled as such: physical iPhone Safari,
// software keyboard, Access OTP and network-switch acceptance remain separate.
const fixture = await isolatedWorkspace({ CODEX_WEBUI_FIXTURE_PROGRESS: 'true' });
const results = [];
try {
  await writeFile(fixture.project + '/main.ts', '// Fixture\nconst answer: number = 42;\n');
  for (const [engine, browserType] of [['Chromium', chromium], ['WebKit', webkit]]) {
    // Do not substitute Chromium or skip when the WebKit runtime is missing.
    const browser = await browserType.launch(engine === 'Chromium' ? launchOptions() : { headless: true });
    try {
      for (const device of [
        { name: 'desktop', viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false },
        { name: 'tablet', viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true },
        { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      ]) {
        const context = await browser.newContext({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.hasTouch, locale: 'en-US', colorScheme: 'dark' });
        const page = await context.newPage(); page.setDefaultTimeout(20000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
        try {
          await page.goto(fixture.base); await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected);
          await page.locator('#prompt').fill('Unsent draft · 未发送');
          await page.evaluate(() => globalThis.__codexWebuiDebug.openSettings('general-settings'));
          await page.locator('#languageSelect').selectOption('zh-CN');
          assert.equal(await page.locator('#settingsPageTitle').textContent(), '通用');
          await page.locator('#languageSelect').selectOption('en');
          const closeSettings = page.locator('#closeSettingsNav');
          if (await closeSettings.isVisible()) await closeSettings.click();
          else { await page.locator('#settingsMobileBack').click(); await closeSettings.click(); }
          assert.equal(await page.locator('#prompt').inputValue(), 'Unsent draft · 未发送');

          await page.evaluate(() => { window.acceptanceOpen = globalThis.__codexWebuiDebug.openThread('progress-history'); });
          await page.locator('.conversation-load-spinner').waitFor();
          assert.equal(await page.locator('#conversation').getAttribute('aria-busy'), 'true');
          assert.equal(await page.locator('#conversation .runtime-progress').count(), 0);
          assert.equal(await page.evaluate(() => window.acceptanceOpen), true);
          assert.equal(await page.locator('.native-turn-timeline').count(), 20);
          await page.locator('[data-turn-id=history-24] .turn-work-toggle').click();
          assert(await page.locator('[data-turn-id=history-24] .assistant-body').isVisible());
          await page.locator('.load-older').click();
          assert.equal(await page.locator('.native-turn-timeline').count(), 25);
          await page.evaluate(() => { const d = globalThis.__codexWebuiDebug; d.notify('turn/started', {threadId: 'progress-history', turn: {id: 'compat-active', status: 'inProgress'}}); d.notify('item/started', {threadId: 'progress-history', turnId: 'compat-active', item: {id: 'compat-command', type: 'commandExecution', command: 'echo fixture'}}); });
          await page.locator('.runtime-progress').first().waitFor();
          await page.evaluate(() => globalThis.__codexWebuiDebug.notify('turn/completed', {threadId: 'progress-history', turn: {id: 'compat-active', status: 'completed', items: []}}));

          await page.locator('#toggleSidePanel').click();
          await page.locator('[data-side-panel-action=files]').click();
          const file = page.locator('#sideFileContent').getByRole('treeitem', {name: 'main.ts', exact: true});
          await file.locator(':scope > .explorer-row-line').click();
          await page.locator('.explorer-code .tok-keyword').first().waitFor();
          await page.getByRole('button', {name: 'Edit file', exact: true}).click();
          const editor = page.locator('#sideFileContent .cm-content'); await editor.waitFor();
          await editor.focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('// edited in ' + engine + ' ' + device.name + '\n');
          await page.getByRole('button', {name: 'Save file', exact: true}).click();
          await page.waitForFunction(() => !document.querySelector('.explorer-preview-name')?.classList.contains('is-dirty'));
          await page.locator('#closeSidePanel').click();
          assert.equal(await page.locator('#sidePanel').isVisible(), false);
          const bounds = await page.evaluate(() => ({width: innerWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth}));
          assert(bounds.body <= bounds.width + 1 && bounds.root <= bounds.width + 1, `${engine}/${device.name} horizontal overflow`);
          assert.deepEqual(errors, []);
          await page.screenshot({path: artifact(`compat-${engine.toLowerCase()}-${device.name}.png`)});
          results.push({engine, version: browser.version(), device: device.name, checks: ['locale/draft', 'history/progress/disclosure', 'files drawer', 'syntax/editor/save', 'horizontal bounds'], passed: true});
          console.log(`PASS ${engine}/${device.name}: locale, history, progress, files, editor and layout`);
        } catch (error) { await page.screenshot({path: artifact(`compat-failed-${engine}-${device.name}.png`)}).catch(() => {}); throw new Error(`${engine}/${device.name}: ${error.message}`, {cause: error}); }
        finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
  assert.deepEqual(await fixture.executions(), []);
  await writeFile(artifact('webkit-acceptance.json'), JSON.stringify({results, note: 'Synthetic desktop/tablet/mobile engine emulation; not physical iPhone Safari, OTP, keyboard or network-switch acceptance.'}, null, 2) + '\n');
  console.log('PASS Chromium + WebKit desktop/tablet/mobile: ' + JSON.stringify(results));
} finally { await fixture.close(); }
