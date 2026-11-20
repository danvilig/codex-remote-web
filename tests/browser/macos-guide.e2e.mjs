import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installationHelp } from '../../scripts/macos-dmg.ts';
import { artifact, launchOptions } from '../helpers/browser-runtime.mjs';

const browser = await chromium.launch(launchOptions());
try {
  const page = await browser.newPage({ locale: 'en-US' });
  for (const [name, width, height] of [['desktop', 1000, 1000], ['tablet', 768, 1024], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setContent(installationHelp);
    await page.waitForFunction(() => document.querySelector('.intro').textContent.length > 0);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(/[\u3400-\u9fff]/.test(await page.locator('main').innerText()), false, 'English guide must not show parallel Chinese copy');
    assert.equal(await page.locator('.arrow').evaluate(el => getComputedStyle(el).animationName), 'drift');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: horizontal overflow`);
    assert.equal(await page.locator('details[open]').count(), 0, 'Keep detail out of the initial installation flow');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.arrow').evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.screenshot({ path: artifact(`macos-guide-${name}.png`), fullPage: true });
    await page.locator('#language').selectOption('zh');
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    assert.equal(await page.locator('h1').textContent(), 'Codex Remote Web');
    assert.match(await page.locator('.features').innerText(), /在浏览器里工作.*让网关保持运行.*从其他设备连接/s);
    assert.equal(await page.getByText('Drag Codex Remote Web into Applications.', {exact:true}).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: artifact(`macos-guide-${name}-zh.png`), fullPage: true });
    await page.locator('#language').selectOption('en');
  }
  await page.locator('summary').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('details').first().getAttribute('open'), '');
  await page.locator('summary').nth(1).focus();
  await page.keyboard.press('Enter');
  assert.match(await page.locator('details').nth(1).innerText(), /no Apple Developer ID or notarization/);
  const chinese = await browser.newPage({ locale: 'zh-CN' });
  await chinese.setContent(installationHelp);
  assert.equal(await chinese.locator('html').getAttribute('lang'), 'zh-CN');
  await chinese.close();
  console.log('PASS: macOS guide desktop/tablet/mobile, animation, reduced motion and keyboard help');
} finally { await browser.close(); }
