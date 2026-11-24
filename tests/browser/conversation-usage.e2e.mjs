import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { artifact, launchOptions } from '../helpers/browser-runtime.mjs';
import { isolatedWorkspace } from '../helpers/isolated-workspace.mjs';

const workspace = await isolatedWorkspace();
let browser;
try {
  browser = await chromium.launch(launchOptions());
  for (const [width, locale] of [[1280, 'en'], [768, 'zh-CN'], [320, 'zh-CN']]) {
    const context = await browser.newContext({ viewport: { width, height: 760 }, isMobile: width < 1000, hasTouch: width < 1000 });
    await context.addInitScript(language => {
      if (window === window.top) localStorage.setItem('codex-webui-locale', language);
    }, locale);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(workspace.base);
    await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected);
    const footer = page.locator('#conversationUsage');
    assert.equal(await footer.isVisible(), false);
    assert.equal(await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('thread-A')), true);
    assert(await footer.isVisible());
    const missing = locale === 'en' ? 'Not available' : '暂未提供';
    const values = () => footer.locator('dd').allTextContents().then(items => items.map(item => item.trim()));
    const singleRow = () => footer.locator(':scope > div').evaluateAll(metrics =>
      new Set(metrics.map(metric => Math.round(metric.getBoundingClientRect().top))).size === 1);
    assert.deepEqual(await values(), Array(6).fill('–'));
    assert.equal(await footer.locator('#conversationUsageTtft').getAttribute('title'), missing);
    assert(await singleRow(), 'unreported values stay on one line');
    if (process.env.CODEX_USAGE_SCREENSHOTS) {
      await page.screenshot({ path: artifact(`conversation-usage-${width}-unreported.png`) });
    }

    await page.evaluate(() => {
      const { notify } = globalThis.__codexWebuiDebug;
      const threadId = 'thread-A', turnId = 'usage-turn';
      notify('turn/started', { threadId, turn: { id: turnId, model: 'gpt-6.2-sol' } });
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'first-text', delta:'First visible text.' });
      notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: {
        total: { totalTokens: 446563396, inputTokens: 446562996, cachedInputTokens: 223281498, outputTokens: 400 },
        last: { totalTokens: 352614, inputTokens: 352494, cachedInputTokens: 200000, outputTokens: 120 },
        modelContextWindow: 475000,
      } });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', durationMs: 4000, items: [] } });
      notify('thread/tokenUsage/updated', { threadId: 'thread-B', turnId: 'other-turn', tokenUsage: {
        total: { totalTokens: 20, outputTokens: 5 },
        last: { totalTokens: 20, outputTokens: 5 },
        modelContextWindow: null,
      } });
    });
    const rate = locale === 'en' ? '30 tokens/s' : '30 token/秒';
    const [ttft, ...usage] = await values();
    assert.match(ttft, /^\d+(?:\.\d+)? (ms|s)$/);
    assert.deepEqual(usage, [rate, '50%', '$0.6518', '446M', '352.6k/475k']);
    assert.equal(await footer.locator('#conversationUsageTotal').getAttribute('title'), '446,563,396');
    assert.equal(await footer.locator('#conversationUsageContext').getAttribute('title'), '352,614 / 475,000');
    assert.equal(await page.locator('#composer #contextUsage').count(),0);
    assert(await footer.locator('.conversation-context-value #contextUsage').isVisible());
    assert.equal(await footer.locator('dt').nth(1).textContent(), 'TPS');
    assert(await singleRow(), 'reported values stay on one line');
    assert(await page.evaluate(() => {
      const metrics = document.querySelector('#conversationUsage').getBoundingClientRect();
      const composer = document.querySelector('#composer').getBoundingClientRect();
      return metrics.top >= composer.bottom && metrics.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
    }));
    if (process.env.CODEX_USAGE_SCREENSHOTS) {
      await page.screenshot({ path: artifact(`conversation-usage-${width}-single-line.png`) });
    }
    if (width === 320) {
      assert(await footer.evaluate(row => {
        if (row.scrollWidth === row.clientWidth) return true;
        row.scrollLeft = row.scrollWidth;
        const viewport = row.getBoundingClientRect();
        const context = row.querySelector('#conversationUsageContext').getBoundingClientRect();
        return row.scrollLeft > 0 && context.left >= viewport.left && context.right <= viewport.right + 1;
      }), 'scrolling reveals the full rightmost metric without wrapping the footer');
    }
    assert.equal(await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('thread-B')), true);
    assert.deepEqual(await values(), ['–', '–', '–', '–', '20', '–']);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px ${locale}: compact tokens, exact tooltips, rate units, unavailable values and thread isolation`);
    await context.close();
  }
} finally {
  await browser?.close();
  await workspace.close();
}
