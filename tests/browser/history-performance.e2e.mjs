import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { isolatedWorkspace } from '../helpers/isolated-workspace.mjs';
import { artifact, launchOptions, root } from '../helpers/browser-runtime.mjs';

// Comparable synthetic baseline: export HEAD, run both versions against the
// same CURRENT offline native fixture and browser. No native tools/models run.
const temporary = await mkdtemp('/tmp/crw-perf-'), baselineRoot = join(temporary, 'baseline');
let browser;
async function run(args, cwd = root, stdout = 'pipe') {
  const child = Bun.spawn(args, {cwd, stdout, stderr: 'pipe'});
  const error = new Response(child.stderr).text();
  const output = stdout === 'pipe' ? new Response(child.stdout).text() : '';
  const [code, err, out] = await Promise.all([child.exited, error, output]);
  assert.equal(code, 0, `${args.join(' ')}: ${err.slice(-2000)}`); return out;
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  const baselineCommit = (await run(['git', 'rev-parse', 'HEAD'])).trim();
  const archive = join(temporary, 'baseline.tar');
  await run(['git', 'archive', '--format=tar', '--output=' + archive, baselineCommit]);
  await mkdir(baselineRoot); await run(['tar', '-xf', archive, '-C', baselineRoot]);
  await symlink(join(root, 'node_modules'), join(baselineRoot, 'node_modules'), 'dir');
  browser = await chromium.launch(launchOptions());
  const report = { baselineCommit, samplesPerVersion: 5, fixture: {turns: 25, workItemsPerTurn: 18, intentionalHistoryDelayMs: 1200, streamChunks: 250, diffAddedLines: 500, diffDeletedLines: 500, treeFiles: 400, editorLines: 2000}, engine: 'Chromium ' + browser.version(), versions: {}, note: 'Five independent pages per version, same fixture and viewport. Includes loopback I/O and layout; serial runs are noisy and do not establish production or physical-device performance. Baseline is HEAD, candidate is the working tree; no improvement is assumed.' };
  for (const [name, sourceRoot] of [['baseline', baselineRoot], ['candidate', root]]) {
    const fixture = await isolatedWorkspace({CODEX_WEBUI_FIXTURE_PROGRESS: 'true'}, {sourceRoot, fixtureRoot: root});
    try {
      const files = Array.from({length: 400}, (_, i) => writeFile(join(fixture.project, `file-${String(i).padStart(3, '0')}.ts`), Array.from({length: i === 0 ? 2000 : 2}, (_, line) => `export const value${line} = ${line};`).join('\n')));
      await Promise.all(files);
      const samples = [];
      for (let sample = 0; sample < 5; sample++) {
        const context = await browser.newContext({viewport: {width: 1440, height: 1000}, colorScheme: 'dark'});
        await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
        const page = await context.newPage(); page.setDefaultTimeout(25000);
        try {
          await page.goto(fixture.base); await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected);
          const history = await page.evaluate(async () => {
            const ticks = [], started = performance.now(); let last = started;
            const timer = setInterval(() => {const now = performance.now(); ticks.push(now - last); last = now;}, 20);
            const loaded = await globalThis.__codexWebuiDebug.openThread('progress-history');
            clearInterval(timer);
            return {loaded, historyMs: performance.now() - started, maxTimerGapMs: Math.max(0, ...ticks), responsiveTicks: ticks.length, historyDomNodes: document.querySelectorAll('*').length};
          });
          assert.equal(history.loaded, true); assert(history.responsiveTicks > 2); assert(history.historyMs < 20000);
          const stream = await page.evaluate(async () => {
            const api = globalThis.__codexWebuiDebug, threadId = 'progress-history', turnId = 'benchmark-stream';
            const started = performance.now();
            api.notify('turn/started', {threadId, turn: {id: turnId, status: 'inProgress'}});
            api.notify('item/started', {threadId, turnId, item: {id: 'stream-answer', type: 'agentMessage', phase: 'final_answer', text: ''}});
            let maxBatchMs = 0;
            for (let chunk = 0; chunk < 250; chunk++) {
              const batch = performance.now(); api.notify('item/agentMessage/delta', {threadId, turnId, itemId: 'stream-answer', delta: 'stream fragment ' + chunk + '. '}); maxBatchMs = Math.max(maxBatchMs, performance.now() - batch);
              if (chunk % 25 === 24) await new Promise(requestAnimationFrame);
            }
            api.notify('turn/completed', {threadId, turn: {id: turnId, status: 'completed', items: []}});
            await new Promise(requestAnimationFrame);
            return {streamMs: performance.now() - started, maxStreamNotifyMs: maxBatchMs};
          });
          const diff = await page.evaluate(async () => {
            const api = globalThis.__codexWebuiDebug, started = performance.now();
            const patch = 'diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n@@ -1,500 +1,500 @@\n' + Array.from({length: 500}, (_, i) => '-const old' + i + ' = 0;\n').join('') + Array.from({length: 500}, (_, i) => '+const updated' + i + ' = 1;\n').join('');
            api.notify('turn/diff/updated', {threadId: 'progress-history', turnId: 'benchmark-stream', diff: patch});
            document.querySelector('#toggleSidePanel').click(); document.querySelector('[data-side-panel-action=review]').click();
            await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
            return {diffMs: performance.now() - started, diffRows: document.querySelectorAll('.review-line.add,.review-line.delete').length, diffFiles: document.querySelectorAll('.review-file').length};
          });
          assert(diff.diffFiles > 0, 'large diff must actually render');
          assert.equal(diff.diffRows, 1000, 'all synthetic diff lines must render');
          await page.locator('#closeSidePanel').click();
          const treeStart = performance.now();
          await page.locator('#toggleSidePanel').click(); await page.locator('#openSidePanelTab').click(); await page.locator('[data-side-panel-action=files]').click();
          await page.locator('#sideFileContent').getByRole('treeitem', {name: 'file-000.ts', exact: true}).waitFor();
          while (!await page.locator('#sideFileContent').getByRole('treeitem', {name: 'file-399.ts', exact: true}).count()) {
            await page.locator('#sideFileContent .explorer-load-more').click();
            await page.waitForTimeout(30);
          }
          const treeMs = performance.now() - treeStart;
          const editorStart = performance.now();
          await page.locator('#sideFileContent').getByRole('treeitem', {name: 'file-000.ts', exact: true}).locator(':scope > .explorer-row-line').click();
          await page.locator('.explorer-code .tok-keyword').first().waitFor();
          await page.getByRole('button', {name: 'Edit file', exact: true}).click(); await page.locator('.cm-content').waitFor();
          const editorMs = performance.now() - editorStart;
          const metrics = {...history, ...stream, ...diff, treeMs, editorMs};
          samples.push(metrics); console.log(`${name} sample ${sample + 1}: ${JSON.stringify(metrics)}`);
        } finally { await context.close(); }
      }
      assert.deepEqual(await fixture.executions(), []);
      const keys = ['historyMs', 'maxTimerGapMs', 'historyDomNodes', 'streamMs', 'maxStreamNotifyMs', 'diffMs', 'treeMs', 'editorMs'];
      report.versions[name] = {samples, medians: Object.fromEntries(keys.map(key => [key, median(samples.map(sample => sample[key]))]))};
    } finally { await fixture.close(); }
  }
  report.candidateToBaseline = Object.fromEntries(Object.keys(report.versions.baseline.medians).map(key => [key, report.versions.candidate.medians[key] / report.versions.baseline.medians[key]]));
  await writeFile(artifact('history-performance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('PASS comparable synthetic benchmark: ' + JSON.stringify({baselineCommit, medians: Object.fromEntries(Object.entries(report.versions).map(([name, data]) => [name, data.medians])), ratios: report.candidateToBaseline}));
} finally { await browser?.close(); await rm(temporary, {recursive: true, force: true}); }
