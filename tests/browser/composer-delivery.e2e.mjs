import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { chromium } from 'playwright';
import { root, artifact, launchOptions } from '../helpers/browser-runtime.mjs';

const temp=await mkdtemp('/tmp/crw-delivery-'),home=join(temp,'home'),project=join(temp,'project'),log=join(temp,'rpc.jsonl');
await Promise.all([mkdir(home),mkdir(project)]);
const port=await new Promise(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});}),base=`http://127.0.0.1:${port}`;
const server=Bun.spawn(['bun','src/server/index.ts'],{cwd:root,stdout:'ignore',stderr:'ignore',env:{...process.env,HOST:'127.0.0.1',PORT:String(port),HOME:home,CODEX_HOME:home,CODEX_AUTH_PATH:join(home,'missing-auth.json'),CODEX_WEBUI_CWD:project,CODEX_WEBUI_AUTH_MODE:'local',CODEX_WEBUI_APP_SERVER_MODE:'isolated',CODEX_WEBUI_FIXTURE_CONVERSATION_TOOLS:'true',CODEX_WEBUI_FIXTURE_TURN_DURATION_MS:'4500',CODEX_WEBUI_FIXTURE_LOG:log,PATH:join(root,'tests/fixtures')+delimiter+process.env.PATH}});
let browser,page,phase='startup';
const records=async()=>(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const wait=async predicate=>{for(let i=0;!await predicate();i++){if(i>250)throw Error('Timed out: '+phase);await Bun.sleep(40);}};
try{
  await wait(async()=>{try{return(await(await fetch(base+'/api/health')).json()).codex;}catch{return false;}});
  browser=await chromium.launch(launchOptions());const context=await browser.newContext({viewport:{width:1180,height:900}});
  await context.addInitScript(()=>{if(window!==window.top)return;localStorage.setItem('codex-webui-locale','en');const Native=WebSocket;globalThis.WebSocket=class extends Native{constructor(url,...args){if(new URL(url,location.href).pathname==='/ws')throw Error('Force SSE fixture');super(url,...args);}};});
  page=await context.newPage();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let release,held=false;
  await page.route('**/api/rpc',async route=>{
    const payload=route.request().postDataJSON(),text=payload.params?.input?.find(item=>item.type==='text')?.text||'';
    if(text==='force delivery failure'&&payload.method==='turn/steer'){await new Promise(resolve=>setTimeout(resolve,300));await route.fulfill({json:{type:'rpc/error',id:payload.id,error:'fixture rejected message'}});return;}
    if(text==='Initial delivery'||text==='Side initial delivery'){
      const response=await route.fetch();held=true;await new Promise(resolve=>release=resolve);await route.fulfill({response});return;
    }
    await route.continue();
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-A'));
  phase='immediate pending spinner and single dispatch';
  await page.locator('#prompt').fill('Initial delivery');await page.locator('#sendButton').click();await wait(()=>held);
  assert.equal(await page.locator('#sendButton').getAttribute('data-submit-mode'),'sending');
  assert.equal(await page.locator('#sendButton').getAttribute('aria-busy'),'true');assert.equal(await page.locator('#sendButton').isDisabled(),true);
  assert.notEqual(await page.locator('#sendButton .icon-slot').evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.locator('#composer').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
  assert.equal((await records()).filter(r=>r.method==='turn/start').length,1);
  await page.screenshot({path:artifact('composer-sending.png')});release();
  await page.waitForFunction(()=>document.querySelector('#sendButton').dataset.submitMode==='stop');
  phase='steering is immediate; queued input waits for completion';
  await page.locator('#prompt').fill('Immediate steering');await page.locator('#sendButton').click();
  await wait(async()=>(await records()).some(r=>r.method==='turn/steer'));
  assert.equal((await records()).filter(r=>r.method==='turn/start').length,1);
  const choice=page.locator('#composer .composer-delivery-choice');await choice.click();await page.getByRole('menuitem',{name:'Queue',exact:true}).click();
  for(const text of ['Queued first','Queued second [wait]']){await page.locator('#prompt').fill(text);await page.locator('#sendButton').click();await page.waitForFunction(()=>document.querySelector('#sendButton').getAttribute('aria-busy')==='false');}
  assert.equal(await page.locator('#composer .composer-queue-row').count(),2);
  assert.equal((await records()).filter(r=>r.method==='turn/start').length,1);
  await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('zh-CN'));
  assert.equal(await choice.innerText(),'排队');
  assert.equal(await page.locator('#composer .composer-queue-row small').first().innerText(),'等待当前轮完成');
  await page.screenshot({path:artifact('composer-queued-messages.png')});
  await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('en'));
  await page.locator('#prompt').fill('Draft typed while queued messages wait');
  await wait(async()=>(await records()).filter(r=>r.method==='turn/start').length===3);
  const starts=(await records()).filter(r=>r.method==='turn/start');assert.deepEqual(starts.map(r=>r.params.input[0].text),['Initial delivery','Queued first','Queued second [wait]']);
  assert.equal(await page.locator('#prompt').inputValue(),'Draft typed while queued messages wait');
  await page.waitForFunction(()=>document.querySelectorAll('#composer .composer-queue-row').length===0);
  await page.waitForFunction(()=>document.querySelector('#sendButton').dataset.submitMode==='queue');
  phase='cancel first queued item';
  await page.locator('#prompt').fill('Cancel this queue item');await page.locator('#sendButton').click();await page.waitForFunction(()=>document.querySelector('#sendButton').getAttribute('aria-busy')==='false');await page.getByRole('button',{name:'Cancel queued message',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('#composer .composer-queue-row').length===0);
  phase='enqueue before refresh';await page.locator('#prompt').fill('Keep queue after refresh');await page.locator('#sendButton').click();
  await page.waitForFunction(()=>document.querySelector('#sendButton').getAttribute('aria-busy')==='false');await page.reload({waitUntil:'domcontentloaded'});await page.locator('#composer .composer-queue-row').waitFor();
  assert.equal((await records()).filter(r=>r.method==='turn/start').length,3);
  for(const width of [820,390]){await page.setViewportSize({width,height:844});await page.waitForTimeout(150);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  await page.setViewportSize({width:1180,height:900});phase='cancel after refresh';
  await page.waitForFunction(()=>document.querySelector('#sendButton').getAttribute('aria-busy')==='false');await page.getByRole('button',{name:'Cancel queued message',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('#composer .composer-queue-row').length===0);
  await page.locator('#composer .composer-delivery-choice').click();await page.getByRole('menuitem',{name:'Steering',exact:true}).click();
  await page.locator('#prompt').fill('force delivery failure');await page.locator('#sendButton').click();
  assert.equal(await page.locator('#sendButton').getAttribute('aria-busy'),'true');
  await page.waitForFunction(()=>document.querySelector('#sendButton').getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#prompt').inputValue(),'force delivery failure');
  phase='side chat pending spinner, steering and queue';
  await page.locator('#toggleSidePanel').click();await page.locator('[data-side-panel-action=side-chat]').click();
  const side=page.locator('#sideChatPanel'),input=side.getByRole('textbox',{name:'Side chat message',exact:true});
  held=false;await input.fill('Side initial delivery');await side.locator('[data-side-composer=send]').click();await wait(()=>held);
  assert.equal(await side.locator('[data-side-composer=send]').getAttribute('aria-busy'),'true');release();
  await side.locator('.side-chat-stop').waitFor({state:'visible'});
  await input.fill('Side steering');await side.locator('[data-side-composer=send]').click();
  await wait(async()=>(await records()).some(r=>r.method==='turn/steer'&&r.params.input[0].text==='Side steering'));
  await side.locator('.composer-delivery-choice').click();await page.getByRole('menuitem',{name:'Queue',exact:true}).click();
  await input.fill('Side queued [wait]');await side.locator('[data-side-composer=send]').click();
  await side.locator('.composer-queue-row').waitFor();
  await wait(async()=>(await records()).some(r=>r.method==='turn/start'&&r.params.input[0].text==='Side queued [wait]'));
  await page.waitForFunction(()=>document.querySelectorAll('#sideChatPanel .composer-queue-row').length===0);
  assert.deepEqual(errors,[]);
  console.log('PASS: immediate spinner/disabled duplicate submission, native steering, FIFO completion queue, captured settings/draft safety, cancel/reload retention, failure recovery, mobile bounds, matching side composer behavior; fixture only');
}catch(error){console.error('FAIL phase:',phase, await page?.locator('#composer').innerText());await page?.screenshot({path:artifact('composer-delivery-failure.png')}).catch(()=>{});throw error;}
finally{await browser?.close();server.kill();await server.exited;await rm(temp,{recursive:true,force:true});}
