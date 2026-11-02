import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { chromium } from 'playwright';
import { root, artifact, launchOptions } from '../helpers/browser-runtime.mjs';
const baseDir = await mkdtemp('/tmp/crw-interactions-'),
  home = join(baseDir, 'home'),
  project = join(baseDir, 'project'),
  codex = join(home, '.codex'),
  log = join(baseDir, 'rpc.jsonl');
await mkdir(codex, { recursive: true });
await mkdir(join(codex, 'sessions'));
await writeFile(join(codex, 'sessions/test.jsonl'), 'fixture chat storage');
await mkdir(project);
await mkdir(join(project, 'docs'));
await mkdir(join(project, 'source-skill'));
await writeFile(join(project, 'README.md'), '# Project\nA local fixture.');
await writeFile(join(project, 'docs/notes.txt'), 'Project notes');
await writeFile(
  join(project, 'source-skill/SKILL.md'),
  '---\nname: local-demo\ndescription: A local workflow\n---\nRead files.'
);
await writeFile(
  join(project, 'sample.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6wZAAAAAASUVORK5CYII=',
    'base64'
  )
);
const port = await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  }),
  base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  HOME: home,
  CODEX_HOME: codex,
  CODEX_AUTH_PATH: join(codex, 'auth.json'),
  CODEX_WEBUI_CWD: project,
  CODEX_WEBUI_REVIEW_ROOT: project,
  CODEX_WEBUI_AUTH_MODE: 'local',
  HOST: '127.0.0.1',
  PORT: String(port),
  CODEX_WEBUI_ENABLE_TERMINAL: 'false',
  CODEX_WEBUI_FIXTURE_RESOURCES: 'true',
  CODEX_WEBUI_FIXTURE_LOG: log,
  PATH: `${join(root, 'tests/fixtures')}${delimiter}${process.env.PATH}`
};
const start = () =>
  Bun.spawn(['bun', 'src/server/index.ts'], {
    cwd: root,
    env,
    stdout: 'ignore',
    stderr: 'ignore'
  });
let gateway = start(),
  browser,
  page,
  phase = 'startup';
async function ready() {
  for (let i = 0; ; i++) {
    try {
      if ((await (await fetch(base + '/api/health')).json()).codex) return;
    } catch {}
    if (i > 100) throw new Error('Startup failed');
    await Bun.sleep(50);
  }
}
const mutations = (payload) =>
  fetch(base + '/api/schedules', {
    method: 'POST',
    headers: {
      origin: base,
      'content-type': 'application/json',
      'x-workspace-request': '1'
    },
    body: JSON.stringify({ ...payload, confirmed: true })
  });
async function connected(p) {
  await p.goto(base, { waitUntil: 'networkidle' });
  await p.waitForFunction(
    () =>
      globalThis.__codexWebuiDebug?.state.connected &&
      globalThis.__codexWebuiDebug.state.threads.length
  );
}
async function confirm(parent) {
  const panel = parent.locator('.resource-confirm');
  await panel.waitFor({ state: 'visible' });
  await panel.getByRole('button', { name: 'Confirm', exact: true }).click();
}
async function closeFeature() {
  await page.locator('#closeWorkspaceFeature').click();
}
try {
  await ready();
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: 'dark'
  });
  await context.addInitScript(() => {
    if (window === window.top) localStorage.setItem('codex-webui-locale', 'en');
  });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await connected(page);
  for (const endpoint of ['/api/schedules', '/api/customize']) {
    for (const overrides of [
      {},
      { origin: 'https://evil.example', 'x-workspace-request': '1' }
    ]) {
      const denied = await fetch(base + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...overrides },
        body: JSON.stringify({ confirmed: true, action: 'create' })
      });
      assert([401, 403].includes(denied.status));
    }
  }
  phase = 'header and notification ordering';
  assert.equal(await page.locator('#productModeButton svg').count(), 0);
  assert.notEqual(
    await page.locator('#productModeButton').evaluate((el) => el.tagName),
    'BUTTON'
  );
  await page.locator('#sidebarNotificationsButton').click();
  assert.equal(await page.locator('#settingsDialog').isVisible(), false);
  await page.evaluate(() =>
    globalThis.__codexWebuiDebug.notify('turn/completed', {
      threadId: 'thread-B',
      turn: { id: 'background', status: 'completed', items: [] }
    })
  );
  assert.equal(
    await page
      .locator('[data-section=recents] [data-id]')
      .first()
      .getAttribute('data-id'),
    'thread-B'
  );
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(
    await page
      .locator('#sidebarNotificationsButton')
      .getAttribute('aria-pressed'),
    'true'
  );
  phase = 'Dock management';
  await page.locator('#railMore').click();
  await page
    .getByRole('menuitem', { name: 'Manage Dock', exact: true })
    .click();
  await page
    .locator('.dock-manager-row')
    .getByRole('checkbox', { name: 'Images', exact: true })
    .uncheck();
  assert.equal(await page.locator('#railImages').isVisible(), false);
  await closeFeature();
  await page.locator('#railMore').click();
  await page.getByRole('menuitem', { name: 'Images', exact: true }).click();
  await page.locator('.resource-image-card').waitFor();
  await closeFeature();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#railImages').isVisible(), false);
  await page.locator('#railMore').click();
  await page
    .getByRole('menuitem', { name: 'Manage Dock', exact: true })
    .click();
  await page
    .locator('.dock-manager-row')
    .getByRole('checkbox', { name: 'Images', exact: true })
    .check();
  await closeFeature();
  phase = 'Files project browse/search/preview/reference';
  await page.locator('#toggleSidePanel').click();
  await page.locator('[data-side-panel-action=files]').click();
  await page.getByRole('treeitem',{name:'README.md',exact:true}).locator('.explorer-row-line').click();
  await page.locator('.explorer-markdown').filter({hasText:'A local fixture.'}).waitFor();
  assert.equal(await page.locator('.explorer-preview').getByRole('link',{name:'Download',exact:true}).count(),1);
  await page.getByRole('button',{name:'Back to files',exact:true}).click();
  await page.locator('#sideFileSearch').fill('notes');
  await page.getByRole('treeitem',{name:'docs/notes.txt',exact:true}).locator('.explorer-row-line').click();
  await page.locator('.explorer-preview').getByRole('button',{name:'Reference in chat',exact:true}).click();
  assert.match(await page.locator('#prompt').inputValue(),/@docs\/notes.txt/);
  let card;
  await page.locator('#closeSidePanel').click();
  await page.locator('#railLibrary').click();
  await page.locator('.workspace-feature-empty').filter({hasText:'No shared files yet.'}).waitFor();
  assert.equal(await page.locator('#workspaceFeatureContent h2').count(),0);
  phase = 'Images local and historical';
  await page.locator('#railImages').click();
  await page.locator('.resource-image-card button').first().click();
  await page.locator('#imageViewer[open]').waitFor();
  await page.locator('#closeImageViewer').click();
  await page.locator('#imageSource').selectOption('history');
  await page.locator('.resource-image-card').waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Open chat', exact: true }).count(),
    1
  );
  await closeFeature();
  phase = 'Customize plugin controls';
  await page.locator('#railCustomize').click();
  card = page
    .locator('.workspace-resource-card')
    .filter({ hasText: 'Fixture Docs' });
  await card.locator('[data-customize-action=disable]').click();
  await confirm(card);
  await card.locator('[data-customize-action=enable]').waitFor();
  await card.locator('[data-customize-action=enable]').click();
  await confirm(card);
  await card.locator('[data-customize-action=uninstall]').click();
  await confirm(card);
  await card.locator('[data-customize-action=install]').click();
  await confirm(card);
  await card.locator('[data-customize-action=uninstall]').waitFor();
  phase = 'Customize skill controls and local installation';
  await page.locator('[data-customize-tab=skills]').click();
  card = page
    .locator('.workspace-resource-card')
    .filter({ hasText: 'fixture-skill' });
  await card.locator('[data-customize-action=disable]').click();
  await confirm(card);
  await card.locator('[data-customize-action=enable]').waitFor();
  await card.locator('[data-customize-action=enable]').click();
  await confirm(card);
  await page
    .getByRole('textbox', { name: 'Local skill folder', exact: true })
    .fill(join(project, 'source-skill'));
  const skillInstallForm = page.locator('.skill-install-form');
  await skillInstallForm.waitFor({ state: 'visible' });
  await skillInstallForm.evaluate((form) => form.requestSubmit());
  await confirm(skillInstallForm);
  card = page
    .locator('.workspace-resource-card')
    .filter({ hasText: 'local-demo' });
  await card.locator('[data-customize-action=uninstall]').click();
  await confirm(card);
  await page
    .locator('.workspace-resource-card h2')
    .filter({ hasText: 'local-demo' })
    .waitFor({ state: 'hidden' });
  await closeFeature();
  phase = 'Scheduler persistent form and background run';
  await page.locator('#railScheduled').click();
  await page.getByRole('button', { name: 'New schedule', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task name', exact: true })
    .fill('Background review');
  await page
    .getByRole('textbox', { name: 'Task instructions', exact: true })
    .fill('Read files only.');
  await page
    .getByRole('button', { name: 'Save schedule', exact: true })
    .click();
  await confirm(page.locator('.schedule-form'));
  await page
    .locator('.schedule-list h2')
    .filter({ hasText: 'Background review' })
    .waitFor();
  card = page.locator('.schedule-list article').first();
  await card.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.waitForTimeout(4200);
  assert.equal(
    await card.locator('.resource-confirm').isVisible(),
    true,
    'Poll must not discard confirmation'
  );
  await confirm(card);
  await closeFeature();
  await page.waitForFunction(async () => {
    const data = await (await fetch('/api/schedules')).json();
    return data.runs[0]?.status === 'completed';
  });
  const firstState = await (await fetch(base + '/api/schedules')).json();
  assert.equal(firstState.runs.length, 1);
  assert.equal(firstState.jobs[0].enabled, false);
  assert.equal(
    (await readFile(log, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('turn/start')).length,
    1
  );
  // Close the browser tab: an enabled due task still runs in the gateway.
  const job = firstState.jobs[0];
  let response = await mutations({
    action: 'create',
    requestId: crypto.randomUUID(),
    task: {
      name: 'Automatic run',
      prompt: 'Read only in background.',
      cwd: project,
      model: '',
      sandbox: 'read-only',
      intervalMs: 0,
      nextRunAt: new Date(Date.now() + 1000).toISOString(),
      enabled: true
    }
  });
  assert.equal(response.status, 200);
  await page.close();
  await Bun.sleep(11000);
  const after = await (await fetch(base + '/api/schedules')).json();
  assert.equal(after.runs.length, 2);
  assert.equal(after.runs[1].status, 'completed');
  assert.equal(
    (await readFile(log, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('turn/start')).length,
    2
  );
  gateway.kill('SIGTERM');
  await gateway.exited;
  gateway = start();
  await ready();
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => errors.push(e.message));
  await connected(page);
  await page.locator('#railScheduled').click();
  await page.locator('[data-run-status=completed]').first().waitFor();
  assert.equal(await page.locator('[data-run-status=completed]').count(), 2);
  await closeFeature();
  // Exercise startup ticks and simultaneous reads after repeated process handoffs.
  for (let round = 0; round < 3; round++) {
    gateway.kill('SIGTERM');
    await gateway.exited;
    gateway = start();
    await ready();
    const reads = await Promise.all(
      Array.from({ length: 12 }, () => fetch(base + '/api/schedules'))
    );
    for (const response of reads) {
      assert.equal(response.status, 200);
      assert.equal(
        (await response.json()).runs.filter((run) => run.status === 'completed')
          .length,
        2
      );
    }
  }
  await connected(page);
  phase = 'dark rounded selects and storage';
  await page.evaluate(() =>
    globalThis.__codexWebuiDebug.openSettings('general-settings')
  );
  const trigger = page.locator('[data-select=languageSelect]');
  await trigger.click();
  await page.locator('.workspace-select-popup').waitFor();
  const popup = await page
    .locator('.workspace-select-popup')
    .evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      radius: getComputedStyle(el).borderRadius,
      color: getComputedStyle(el).color
    }));
  assert.notEqual(popup.background, 'rgb(255, 255, 255)');
  assert(parseInt(popup.radius) >= 12);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#languageSelect').inputValue(), 'en');
  await page.locator('[data-settings-page=storage]').click();
  await page
    .locator('.storage-segments > span')
    .first()
    .waitFor({ state: 'attached' });
  const weights = await page
    .locator('.storage-segments > span')
    .evaluateAll((nodes) => nodes.map((el) => Number(el.style.flexGrow)));
  assert(weights.some((n) => n > 0));
  await page.screenshot({ path: artifact('interactions-storage-dark.png') });
  await page.evaluate(() => globalThis.__codexWebuiDebug.closeSettings());
  phase = 'desktop split panel toggle';
  const before = await page.locator('.conversation-shell').boundingBox();
  await page.locator('#toggleSidePanel').click();
  await page.waitForTimeout(350);
  const chat = await page.locator('.conversation-shell').boundingBox(),
    side = await page.locator('#sidePanel').boundingBox();
  assert(chat.x + chat.width <= side.x + 1);
  assert(chat.width < before.width - 200);
  await page.locator('#toggleSidePanel').click();
  assert.equal(await page.locator('#sidePanel').isVisible(), false);
  for (const width of [768, 820, 1024, 1180]) {
    phase = `tablet ${width}`;
    const tablet = await browser.newContext({
      viewport: { width, height: 1024 },
      hasTouch: true,
      isMobile: true,
      colorScheme: 'dark'
    });
    await tablet.addInitScript(() => {
      if (window === window.top)
        localStorage.setItem('codex-webui-locale', 'en');
    });
    const p = await tablet.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await connected(p);
    await p.locator('#prompt').fill('Tablet draft');
    await p.locator('#toggleSidePanel').click();
    await p.waitForTimeout(350);
    const boxes = await p.evaluate(() => {
      const c = document
          .querySelector('.conversation-shell')
          .getBoundingClientRect(),
        r = document.querySelector('#sidePanel').getBoundingClientRect();
      return {
        right: c.right,
        panel: r.left,
        width: document.documentElement.scrollWidth,
        viewport: innerWidth
      };
    });
    assert(boxes.right <= boxes.panel + 1, JSON.stringify(boxes));
    assert(boxes.width <= boxes.viewport + 1, JSON.stringify(boxes));
    await p.locator('#toggleSidePanel').click();
    assert.equal(await p.locator('#sidePanel').isVisible(), false);
    await p.waitForFunction(() => {
      const c = document
        .querySelector('.conversation-shell')
        .getBoundingClientRect();
      return (
        c.right >
        document.querySelector('#app').getBoundingClientRect().right - 2
      );
    });
    assert.equal(await p.locator('#prompt').inputValue(), 'Tablet draft');
    await p.locator('#toggleSidePanel').click();
    await p.waitForTimeout(350);
    await p.screenshot({ path: artifact(`interactions-tablet-${width}.png`) });
    await tablet.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Dock controls, notification sorting, local/historical images, Library, plugin/skill management, background scheduling and persistence, dark selects/storage, tablet split panels'
  );
} catch (error) {
  console.error('Failed phase:', phase);
  console.error(
    'Scheduler response:',
    await (await fetch(base + '/api/schedules')).text()
  );
  const { createScheduleStore } = await import(
    '../../src/server/services/schedule-store.js'
  );
  try {
    console.error(
      'Store diagnostics:',
      JSON.stringify(await createScheduleStore(codex).read())
    );
  } catch (problem) {
    console.error('Store error:', problem);
  }
  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: artifact('interactions-failure.png') })
      .catch(() => {});
    console.error(
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    );
  }
  throw error;
} finally {
  await browser?.close();
  gateway.kill('SIGTERM');
  await gateway.exited;
  await rm(baseDir, { recursive: true, force: true });
}
