import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { artifact, launchOptions } from '../helpers/browser-runtime.mjs';
import { isolatedWorkspace } from '../helpers/isolated-workspace.mjs';

const fixture = await isolatedWorkspace();
let browser;
try {
  browser = await chromium.launch(launchOptions());
  const previousBootstrap = process.env.CRW_PREVIOUS_BOOTSTRAP;
  for (const [width, scenario] of [[1280, 'interrupted'], [768, 'incomplete'], [390, 'persistent']]) {
    const page = await browser.newPage({ viewport: { width, height: 820 }, colorScheme: 'dark' });
    let requests = 0;
    const workspace = url => url.pathname === '/workspace.css';
    const verifyLayout = async () => {
      await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected);
      assert.equal(await page.locator('.skip-to-prompt').evaluate(el => getComputedStyle(el).position), 'fixed');
      assert.equal(await page.locator('.stylesheet-recovery').count(), 0);
    };
    if (previousBootstrap) {
      // Use the previous deployed entry script for a synthetic before capture.
      const script = await readFile(previousBootstrap, 'utf8');
      const bootstrap = url => url.pathname === '/auth-bootstrap.js';
      await page.route(bootstrap, route => route.fulfill({ contentType: 'text/javascript', body: script }));
      await page.route(workspace, route => route.abort());
      await page.goto(fixture.base);
      await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected);
      assert.equal(await page.locator('.skip-to-prompt').evaluate(el => getComputedStyle(el).position), 'static');
      await page.screenshot({ path: artifact(`workspace-styles-${width}-before.png`) });
      await page.unroute(workspace);
      await page.unroute(bootstrap);
    }
    await page.route(workspace, route => {
      requests++;
      if (scenario === 'persistent' && requests <= 2) return route.abort();
      if (requests !== 1) return route.continue();
      if (scenario === 'incomplete') return route.fulfill({ contentType: 'text/css', body: 'body { color: white; }' });
      return route.abort();
    });
    await page.goto(fixture.base);
    if (scenario === 'persistent') {
      const recovery = page.getByRole('dialog', { name: 'Workspace styles could not load' });
      await recovery.waitFor();
      assert.equal(await page.evaluate(() => Boolean(globalThis.__codexWebuiDebug)), false);
      assert.equal(requests, 2);
      await recovery.getByRole('button', { name: 'Retry loading' }).click();
    }
    await verifyLayout();
    assert.equal(requests, scenario === 'persistent' ? 3 : 2);
    await page.screenshot({ path: artifact(`workspace-styles-${width}-after.png`) });
    await page.close();
  }
  assert.deepEqual(await fixture.executions(), []);
  console.log('PASS: interrupted and incomplete CSS recover automatically; persistent errors can be retried without starting unstyled.');
} finally {
  await browser?.close();
  await fixture.close();
}
