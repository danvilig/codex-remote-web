import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { demoThreadId } from '../fixtures/product-demo.mjs';
import { root } from './browser-runtime.mjs';
import { isolatedWorkspace } from './isolated-workspace.mjs';

// Run with bun tests/helpers/product-preview.mjs. Only the disposable preview
// receives the bootstrap script, which uses the product's normal chat restore.
const sourceRoot = await mkdtemp('/tmp/crw-product-preview-');
let fixture;
try {
  await Promise.all([
    cp(join(root, 'src'), join(sourceRoot, 'src'), { recursive: true }),
    cp(join(root, 'public'), join(sourceRoot, 'public'), { recursive: true }),
    cp(join(root, 'package.json'), join(sourceRoot, 'package.json')),
    symlink(join(root, 'node_modules'), join(sourceRoot, 'node_modules'), 'dir'),
  ]);
  const index = join(sourceRoot, 'public/index.html');
  const html = await readFile(index, 'utf8');
  const bootstrap = `<script>
  const params = new URLSearchParams(location.search);
  const preview = params.has('demo');
  if (preview || !localStorage.getItem('codex-webui-active-thread')) {
    localStorage.setItem('codex-webui-active-thread', ${JSON.stringify(demoThreadId)});
  }
  if (!localStorage.getItem('codex-webui-locale')) localStorage.setItem('codex-webui-locale', 'zh-CN');
  if (preview) {
    const observer = new MutationObserver(() => {
      const turn = document.querySelector('[data-turn-id="product-preview-turn"][data-completed="true"]');
      if (!turn?.querySelector('.turn-message-actions') || document.querySelector('#conversation[aria-busy=true]')) return;
      observer.disconnect();
      if (params.has('activity')) {
        requestAnimationFrame(() => {
          const api = globalThis.__codexWebuiDebug, threadId = ${JSON.stringify(demoThreadId)}, turnId = 'preview-running';
          api.syncTurnSnapshot({id:turnId,status:'inProgress',startedAtMs:Date.now()-18000,items:[
            {id:'preview-task',type:'userMessage',content:[{type:'text',text:'检查新布局在手机上是否正常。'}]},
            {id:'preview-note',type:'agentMessage',phase:'commentary',text:'已检查主要界面，正在运行窄屏回归。'},
            {id:'preview-command',type:'commandExecution',status:'inProgress',command:'bun run test:mobile',aggregatedOutput:'Running layout checks…'},
          ]});
          api.notify('turn/plan/updated',{threadId,turnId,plan:[
            {step:'检查组件布局',status:'completed'},{step:'运行窄屏回归',status:'inProgress'},{step:'核对验收结果',status:'pending'},
          ]});
          requestAnimationFrame(() => api.scrollOpenedThreadToBottom());
        });
        return;
      }
      turn.querySelector('.turn-answer-toggle:not([hidden])[aria-expanded="false"]')?.click();
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        document.querySelector('#conversation').scrollTop = 0;
      })));
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-busy'] });
  }
  </script>`;
  await writeFile(index, html.replace('<head>', `<head>\n${bootstrap}`));

  fixture = await isolatedWorkspace({
    CODEX_WEBUI_CODEX: join(root, 'tests/fixtures/codex'),
    CODEX_WEBUI_FIXTURE_PRODUCT_DEMO: 'true',
    CODEX_WEBUI_NTFY_TOPIC: '',
    CODEX_WEBUI_PROJECTLESS: 'false',
  }, { sourceRoot });
  console.log(`${fixture.base}/?demo`);
  await new Promise(resolve => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
} finally {
  try { await fixture?.close(); }
  finally { await rm(sourceRoot, { recursive: true, force: true }); }
}
