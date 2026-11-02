import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { chromium } from 'playwright';
import { root, launchOptions } from '../helpers/browser-runtime.mjs';
const temp=await mkdtemp('/tmp/crw-durable-delivery-'),home=join(temp,'home'),project=join(temp,'project'),log=join(temp,'calls.jsonl');await Promise.all([mkdir(home),mkdir(project)]);
const port=await new Promise(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});}),base=`http://127.0.0.1:${port}`;
const server=Bun.spawn(['bun','src/server/index.ts'],{cwd:root,stdout:'ignore',stderr:'ignore',env:{...process.env,HOST:'127.0.0.1',PORT:String(port),HOME:home,CODEX_HOME:home,CODEX_AUTH_PATH:join(home,'none.json'),CODEX_WEBUI_CWD:project,CODEX_WEBUI_AUTH_MODE:'local',CODEX_WEBUI_APP_SERVER_MODE:'isolated',CODEX_WEBUI_FIXTURE_CONVERSATION_TOOLS:'true',CODEX_WEBUI_FIXTURE_TURN_DURATION_MS:'2000',CODEX_WEBUI_FIXTURE_LOG:log,PATH:join(root,'tests/fixtures')+delimiter+process.env.PATH}});
let browser;
const wait=async predicate=>{for(let n=0;n<150;n++){if(await predicate())return;await Bun.sleep(40);}throw Error('Timed out');};
try{
  await wait(async()=>{try{return(await(await fetch(base+'/api/health')).json()).codex;}catch{return false;}});
  browser=await chromium.launch(launchOptions());const context=await browser.newContext({viewport:{width:1180,height:900}});
  await context.addInitScript(()=>{if(window!==window.top)return;localStorage.setItem('codex-webui-locale','en');const Native=WebSocket;globalThis.WebSocket=class extends Native{constructor(url,...args){if(new URL(url,location.href).pathname==='/ws')throw Error('SSE fixture');super(url,...args);}};});
  const page=await context.newPage(),other=await context.newPage();const errors=[];for(const p of [page,other]){p.on('pageerror',error=>errors.push(error.message));p.setDefaultTimeout(12000);}
  const rpc=(page,method,params={})=>page.evaluate(async({method,params})=>{const response=await fetch('/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:77,method,params})});return response.json();},{method,params});
  await page.goto(base);await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-A'));
  await page.locator('#prompt').fill('Running [wait]');await page.locator('#sendButton').click();await page.waitForFunction(()=>document.querySelector('#sendButton').dataset.submitMode==='stop');
  await page.locator('#composer .composer-delivery-choice').click();await page.getByRole('menuitem',{name:'Queue',exact:true}).click();
  for(const text of ['First queued','Second queued']){await page.locator('#prompt').fill(text);await page.locator('#sendButton').click();await page.waitForFunction(()=>document.querySelector('#sendButton').getAttribute('aria-busy')==='false');}
  await other.goto(base);await other.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);await other.locator('#composer .composer-queue-row').first().waitFor();
  await wait(async()=>await other.locator('#composer .composer-queue-row').count()===2);
  const before=(await rpc(page,'host/delivery/list')).result.entries;
  assert.equal(before.length,2);
  // Pause prevents native-state polling from changing these versions while we
  // exercise a real cross-tab stale edit conflict.
  for(const entry of before){await wait(async()=>{const current=(await rpc(page,'host/delivery/list')).result.entries.find(item=>item.id===entry.id);if(current.status==='paused')return true;const response=await rpc(page,'host/delivery/mutate',{action:'pause',payload:{id:current.id,version:current.version}});return response.type==='rpc/result';});}
  const original=(await rpc(page,'host/delivery/list')).result.entries[0];
  const edited=await rpc(other,'host/delivery/mutate',{action:'edit',payload:{id:original.id,version:original.version,text:'Edited from second tab'}});assert.equal(edited.type,'rpc/result',JSON.stringify(edited));
  const stale=await rpc(page,'host/delivery/mutate',{action:'edit',payload:{id:original.id,version:original.version,text:'Stale edit'}});assert.equal(stale.code,'QUEUE_CONFLICT');
  await wait(async()=>(await page.locator('#composer .composer-queue-row').first().innerText()).includes('Edited from second tab'));
  // Inline editing uses controls inside the existing composer, without a
  // nested form whose submit could execute the main prompt.
  await page.locator('#composer .composer-queue-row').first().getByRole('button',{name:'Queued message actions'}).click();await page.getByRole('menuitem',{name:'Edit queued message',exact:true}).click();
  await page.getByRole('textbox',{name:'Edit queued message'}).fill('Edited inline');await page.getByRole('button',{name:'Save queued message',exact:true}).click();
  await wait(async()=>(await rpc(page,'host/delivery/list')).result.entries[0].text==='Edited inline');
  let entries=(await rpc(page,'host/delivery/list')).result.entries;await rpc(other,'host/delivery/mutate',{action:'reorder',payload:{id:entries[1].id,version:entries[1].version,direction:-1}});
  entries=(await rpc(page,'host/delivery/list')).result.entries;assert.equal(entries[0].text,'Second queued');
  await page.reload();await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);await wait(async()=>await page.locator('#composer .composer-queue-row').count()===2);
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(call=>call.method==='turn/start').length,1);assert.equal(calls.filter(call=>call.method==='turn/steer').length,0);
  assert.deepEqual(errors,[]);
  // Prove the browser is not the queue runner: complete a fixture native turn
  // after every page/context is closed, then observe the successor exactly once.
  const backgroundThread=(await rpc(page,'thread/start',{cwd:project})).result.thread.id;
  const initialId='00000000-0000-4000-8000-000000000007',queuedId='00000000-0000-4000-8000-000000000008';
  const initial=await rpc(page,'turn/start',{threadId:backgroundThread,clientUserMessageId:initialId,input:[{type:'text',text:'Background initial'}]});assert.equal(initial.type,'rpc/result');
  const queued=await rpc(page,'host/delivery/mutate',{action:'enqueue',payload:{id:queuedId,threadId:backgroundThread,text:'Background successor [wait]',mentions:[],params:{threadId:backgroundThread,cwd:project,input:[{type:'text',text:'Background successor [wait]'}]}}});assert.equal(queued.type,'rpc/result');
  await context.close();assert.equal(browser.contexts().length,0);
  const backgroundStarts=async()=>(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse).filter(call=>call.method==='turn/start'&&call.params.clientUserMessageId===queuedId);
  await wait(async()=>await backgroundStarts().then(calls=>calls.length===1));
  await wait(async()=>JSON.parse(await readFile(join(home,'remote-web-delivery','queue.json'),'utf8')).entries.find(entry=>entry.id===queuedId)?.status==='completed');
  await Bun.sleep(1200);assert.equal((await backgroundStarts()).length,1,'closing all pages must not lose or duplicate the queued send');
  const reopenedContext=await browser.newContext({viewport:{width:1180,height:900}}),reopened=await reopenedContext.newPage();
  reopened.on('pageerror',error=>errors.push(error.message));await reopened.goto(base);await reopened.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
  const receipt=(await rpc(reopened,'host/submissions/get',{id:queuedId})).result;assert.equal(receipt.status,'accepted');
  assert.equal((await rpc(reopened,'host/delivery/list',{threadId:backgroundThread})).result.entries.length,0);
  await reopened.evaluate(threadId=>globalThis.__codexWebuiDebug.openThread(threadId),backgroundThread);
  await reopened.locator('.user-message').filter({hasText:'Background successor [wait]'}).waitFor();
  assert.deepEqual(errors,[]);console.log('PASS: durable queue shared across SSE tabs, CAS rejects stale edits, inline edit/reorder, reload retention, all pages closed background completion exactly once, reopened receipt/history; fixture only');
}finally{await browser?.close();server.kill();await server.exited;await rm(temp,{recursive:true,force:true});}
