import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { chromium } from 'playwright';
import { root, artifact, launchOptions } from '../helpers/browser-runtime.mjs';
const fixture = mkdtempSync(join(root, '.artifacts/settings-complete-'));
const port = await new Promise(resolve => { const server = createServer(); server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))}); });
const base=`http://127.0.0.1:${port}`;
const project=join(fixture,'project'),codexHome=join(fixture,'.codex');mkdirSync(project);mkdirSync(codexHome);
mkdirSync(join(codexHome,'sessions')); writeFileSync(join(codexHome,'sessions/chat.jsonl'),'12345');
mkdirSync(join(codexHome,'archived_sessions')); writeFileSync(join(codexHome,'archived_sessions/chat.jsonl'),'123');
const init=Bun.spawn(['git','init','-q',project],{stdout:'ignore',stderr:'ignore'});assert.equal(await init.exited,0);
const log=join(fixture,'executions.jsonl');
const server=Bun.spawn(['bun','run','src/server/index.ts'],{cwd:root,env:{...process.env,HOME:fixture,CODEX_HOME:codexHome,CODEX_AUTH_PATH:join(fixture,'auth.json'),HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_AUTH_MODE:'local',CODEX_WEBUI_CWD:project,CODEX_WEBUI_REVIEW_ROOT:project,CODEX_WEBUI_ENABLE_TERMINAL:'false',CODEX_WEBUI_FIXTURE_LOG:log,PATH:join(root,'tests/fixtures')+delimiter+process.env.PATH},stdout:'ignore',stderr:'ignore'});
let browser;
try {
  for(let i=0;;i++){try{if((await(await fetch(base+'/api/health')).json()).codex)break}catch{}if(i>100)throw Error('Fixture failed to start');await Bun.sleep(50)}
  const initialSettings=await(await fetch(base+'/api/settings')).json();
  assert.equal((await fetch(base+'/api/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({version:initialSettings.version,values:{developer_instructions:'测'.repeat(5000)}})})).status,200);
  browser=await chromium.launch(launchOptions());
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US',colorScheme:'dark'});
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/settings/general-settings',{waitUntil:'networkidle'});
  await page.locator('#languageSelect').selectOption('zh-CN');
  await page.waitForFunction(()=>document.documentElement.lang==='zh-CN');
  assert.equal(await page.locator('#settingsPageTitle').textContent(),'通用');
  await page.reload({waitUntil:'networkidle'});assert.equal(await page.locator('#languageSelect').inputValue(),'zh-CN');
  await page.locator('#settingsSearch').fill('network');
  assert.deepEqual(await page.locator('[data-settings-page]:visible').allTextContents(),['配置']);
  await page.locator('#settingsSearch').fill('沙箱');assert.deepEqual(await page.locator('[data-settings-page]:visible').allTextContents(),['配置']);
  await page.locator('#clearSettingsSearch').click();
  await page.locator('[data-settings-page=agent]').click();
  await page.waitForFunction(()=>!document.querySelector('#settingsNativeFields').disabled);
  await page.locator('#settingsApproval').selectOption('on-request');await page.locator('#settingsSandbox').selectOption('read-only');
  await page.locator('label:has(#settingsNetwork) .settings-switch').click();
  await page.locator('#settingsNativeSave').click();
  await page.waitForFunction(()=>!document.querySelector('#settingsNativeFields').disabled && document.querySelector('#settingsNativeSave').disabled);
  let saved=await(await fetch(base+'/api/settings')).json();
  assert.equal(saved.values.approval_policy,'on-request');assert.equal(saved.values.sandbox_mode,'read-only');assert.equal(saved.values['sandbox_workspace_write.network_access'],true);
  await page.locator('#settingsUseConfig').click();
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.permissionMode),'config');
  assert.deepEqual(await page.evaluate(()=>globalThis.__codexWebuiDebug.permissionThreadPolicy()),{});
  assert.deepEqual(await page.evaluate(()=>globalThis.__codexWebuiDebug.permissionTurnPolicy('/example')),{});
  await page.locator('[data-settings-page=personalization]').click();
  await page.locator('label:has(#settingsMemoryGenerate) .settings-switch').click();await page.locator('label:has(#settingsMemoryUse) .settings-switch').click();
  await page.locator('#settingsInstructions').fill('Settings - 请保持此自定义内容，不要翻译');
  await page.locator('#settingsPersonalSave').click();await page.waitForFunction(()=>!document.querySelector('#settingsInstructions').disabled && document.querySelector('#settingsPersonalSave').disabled);
  saved=await(await fetch(base+'/api/settings')).json();
  assert.equal(saved.values['memories.generate_memories'],false);assert.equal(saved.values['memories.use_memories'],false);assert.equal(saved.values.developer_instructions,'Settings - 请保持此自定义内容，不要翻译');
  await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>!document.querySelector('#settingsInstructions').disabled);
  assert.equal(await page.locator('#settingsMemoryUse').isChecked(),false);
  assert.equal(await page.locator('#settingsInstructions').inputValue(),'Settings - 请保持此自定义内容，不要翻译');
  // Concurrent config changes produce a conflict, retain edits, and require deliberate reload.
  await page.locator('#settingsInstructions').fill('Unsaved local instructions');
  assert.equal((await fetch(base+'/api/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({version:saved.version,values:{model_verbosity:'high'}})})).status,200);
  await page.locator('#settingsPersonalSave').click();await page.waitForFunction(()=>document.querySelector('#settingsPersonalStatus').textContent.includes('重新加载'));
  assert.equal(await page.locator('#settingsInstructions').inputValue(),'Unsaved local instructions');
  page.once('dialog',dialog=>dialog.accept());await page.locator('#settingsPersonalReload').click();
  await page.waitForFunction(()=>document.querySelector('#settingsInstructions').value==='Settings - 请保持此自定义内容，不要翻译');
  await page.screenshot({path:artifact('settings-personalization-zh.png')});
  await page.locator('[data-settings-page=data-controls]').click();
  await page.locator('#settingsArchiveList .settings-action').first().waitFor();
  assert.equal(await page.locator('#settingsArchiveList .settings-action').count(),2);
  await page.locator('#settingsArchiveType').selectOption('subagent');assert.equal(await page.locator('#settingsArchiveList .settings-action').count(),1);
  await page.locator('#settingsArchiveType').selectOption('');await page.locator('#settingsArchiveSearch').fill('archived-one');
  assert.equal(await page.locator('#settingsArchiveList .settings-action').count(),1);
  await page.locator('#settingsArchiveList .settings-action').click();
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug.state.threads.some(thread=>thread.id==='archived-one'));
  await page.locator('#settingsArchiveSearch').fill('');assert.equal(await page.locator('#settingsArchiveList .settings-action').count(),1);
  await page.reload({waitUntil:'networkidle'});await page.locator('#settingsArchiveList .settings-action').waitFor();assert.equal(await page.locator('#settingsArchiveList .settings-action').count(),1);
  await page.locator('[data-settings-page=storage]').click();await page.locator('#settingsStorageRows .settings-row').first().waitFor();
  const usage=await(await fetch(base+'/api/settings/storage')).json();assert.equal(usage.groups.sessions,5);assert.equal(usage.groups.archived,3);
  await page.screenshot({path:artifact('settings-storage-zh.png')});
  await page.locator('#settingsStorageWorktrees').click();await page.locator('#settingsWorktreeList .settings-row').first().waitFor();
  assert.match(await page.locator('#settingsWorktreeList').textContent(),new RegExp(project));
  // Persisted permission selection sends no browser overrides in the actual turn request.
  await page.locator('#closeSettingsNav').click();await page.locator('#prompt').fill('Isolated native permissions');await page.locator('#sendButton').click();
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug.state.active?.id==='new-thread');
  let turns;for(let i=0;;i++){try{turns=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));if(turns.length)break}catch{}if(i>50)throw Error('Turn not logged');await Bun.sleep(20)}
  assert.equal(turns.length,1);for(const field of ['approvalPolicy','sandboxPolicy','permissions'])assert.equal(Object.hasOwn(turns[0].params,field),false);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openSettings('general-settings'));
  await page.locator('#languageSelect').selectOption('en');assert.equal(await page.locator('#settingsPageTitle').textContent(),'General');
  await page.locator('#settingsSearch').fill('记忆');assert.deepEqual(await page.locator('[data-settings-page]:visible').allTextContents(),['Personalization']);await page.locator('#clearSettingsSearch').click();
  await page.locator('[data-settings-page=data-controls]').click();
  assert.equal(await page.locator('#settingsArchiveProject option[value=""]').textContent(),'All projects');
  assert.equal(await page.locator('#settingsArchiveStatus').textContent(),'Archived chats loaded');
  await page.locator('[data-settings-page=personalization]').click();assert.equal(await page.locator('label:has(#settingsMemoryUse) strong').textContent(),'Use memories');
  // Every added page remains within a narrow viewport; code and user text stay intact.
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});
    for(const name of ['general-settings','agent','personalization','data-controls','storage','worktrees']){
      await page.evaluate(name=>globalThis.__codexWebuiDebug.openSettings(name),name);
      await page.waitForTimeout(50);
      const overflow=await page.evaluate(()=>[...document.querySelectorAll('.settings-page:not([hidden]),.settings-page:not([hidden]) input,.settings-page:not([hidden]) select,.settings-page:not([hidden]) textarea')].filter(node=>node.getClientRects().length).filter(node=>{const r=node.getBoundingClientRect();return r.left < -1 || r.right > innerWidth+1}).map(node=>node.id||node.tagName));
      assert.deepEqual(overflow,[],`${name} at ${width}px`);
    }
  }
  await page.screenshot({path:artifact('settings-worktrees-mobile.png')});assert.deepEqual(errors,[]);
  console.log('PASS: bilingual settings and search, native config persistence/conflicts, memory and custom instructions, actual permission inheritance, archive restoration, storage/worktrees, mobile bounds');
}finally{await browser?.close();server.kill('SIGTERM');await server.exited;rmSync(fixture,{recursive:true,force:true})}
