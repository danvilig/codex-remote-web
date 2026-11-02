import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { chromium } from 'playwright';
import { root, launchOptions } from '../helpers/browser-runtime.mjs';
const home=await mkdtemp(join(root,'.artifacts/conversation-safety-'));
const port=await new Promise(resolve=>{const probe=createServer();probe.listen(0,'127.0.0.1',()=>{const p=probe.address().port;probe.close(()=>resolve(p));});});
const base=`http://127.0.0.1:${port}`;
const gateway=Bun.spawn(['bun','src/server/index.ts'],{cwd:root,env:{...process.env,HOME:home,CODEX_HOME:home,CODEX_AUTH_PATH:join(home,'auth.json'),HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_AUTH_MODE:'local',CODEX_WEBUI_CWD:home,CODEX_WEBUI_REVIEW_ROOT:home,CODEX_WEBUI_ENABLE_TERMINAL:'false',PATH:`${join(root,'tests/fixtures')}${delimiter}${process.env.PATH}`},stdout:'ignore',stderr:'ignore'});
let browser;
try{
  for(let i=0;;i++){try{if((await (await fetch(base+'/api/health')).json()).codex)break;}catch{}if(i>100)throw new Error('Fixture startup failed');await Bun.sleep(50);}
  browser=await chromium.launch(launchOptions());
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en');});
  const page=await context.newPage();page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-A'));
  await page.locator('#prompt').fill('Draft only for A');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-B'));
  assert.equal(await page.locator('#prompt').inputValue(),'','A draft must not follow the user into B');
  await page.locator('#prompt').fill('Draft only for B');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-A'));
  assert.equal(await page.locator('#prompt').inputValue(),'Draft only for A');
  await page.reload({waitUntil:'networkidle'});
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.active?.id==='thread-A');
  assert.equal(await page.locator('#prompt').inputValue(),'Draft only for A','Reload restores the draft without sending');
  const secondTab=await context.newPage();await secondTab.goto(base,{waitUntil:'networkidle'});
  await secondTab.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.active?.id==='thread-A');
  assert.equal(await secondTab.locator('#prompt').inputValue(),'','Independent tabs do not share composer drafts');
  await secondTab.locator('#prompt').fill('Second tab draft');await secondTab.close();
  assert.equal(await page.locator('#prompt').inputValue(),'Draft only for A');
  await page.locator('#toggleSidebar').click();await page.locator('#newTask').click();
  await page.waitForFunction(()=>!document.querySelector('#sidebar').classList.contains('mobile-open'));
  assert.equal(await page.locator('#prompt').inputValue(),'');
  await page.locator('#prompt').fill('New chat draft');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-A'));
  await page.evaluate(()=>globalThis.__codexWebuiDebug.startNewTask());
  assert.equal(await page.locator('#prompt').inputValue(),'New chat draft');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-A'));
  // Control response timing at the transport boundary. The backend remains a fixture.
  await page.evaluate(()=>{
    const original=window.fetch.bind(window);window.calls=[];
    globalThis.__codexWebuiDebug.state.transport='sse';
    window.fetch=async(url,options={})=>{
      if(new URL(String(url),location.href).pathname!=='/api/rpc')return original(url,options);
      const payload=JSON.parse(options.body);window.calls.push(payload);
      if(payload.method==='thread/resume')return new Promise(resolve=>{window.releaseResume=()=>resolve(Response.json({type:'rpc/result',result:{thread:{id:payload.params.threadId,cwd:globalThis.__codexWebuiDebug.state.config.defaultCwd}}}));});
      if(payload.method==='thread/start')return new Promise(resolve=>{window.releaseStart=()=>resolve(Response.json({type:'rpc/result',result:{thread:{id:'created-fixture',cwd:globalThis.__codexWebuiDebug.state.config.defaultCwd}}}));});
      if(payload.method==='turn/start'||payload.method==='turn/interrupt')return new Promise(resolve=>{window.releaseExecution=()=>resolve(Response.json(window.failExecution?{type:'rpc/error',error:'Fixture execution rejected'}:{type:'rpc/result',result:{turn:{id:'fixture-turn',status:'inProgress'}}}));});
      return original(url,options);
    };
  });
  await page.locator('#prompt').fill('Send only to A');await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>typeof window.releaseResume==='function');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-B'));await page.locator('#prompt').fill('Keep B untouched');
  await page.evaluate(()=>window.releaseResume());
  await page.waitForFunction(()=>!document.querySelector('#sendButton').disabled);
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id),'thread-B');
  assert.equal(await page.locator('#prompt').inputValue(),'Keep B untouched');
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='turn/start').length),0,'Navigation before dispatch cancels execution');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-A'));
  assert.match(await page.locator('#prompt').inputValue(),/Send only to A/);
  // A delayed rejection must merge the submitted text with newer typing.
  await page.evaluate(()=>{globalThis.__codexWebuiDebug.state.active.canAcceptDirectInput=true;window.calls=[];window.failExecution=true;});
  await page.locator('#prompt').fill('Rejected message');await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>typeof window.releaseExecution==='function');
  await page.locator('#prompt').fill('New typing while pending');
  await page.locator('#composer').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='turn/start').length),1,'One pending submit cannot be sent twice');
  await page.evaluate(()=>window.releaseExecution());await page.waitForFunction(()=>!document.querySelector('#sendButton').disabled);
  assert.equal(await page.locator('#prompt').inputValue(),'Rejected message\n\nNew typing while pending');
  // A successful reply for A must not clear B or mark its send button as Stop.
  await page.locator('#prompt').fill('Successful A message');
  await page.evaluate(()=>{window.failExecution=false;window.releaseExecution=null;});
  await page.locator('#composer').evaluate(form=>form.requestSubmit());await page.waitForFunction(()=>typeof window.releaseExecution==='function');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-B'));await page.locator('#prompt').fill('B after dispatch');
  await page.evaluate(()=>window.releaseExecution());await page.waitForFunction(()=>!document.querySelector('#sendButton').disabled);
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id),'thread-B');
  assert.equal(await page.locator('#prompt').inputValue(),'B after dispatch');
  assert.equal(await page.locator('#sendButton').getAttribute('data-submit-mode'),'send');
  // Creating a new thread is guarded before a turn is ever sent, too.
  await page.evaluate(()=>{globalThis.__codexWebuiDebug.startNewTask();window.calls=[];});
  await page.locator('#prompt').fill('Pending new task');await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>typeof window.releaseStart==='function');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-B'));
  await page.evaluate(()=>window.releaseStart());await page.waitForFunction(()=>!document.querySelector('#sendButton').disabled);
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id),'thread-B');
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='turn/start').length),0);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.startNewTask());assert.match(await page.locator('#prompt').inputValue(),/Pending new task/);
  // A completed creation transfers newer typing to the returned thread. If the
  // turn then fails while viewing B, only that original thread draft changes.
  await page.locator('#prompt').fill('Created task message');
  await page.evaluate(()=>{window.releaseStart=null;window.releaseExecution=null;window.failExecution=true;window.calls=[];});
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>typeof window.releaseStart==='function');
  await page.locator('#prompt').fill('Follow-up typed during creation');
  await page.evaluate(()=>window.releaseStart());await page.waitForFunction(()=>typeof window.releaseExecution==='function');
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id),'created-fixture');
  assert.equal(await page.locator('#prompt').inputValue(),'Follow-up typed during creation');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-B'));await page.locator('#prompt').fill('B stays here');
  await page.evaluate(()=>window.releaseExecution());await page.waitForFunction(()=>!document.querySelector('#sendButton').disabled);
  assert.equal(await page.locator('#prompt').inputValue(),'B stays here');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('created-fixture'));
  assert.equal(await page.locator('#prompt').inputValue(),'Created task message\n\nFollow-up typed during creation');
  // Navigating away and back before preparation finishes still cancels the send.
  await page.evaluate(()=>{globalThis.__codexWebuiDebug.startNewTask();window.calls=[];window.releaseStart=null;});
  await page.locator('#prompt').fill('Do not send after round trip');await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>typeof window.releaseStart==='function');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-B'));
  await page.evaluate(()=>globalThis.__codexWebuiDebug.startNewTask());
  await page.evaluate(()=>window.releaseStart());await page.waitForFunction(()=>!document.querySelector('#sendButton').disabled);
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='turn/start').length),0);
  assert.equal(await page.locator('#prompt').inputValue(),'Do not send after round trip');
  // Slow history reads must not clear input typed into the destination composer.
  await page.evaluate(()=>{globalThis.__codexWebuiDebug.openThread('thread-A');});
  await page.locator('#prompt').fill('Typing while history loads');
  await page.waitForFunction(()=>!document.querySelector('.conversation-loading')?.textContent.includes('Loading conversation'));
  assert.equal(await page.locator('#prompt').inputValue(),'Typing while history loads');
  assert.deepEqual(errors,[]);
  // Broken optional review preferences must not prevent booting the whole app.
  const corrupted=await browser.newContext();await corrupted.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-review-preferences','{broken');});
  const other=await corrupted.newPage();await other.goto(base,{waitUntil:'networkidle'});await other.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
  console.log('PASS: isolated tab drafts, reload recovery, mobile new-chat dismissal, navigation during resume/create/send, duplicate submit prevention and safe failure recovery');
}finally{await browser?.close();gateway.kill('SIGTERM');await gateway.exited;await rm(home,{recursive:true,force:true});}
