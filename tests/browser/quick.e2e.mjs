import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile,copyFile,stat} from 'node:fs/promises';
import {join,delimiter} from 'node:path';
import {createServer as httpServer,request as httpRequest} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {createServer as netServer,connect} from 'node:net';
import WebSocket from 'ws';
import {chromium} from 'playwright';
import jsQR from 'jsqr';
import {root,launchOptions,artifact} from '../helpers/browser-runtime.mjs';
const directory=await mkdtemp(join(root,'.artifacts/quick-browser-')),bin=join(directory,'bin');await mkdir(bin);
const freePort=()=>new Promise(resolve=>{const server=netServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const gatewayPort=await freePort(),connectorPort=await freePort(),tlsPort=await freePort(),proxyPort=await freePort();
const publicOrigin='https://fixture-quick.trycloudflare.com',base=`http://127.0.0.1:${gatewayPort}`,email='owner@example.test';
await copyFile(join(root,'tests/fixtures/quick-cloudflared.mjs'),join(bin,'quick-cloudflared.mjs'));
await writeFile(join(bin,'quick-fixture.json'),JSON.stringify({port:connectorPort,state:join(directory,'connector.json')}));
await writeFile(join(bin,'cloudflared'),`#!/bin/sh\nexec '${Bun.which('node').replaceAll("'","'\\''")}' '${join(bin,'quick-cloudflared.mjs').replaceAll("'","'\\''")}' "$@"\n`,{mode:0o700});
const cert=Bun.spawnSync(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=fixture-quick.trycloudflare.com','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem')],{stdout:'ignore',stderr:'ignore'});assert.equal(cert.exitCode,0);
const edgeSockets=new Set();
const edge=httpsServer({key:await readFile(join(directory,'key.pem')),cert:await readFile(join(directory,'cert.pem'))},(req,res)=>{
  const upstream=httpRequest({host:'127.0.0.1',port:connectorPort,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
});
edge.on('connection',socket=>{edgeSockets.add(socket);socket.on('close',()=>edgeSockets.delete(socket));});
edge.on('upgrade',(req,socket,head)=>{
  const upstream=connect(connectorPort,'127.0.0.1',()=>{upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key,value])=>`${key}: ${value}`).join('\r\n')}\r\n\r\n`);upstream.write(head);upstream.pipe(socket);socket.pipe(upstream);});
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
});
await new Promise(resolve=>edge.listen(tlsPort,'127.0.0.1',resolve));
const proxySockets=new Set();
const proxy=httpServer((req,res)=>{res.writeHead(403);res.end();});
proxy.on('connection',socket=>{proxySockets.add(socket);socket.on('close',()=>proxySockets.delete(socket));});
proxy.on('connect',(req,socket,head)=>{
  if(req.url!=='fixture-quick.trycloudflare.com:443'){socket.destroy();return;}
  const upstream=connect(tlsPort,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');upstream.write(head);upstream.pipe(socket);socket.pipe(upstream);});
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
});
await new Promise(resolve=>proxy.listen(proxyPort,'127.0.0.1',resolve));
let gateway,browser,publicContext;
let csrf,cookie;
async function setup(path,body) {
  const response=await fetch(base+'/api/setup/'+path,{method:body===undefined?'GET':'POST',headers:{origin:base,'x-setup-request':'1','content-type':'application/json',...(csrf?{'x-setup-csrf':csrf}:{}),...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {response,data:await response.json()};
}
async function waitPhase(phase){for(let i=0;i<150;i++){const {data}=await setup('quick/status');if(data.phase===phase)return data;if(data.phase==='failed')throw new Error(data.error);await Bun.sleep(40);}throw new Error('Phase timeout '+phase);}
const pidExists=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
try {
  gateway=Bun.spawn(['bun','src/server/index.ts'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(gatewayPort),HOME:directory,CODEX_HOME:directory,CODEX_AUTH_PATH:join(directory,'auth.json'),CODEX_WEBUI_AUTH_MODE:'local',CODEX_WEBUI_ENABLE_TERMINAL:'true',CODEX_WEBUI_CWD:directory,CODEX_WEBUI_REVIEW_ROOT:directory,CODEX_WEBUI_FIXTURE_LOG:join(directory,'rpc.log'),PATH:`${bin}${delimiter}${join(root,'tests/fixtures')}${delimiter}${process.env.PATH}`},stdout:'ignore',stderr:Bun.file(join(directory,'gateway.log'))});
  for(let i=0;;i++){try{if((await (await fetch(base+'/api/health')).json()).codex)break;}catch{}if(i>150)throw new Error('Gateway startup failed');await Bun.sleep(40);}
  browser=await chromium.launch(launchOptions());const context=await browser.newContext({viewport:{width:1280,height:1000}}),page=await context.newPage(),errors=[];
  await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en');});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/settings/remote-access');await page.locator('[data-stage=locked]:visible').waitFor();
  assert.equal(await page.locator('.remote-access-choice').count(),2);
  await page.locator('[data-action=quick]').click();await page.locator('[data-stage=quick]:visible').waitFor();
  await page.locator('[data-quick=start]:not([disabled])').waitFor();
  await page.screenshot({path:artifact('quick-start-desktop.png')});
  assert.equal(await page.locator('[data-stage=account]').isVisible(),false);
  await page.locator('[name=quickEmail]').fill(email);
  let starts=0;await page.route('**/api/setup/quick/start',async route=>{starts++;await route.fetch();await route.abort('failed');});
  await page.locator('[data-quick=start]').click();
  await page.locator('[data-quick=address]:visible').waitFor();await page.unroute('**/api/setup/quick/start');assert.equal(starts,1);
  assert.equal(await page.locator('[data-quick=link]').getAttribute('href'),publicOrigin);assert.equal(await page.locator('[data-quick=qr] svg').count(),1);
  const pixels=await page.locator('[data-quick=qr] svg').evaluate(async svg=>{
    const image=new Image();image.src='data:image/svg+xml,'+encodeURIComponent(new XMLSerializer().serializeToString(svg));await image.decode();
    const canvas=document.createElement('canvas');canvas.width=canvas.height=400;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,400,400);ctx.drawImage(image,0,0,400,400);return Array.from(ctx.getImageData(0,0,400,400).data);
  });
  assert.equal(jsQR(new Uint8ClampedArray(pixels),400,400)?.data,publicOrigin);
  const connector=JSON.parse(await readFile(join(directory,'connector.json'),'utf8'));assert.equal(connector.email,email);assert.ok(connector.args.includes('--allowed-mail'));
  await page.reload();await page.locator('[data-quick=address]:visible').waitFor();
  assert.equal(JSON.parse(await readFile(join(directory,'connector.json'),'utf8')).pid,connector.pid);
  let statusRequests=0;page.on('request',req=>{if(new URL(req.url()).pathname==='/api/setup/quick/status')statusRequests++;});
  await page.evaluate(()=>globalThis.__codexWebuiDebug.closeSettings());await page.locator('#settingsDialog:not([open])').waitFor({state:'attached'});
  await Bun.sleep(100);const pausedCount=statusRequests;await Bun.sleep(2800);assert.equal(statusRequests,pausedCount);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openSettings('remote-access'));await page.locator('[data-quick=address]:visible').waitFor();
  await page.locator('[data-quick=back]').click();await page.locator('[data-stage=locked]:visible').waitFor();await page.locator('[data-action=quick]').click();await page.locator('[data-quick=address]:visible').waitFor();
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:artifact('quick-ready-mobile.png'),fullPage:true});
  // Establish a separate setup session for explicit read-only status/stop checks.
  let result=await setup('launch',{});result=await setup('session',{key:result.data.key});csrf=result.data.csrf;cookie=result.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await setup('quick/status')).data.phase,'ready');
  assert.equal((await fetch(base+'/api/setup/quick/start',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:JSON.stringify({email})})).status,403);
  assert.equal((await fetch(base+'/api/health')).status,200);
  // The fixture connector emulates email auth; no request uses a real provider/account.
  const edgeRequest=(path,extra={})=>fetch(`http://127.0.0.1:${connectorPort}${path}`,{redirect:'manual',...extra,headers:{host:'fixture-quick.trycloudflare.com',...extra.headers}});
  assert.equal((await edgeRequest('/')).status,302);
  assert.equal((await edgeRequest('/api/rpc',{method:'POST',body:'{}'})).status,401);
  const verified={cookie:'fixture_quick_login=owner',origin:publicOrigin};
  const status=await (await edgeRequest('/api/auth/status',{headers:verified})).json();assert.equal(status.mode,'quick-tunnel');assert.equal(status.transports.sse,false);assert.equal(status.identity.email,email);
  assert.equal((await edgeRequest('/api/config',{headers:{...verified,origin:'https://evil.example'}})).status,403);
  assert.equal((await edgeRequest('/api/setup/status',{headers:verified})).status,404);
  assert.equal((await edgeRequest('/api/events',{headers:verified})).status,409);
  assert.equal((await edgeRequest('/api/auth/login',{method:'POST',headers:verified,body:'{}'})).status,404);
  // HTTP, main WS and PTY all reach the same gateway through the private socket.
  const ws=new WebSocket(`ws://127.0.0.1:${connectorPort}/ws`,{headers:{host:'fixture-quick.trycloudflare.com',...verified}});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});ws.send(JSON.stringify({type:'rpc',id:44,method:'model/list',params:{}}));
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('RPC timeout')),3000);ws.on('message',data=>{const message=JSON.parse(String(data));if(message.id===44){assert.equal(message.type,'rpc/result');clearTimeout(timer);resolve();}});});
  const terminal=new WebSocket(`ws://127.0.0.1:${connectorPort}/terminal`,{headers:{host:'fixture-quick.trycloudflare.com',...verified}});let terminalOutput='';terminal.on('message',data=>terminalOutput+=String(data));
  await new Promise((resolve,reject)=>{terminal.once('open',resolve);terminal.once('error',reject);});terminal.send(Buffer.from("printf 'QUICK_PTY_OK\\n'\n"));
  for(let i=0;!/(?:\r|\n)QUICK_PTY_OK\r?\n/.test(terminalOutput);i++){if(i>100)throw new Error('PTY timeout: '+JSON.stringify(terminalOutput.slice(-1000))); await Bun.sleep(30);}
  publicContext=await browser.newContext({ignoreHTTPSErrors:true,proxy:{server:`http://127.0.0.1:${proxyPort}`},viewport:{width:390,height:844}});
  await publicContext.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en');});
  const phone=await publicContext.newPage();phone.on('pageerror',error=>errors.push(error.message));
  await phone.goto(publicOrigin+'/fixture-login');await phone.goto(publicOrigin+'/');await phone.locator('#prompt').waitFor();
  await phone.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
  assert.equal(await phone.evaluate(()=>globalThis.__codexWebuiDebug.state.transport),'ws');
  await phone.locator('#prompt').fill('keep quick tunnel draft');
  await phone.screenshot({path:artifact('quick-workspace-mobile.png')});
  // WS loss reconnects via WS rather than attempting unsupported SSE or replaying execution.
  let events=0;phone.on('request',req=>{if(new URL(req.url()).pathname==='/api/events')events++;});
  await phone.evaluate(()=>{globalThis.__closedQuickWs=globalThis.__codexWebuiDebug.state.ws;globalThis.__closedQuickWs.close();});await phone.waitForFunction(()=>globalThis.__codexWebuiDebug.state.connected && globalThis.__codexWebuiDebug.state.ws && globalThis.__codexWebuiDebug.state.ws!==globalThis.__closedQuickWs);assert.equal(events,0);
  assert.equal(await phone.locator('#prompt').inputValue(),'keep quick tunnel draft');
  await publicContext.clearCookies();await phone.evaluate(()=>globalThis.__codexWebuiDebug.state.ws.close());
  await phone.locator('#accessGate:visible').waitFor();assert.match(await phone.locator('#accessLogin').textContent(),/email verification/);
  assert.equal(await phone.evaluate(()=>JSON.stringify({...sessionStorage}).includes('keep quick tunnel draft')),true);
  await publicContext.addCookies([{name:'fixture_quick_login',value:'owner',domain:'fixture-quick.trycloudflare.com',path:'/',secure:true}]);
  await phone.reload();await phone.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);assert.equal(await phone.locator('#prompt').inputValue(),'keep quick tunnel draft');
  const wsClosed=new Promise(resolve=>ws.once('close',resolve)),terminalClosed=new Promise(resolve=>terminal.once('close',resolve));
  await setup('quick/stop',{});await waitPhase('stopped');await Promise.all([wsClosed,terminalClosed]);assert.equal(pidExists(connector.pid),false);
  assert.equal((await fetch(base+'/api/health')).status,200);assert.equal(await readFile(join(directory,'.config/codex-remote-web/setup-state.json')).catch(()=>null),null);
  const rpc=await readFile(join(directory,'rpc.log'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});assert.equal(rpc.includes('turn/start'),false);assert.deepEqual(errors,[]);
  // Hard owner termination closes IPC; the supervisor kills the child and removes its private socket.
  const receiptPath=join(directory,'.config/codex-remote-web/setup-state.json');
  const receipt=JSON.stringify({phase:'complete',input:{hostname:'owned.example.com',email},teamDomain:'team.cloudflareaccess.com',aud:'private-aud'});
  await writeFile(receiptPath,receipt);await page.reload();await page.locator('[data-stage=overview]:visible').waitFor();
  await page.evaluate(()=>{const select=document.querySelector('#languageSelect');select.value='zh-CN';select.dispatchEvent(new Event('change'));});
  await page.locator('[data-action=quickOverview]').click();await page.locator('[data-quick=start]:not([disabled])').waitFor();
  assert.equal(await page.locator('[data-quick=title]').textContent(),'无域名临时访问');
  assert.equal(await page.locator('[data-quick=start]').textContent(),'启动临时访问');
  await page.screenshot({path:artifact('quick-start-mobile-zh.png')});
  assert.equal(await page.locator('[name=quickEmail]').inputValue(),email);
  await page.locator('[data-quick=start]').click();await page.locator('[data-quick=address]:visible').waitFor();
  const second=JSON.parse(await readFile(join(directory,'connector.json'),'utf8'));assert.equal(await readFile(receiptPath,'utf8'),receipt);
  gateway.kill('SIGKILL');await gateway.exited;gateway=null;
  for(let i=0;pidExists(second.pid);i++){if(i>100)throw new Error('Orphaned connector');await Bun.sleep(30);}
  assert.equal(await stat(second.socketPath).catch(()=>null),null);assert.equal(await readFile(receiptPath,'utf8'),receipt);
  console.log('PASS: no-domain full UI, email boundary fixture, private socket, real WS/RPC/PTY, QR/mobile, lost start response, reconnect and drafts without SSE/replay, stop and abrupt owner cleanup');
}finally{
  await publicContext?.close();await browser?.close();if(gateway){gateway.kill('SIGTERM');await gateway.exited;}
  for(const socket of edgeSockets)socket.destroy();for(const socket of proxySockets)socket.destroy();
  await Promise.all([new Promise(resolve=>edge.close(resolve)),new Promise(resolve=>proxy.close(resolve))]);await rm(directory,{recursive:true,force:true});
}
