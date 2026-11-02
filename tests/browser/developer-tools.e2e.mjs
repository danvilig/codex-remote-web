import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { launchOptions } from '../helpers/browser-runtime.mjs';
import { isolatedWorkspace } from '../helpers/isolated-workspace.mjs';

const fixture = await isolatedWorkspace(); let browser;
try {
  browser = await chromium.launch(launchOptions()); const page = await browser.newPage({ viewport: { width: 1180, height: 1000 } }); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.base + '/settings/personalization');
  await page.locator('#settingsProjectAgentsStatus').filter({ hasText: /does not exist/ }).waitFor();
  await page.locator('#settingsProjectAgents').fill('# Fixture instructions\n保留用户文本，不执行任务。\n');
  await page.locator('#settingsProjectAgentsPreview').click(); await page.locator('.developer-tools-dialog').waitFor();
  assert.match(await page.locator('.developer-tools-diff').textContent(), /保留用户文本/);
  await page.locator('#developerToolsConfirm').click(); await page.locator('.developer-tools-dialog').waitFor({ state: 'detached' });
  assert.match(await readFile(join(fixture.project, 'AGENTS.md'), 'utf8'), /保留用户文本/);
  await page.locator('[data-settings-page=worktrees]').click(); await page.locator('#settingsWorktreeCreate').click();
  await page.locator('#settingsWorktreeList button').filter({ hasText: 'Remove worktree' }).waitFor();
  await page.locator('#settingsWorktreeList button').filter({ hasText: 'Remove worktree' }).click(); await page.locator('#developerToolsConfirm').click();
  await page.locator('.developer-tools-dialog').waitFor({ state: 'detached' }); assert.equal(await page.locator('#settingsWorktreeList button').count(), 0);
  await page.locator('[data-settings-page=storage]').click(); await page.locator('#settingsStorageCleanup').click();
  await page.locator('#settingsStorageStatus').filter({ hasText: 'No eligible files' }).waitFor();
  await page.locator('[data-settings-page=agent]').click(); await page.locator('#settingsMcpReload').click();
  await page.locator('#settingsMcpStatus').filter({ hasText: 'No MCP servers' }).waitFor();
  await page.locator('[data-settings-page=general-settings]').click(); await page.locator('#languageSelect').selectOption('zh-CN');
  await page.locator('[data-settings-page=personalization]').click(); assert.match(await page.locator('[data-settings-content=personalization] .developer-tools-section').textContent(), /项目指令/);
  assert.match(await page.locator('#settingsProjectAgents').inputValue(), /保留用户文本/);
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['personalization', 'storage', 'worktrees', 'agent']) {
      await page.evaluate(name => globalThis.__codexWebuiDebug.openSettings(name), name);
      assert.equal(await page.evaluate(() => document.querySelector('#settingsContent').scrollWidth > document.querySelector('#settingsContent').clientWidth + 1), false, name + ' overflow');
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(await fixture.executions(), []);
  console.log('PASS developer tools: project AGENTS preview/save, managed worktree lifecycle, cleanup preview, MCP inventory, bilingual narrow settings; zero executions');
} finally { await browser?.close(); await fixture.close(); }
