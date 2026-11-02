import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { root, artifact, launchOptions } from '../helpers/browser-runtime.mjs';

// One deterministic native fixture behind a Unix WebSocket shared by Desktop
// and the real HTTP gateway. Never calls a model or uses actual Codex state.
const temp=await mkdtemp('/tmp/crw-shared-browser-'),home=join(temp,'home'),project=join(temp,'project'),socket=join(home,'.codex/app-server-control/app-server-control.sock'),log=join(temp,'rpc.jsonl');
await mkdir(join(home,'.codex/app-server-control'),{recursive:true});await mkdir(project);
const env={...process.env,HOME:home,CODEX_HOME:join(home,'.codex'),CODEX_AUTH_PATH:join(home,'.codex/absent-auth.json'),CODEX_WEBUI_CWD:project,CODEX_WEBUI_REVIEW_ROOT:project,CODEX_WEBUI_AUTH_MODE:'local',CODEX_WEBUI_ENABLE_TERMINAL:'false',CODEX_WEBUI_FIXTURE_CONVERSATION_TOOLS:'true',CODEX_WEBUI_FIXTURE_LOG:log};
const fixture=spawn('node',[join(root,'tests/fixtures/codex')],{cwd:root,env,stdio:['pipe','pipe','ignore']});
const native=httpServer(),wss=new WebSocketServer({server:native}),routes=new Map();let seq=0;
wss.on('connection',ws=>ws.on('message',raw=>{const message=JSON.parse(String(raw));if(message.method&&message.id!==undefined){const nativeId=++seq;routes.set(nativeId,{ws,id:message.id});message.id=nativeId;}fixture.stdin.write(JSON.stringify(message)+'\n');}));
const lines=createInterface({input:fixture.stdout});
lines.on('line',line=>{const message=JSON.parse(line),route=routes.get(message.id);if(route&&('result'in message||'error'in message)){routes.delete(message.id);if(route.ws.readyState===WebSocket.OPEN)route.ws.send(JSON.stringify({...message,id:route.id}));}else for(const ws of wss.clients)if(ws.readyState===WebSocket.OPEN)ws.send(line);});
await new Promise(resolve=>native.listen(socket,resolve));
const port=await new Promise(resolve=>{const probe=netServer();probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port));});}),base=`http://127.0.0.1:${port}`;
const gateway=Bun.spawn(['bun','src/server/index.ts'],{cwd:root,env:{...env,HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_APP_SERVER_MODE:'auto'},stdout:'ignore',stderr:'ignore'});
const desktop=new WebSocket(`ws+unix://${socket}:/`),pending=new Map();let desktopId=0;
desktop.on('message',raw=>{const message=JSON.parse(String(raw)),task=pending.get(message.id);if(task){pending.delete(message.id);message.error?task.reject(Error(message.error.message)):task.resolve(message.result);}});
const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++desktopId;pending.set(id,{resolve,reject});desktop.send(JSON.stringify({id,method,params}));});
let browser,page,phase='startup';
const records=async()=>(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
try{
  await new Promise((resolve,reject)=>{desktop.once('open',resolve);desktop.once('error',reject);});
  await request('initialize',{clientInfo:{name:'desktop-fixture',version:'1'},capabilities:{experimentalApi:true}});
  desktop.send(JSON.stringify({method:'initialized'}));
  for(let i=0;;i++){try{if((await(await fetch(base+'/api/health')).json()).codex)break;}catch{}if(i>100)throw Error('shared gateway startup');await Bun.sleep(50);}
  browser=await chromium.launch(launchOptions());const context=await browser.newContext({viewport:{width:1180,height:800}});
  await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en');});
  page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
  phase='Desktop holds running thread, WebUI steers through shared resume';
  const active=await request('turn/start',{threadId:'thread-A',input:[{type:'text',text:'Desktop running [wait]'}]});
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-A'));
  assert.equal(await page.locator('#sendButton').getAttribute('data-submit-mode'),'stop');
  await page.locator('#prompt').fill('Continue from the web without closing Desktop');
  await page.locator('#sendButton').click();
  for(let i=0;!(await records()).some(r=>r.method==='turn/steer');i++){if(i>100)throw Error('steer not dispatched');await Bun.sleep(30);}
  const sent=(await records()).find(r=>r.method==='turn/steer');
  assert.equal(sent.params.threadId,'thread-A');assert.equal(sent.params.expectedTurnId,active.turn.id);
  assert.equal(sent.params.input[0].text,'Continue from the web without closing Desktop');
  assert.equal((await records()).filter(r=>r.method==='turn/start').length,1,'steering must not create another executing turn');
  assert((await records()).some(r=>r.method==='thread/resume'&&r.params.threadId==='thread-A'));
  assert.equal(desktop.readyState,WebSocket.OPEN);
  assert.equal((await request('thread/read',{threadId:'thread-A',includeTurns:false})).thread.id,'thread-A');
  assert(!await page.locator('#toast').innerText().then(text=>/active writer|Close it there/.test(text)));
  phase='idle shared conversation accepts web turn';
  await request('turn/interrupt',{threadId:'thread-A',turnId:active.turn.id});
  await page.waitForFunction(()=>document.querySelector('#sendButton').dataset.submitMode==='send');
  await page.locator('#prompt').fill('Web starts the next native turn [wait]');await page.locator('#sendButton').click();
  for(let i=0;(await records()).filter(r=>r.method==='turn/start').length<2;i++){if(i>100)throw Error('next turn not dispatched');await Bun.sleep(30);}
  assert.equal((await records()).filter(r=>r.method==='turn/start').at(-1).params.threadId,'thread-A');
  assert.equal(desktop.readyState,WebSocket.OPEN);assert.deepEqual(errors,[]);
  await page.screenshot({path:artifact('shared-desktop-web-conversation.png')});
  phase='gateway shutdown leaves Desktop connected';
  gateway.kill();await gateway.exited;
  assert.equal((await request('thread/read',{threadId:'thread-A',includeTurns:false})).thread.id,'thread-A');
  assert.equal(fixture.exitCode,null);
  console.log('PASS: full WebUI auto-attaches to existing native Unix socket, resumes/steers a Desktop-owned running thread, starts next turn on the same thread and detaches without closing Desktop');
}catch(error){console.error('FAIL phase:',phase);if(page)await page.screenshot({path:artifact('shared-app-server-failure.png')}).catch(()=>{});throw error;}
finally{
  await browser?.close();gateway.kill();await gateway.exited;desktop.terminate();
  for(const ws of wss.clients)ws.terminate();wss.close();await new Promise(resolve=>native.close(resolve));
  lines.close();const closed=fixture.exitCode!==null?Promise.resolve():new Promise(resolve=>fixture.once('close',resolve));fixture.kill();await closed;
  await rm(temp,{recursive:true,force:true});
}
