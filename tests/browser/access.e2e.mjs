import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { createServer as httpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createServer as netServer, connect } from 'node:net';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import WebSocket from 'ws';
import { chromium } from 'playwright';
import { root, launchOptions, artifact } from '../helpers/browser-runtime.mjs';

const fixture = mkdtempSync(join(root, '.artifacts/access-'));
async function port() { return new Promise(resolve => { const probe = netServer(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); }); }
const serverPort = await port(), edgePort = await port();
const origin = `https://localhost:${edgePort}`, issuer = 'https://fixture-team.cloudflareaccess.com';
const pair = await generateKeyPair('RS256'), rotated = await generateKeyPair('RS256');
const key = { ...await exportJWK(pair.publicKey), kid: 'initial', alg: 'RS256' };
writeFileSync(join(fixture, 'jwks.json'), JSON.stringify({ keys: [key] }));
const cert = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(fixture, 'key.pem'), '-out', join(fixture, 'cert.pem')], { stdout: 'ignore', stderr: 'ignore' });
assert.equal(cert.exitCode, 0);
async function token(seconds = 120, overrides = {}, signingKey = pair.privateKey, kid = 'initial') { return new SignJWT({ sub: 'owner-sub', email: 'owner@example.test', ...overrides }).setProtectedHeader({ alg: 'RS256', kid }).setIssuer(issuer).setAudience('fixture-aud').setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000) + seconds).sign(signingKey); }
let edgeToken = await token();
let blocked = false;
let navigationSite = null;
const sockets = new Set();
// Local HTTPS edge fixture injects a signed identity; it is never used by production code.
const edge = httpsServer({ key: readFileSync(join(fixture, 'key.pem')), cert: readFileSync(join(fixture, 'cert.pem')) }, (req, res) => {
  if (req.url === '/login-return') { res.writeHead(200, { 'content-type':'text/html' }); res.end('<a id="finish" href="/login-complete">Finish sign-in</a>'); return; }
  if (req.url === '/login-complete') { res.writeHead(302, { location: origin }); res.end(); return; }
  if (req.url === '/' && req.headers['sec-fetch-mode'] === 'navigate') navigationSite = req.headers['sec-fetch-site'];
  if (blocked) { res.writeHead(401, { 'content-type': 'text/html' }); res.end('Access login required'); return; }
  const upstream = httpRequest({ host: '127.0.0.1', port: serverPort, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${edgePort}`, 'cf-access-jwt-assertion': edgeToken } }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
});
edge.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
edge.on('upgrade', (req, socket, head) => {
  if (blocked) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
  const upstream = connect(serverPort, '127.0.0.1', () => {
    const headers = { ...req.headers, host: `localhost:${edgePort}`, 'cf-access-jwt-assertion': edgeToken };
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([name,value])=>`${name}: ${value}`).join('\r\n')}\r\n\r\n`);
    upstream.write(head); upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
});
await new Promise(resolve => edge.listen(edgePort, resolve));
const log = join(fixture, 'rpc.jsonl');
writeFileSync(log, '');
const fixtureEnv = { ...process.env, HOST: '127.0.0.1', PORT: String(serverPort), CODEX_WEBUI_AUTH_MODE: 'cloudflare-access', CODEX_WEBUI_PUBLIC_ORIGIN: origin, CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN: 'fixture-team.cloudflareaccess.com', CODEX_WEBUI_CF_ACCESS_AUD: 'fixture-aud', CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL: 'owner@example.test', FIXTURE_JWKS_FILE: join(fixture, 'jwks.json'), HOME: fixture, SHELL: '/bin/bash', CODEX_AUTH_PATH: join(fixture, 'auth.json'), CODEX_HOME: fixture, CODEX_WEBUI_CWD: fixture, CODEX_WEBUI_REVIEW_ROOT: fixture, CODEX_WEBUI_SETUP_PROBE: 'fixture-private-ready-nonce', CODEX_WEBUI_PASSWORD: 'must-not-bypass-access', CODEX_WEBUI_ACCESS_TOKEN: 'must-not-bypass-access', CODEX_WEBUI_FIXTURE_LOG: log, PATH: `${join(root, 'tests/fixtures')}${delimiter}${process.env.PATH}`, CODEX_WEBUI_ENABLE_TERMINAL: 'false', CODEX_WEBUI_ENABLE_REVIEW_WRITE: 'false' };
const startGateway = (terminal = false, loopback = false) => Bun.spawn(['bun', '--preload', join(root, 'tests/fixtures/access-preload.ts'), join(root, 'src/server/index.ts')], { cwd: root, env: { ...fixtureEnv, CODEX_WEBUI_ENABLE_TERMINAL: String(terminal), CODEX_WEBUI_ALLOW_LOCAL_LOOPBACK: String(loopback) }, stdout: 'ignore', stderr: 'ignore' });
let server = startGateway();
const headers = { host: `localhost:${edgePort}`, origin };
const base = `http://127.0.0.1:${serverPort}`;
const request = (path, extra = {}) => fetch(base + path, { ...extra, headers: { ...headers, ...extra.headers } });
const signed = async (path, extra = {}) => request(path, { ...extra, headers: { 'cf-access-jwt-assertion': await token(), ...extra.headers } });
let browser;
async function deniedSocket(path, extra = {}) {
  return new Promise((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${serverPort}${path}`, { headers: { ...headers, ...extra } }); ws.on('unexpected-response', (_, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); }); ws.on('open', () => { ws.close(); reject(new Error('Unauthorized socket opened')); }); ws.on('error', () => {}); });
}
try {
  for (let attempt=0;;attempt++) { try { const response = await signed('/api/health'); if ((await response.json()).codex) break; } catch {} if (attempt>100) throw new Error('Access fixture startup failed'); await Bun.sleep(50); }
  for (const path of ['/', '/app.bundle.js', '/api/config', '/api/conversation/goal', '/api/conversation/fork', '/api/composer/tools', '/api/events', '/api/customize', '/api/schedules', '/api/library', '/api/library/preview', '/api/files/document', '/api/attachments', '/api/attachments/file', '/api/attachments/preview', '/api/account', '/api/remote-access/status']) assert.equal((await request(path)).status, 401, path);
  assert.equal((await request('/api/config', { headers: { authorization: 'Bearer must-not-bypass-access', cookie: 'codex_webui_session=fake', 'cf-access-authenticated-user-email': 'owner@example.test' } })).status, 401);
  assert.equal((await signed('/setup')).status, 403);
  assert.equal((await fetch(base + '/api/setup/ready')).status, 403);
  const ready = await fetch(base + '/api/setup/ready', { headers: { 'x-setup-probe': 'fixture-private-ready-nonce' } });
  assert.equal(ready.status, 200); assert.equal((await ready.json()).mode, 'cloudflare-access');
  assert.equal((await signed('/api/setup/ready', { headers: { 'x-setup-probe': 'fixture-private-ready-nonce' } })).status, 403);
  assert.equal((await signed('/api/setup/status')).status, 403);
  assert.equal((await signed('/api/setup/launch', { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-request': '1' }, body: '{}' })).status, 403);
  assert.equal((await request('/api/auth/setup', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await signed('/api/config', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await signed('/api/remote-access/status', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await signed('/api/remote-access/status', { method:'POST' })).status, 405);
  const remoteStatus = await (await signed('/api/remote-access/status')).json();
  assert.equal(remoteStatus.configured,true); assert.equal(remoteStatus.active,true); assert.equal(remoteStatus.canManage,false);
  assert.equal(remoteStatus.publicOrigin,origin); assert.equal(remoteStatus.allowedEmail,'owner@example.test');
  for(const secret of ['fixture-aud','fixture-private-ready-nonce','cf-access-jwt-assertion','fixture-management-token-secret',fixture]) assert.equal(JSON.stringify(remoteStatus).includes(secret),false);
  assert.equal((await request('/api/config', { headers: { 'cf-access-jwt-assertion': await token(120, { email: 'other@example.test' }) } })).status, 403);
  assert.equal((await request('/api/config', { headers: { 'cf-access-jwt-assertion': await token(-1) } })).status, 401);
  const status = await (await signed('/api/auth/status')).json(); assert.equal(status.mode, 'cloudflare-access'); assert.equal(status.authenticated, true); assert.equal(status.identity.email, 'owner@example.test'); assert.equal(JSON.stringify(status).includes('eyJ'), false);
  assert.equal(await deniedSocket('/ws'), 401); assert.equal(await deniedSocket('/terminal'), 401);
  assert.equal(await deniedSocket('/ws', { 'cf-access-jwt-assertion': await token(), origin: 'https://evil.example' }), 403);
  assert.equal(await deniedSocket('/terminal', { 'cf-access-jwt-assertion': await token() }), 403); // Valid identity, disabled capability.
  const live = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`, { headers: { ...headers, 'cf-access-jwt-assertion': await token(3) } });
  const messages = []; live.on('message', data => messages.push(JSON.parse(String(data))));
  await new Promise((resolve,reject)=>{ live.on('open',resolve);live.on('error',reject); });
  live.send(JSON.stringify({ type:'rpc',id:1,method:'thread/list',params:{} }));
  const closeCode = await new Promise(resolve=>live.on('close',code=>resolve(code)));
  assert.equal(closeCode,4001); assert.ok(messages.some(m=>m.type==='rpc/result')); assert.ok(messages.some(m=>m.type==='auth/required'));
  const sse = await request('/api/events', { headers: { 'cf-access-jwt-assertion': await token(2) } });
  const sseText = await sse.text(); assert.match(sseText,/bridge\/status/); assert.match(sseText,/AUTH_EXPIRED/);
  writeFileSync(join(fixture,'jwks.json'),JSON.stringify({keys:[key,{...await exportJWK(rotated.publicKey),kid:'rotated',alg:'RS256'}]}));
  assert.equal((await request('/api/config',{headers:{'cf-access-jwt-assertion':await token(120,{},rotated.privateKey,'rotated')}})).status,200);
  server.kill('SIGTERM'); await server.exited; server = startGateway(true);
  for (let attempt=0;;attempt++) { try { if((await (await signed('/api/health')).json()).codex)break; } catch {} if(attempt>100)throw new Error('Terminal fixture restart failed');await Bun.sleep(50); }
  const terminal = new WebSocket(`ws://127.0.0.1:${serverPort}/terminal`, { headers: { ...headers, 'cf-access-jwt-assertion': await token(3) } });
  let terminalOutput='';terminal.on('message',data=>terminalOutput+=String(data));
  await new Promise((resolve,reject)=>{terminal.on('open',resolve);terminal.on('error',reject);});
  assert.equal(await new Promise(resolve=>terminal.on('close',code=>resolve(code))),4001);
  assert.equal(terminalOutput.includes('"type":"auth/required"'),false);
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ ignoreHTTPSErrors:true,viewport:{width:1074,height:614} });
  const page = await context.newPage(); page.setDefaultTimeout(10000); const errors=[];page.on('pageerror',error=>errors.push(error.message));
  // Simulate returning from an Access team domain on a different site.
  edgeToken=await token();
  await page.goto(`https://127.0.0.1:${edgePort}/login-return`, { waitUntil:'domcontentloaded' });
  const [returned] = await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}), page.locator('#finish').click()]);
  assert.equal(navigationSite, 'cross-site'); assert.equal(returned.status(), 200);
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
  await page.waitForFunction(()=>document.querySelector('#accountAvatar').textContent==='O');
  assert.equal(await page.locator('#accountButton').getAttribute('title'),'owner@example.test');
  const setupRequests = [];
  const watchSetup = req => { if(new URL(req.url()).pathname.startsWith('/api/setup/'))setupRequests.push(req.url()); };
  page.on('request',watchSetup);
  await page.goto(origin+'/settings/remote-access',{waitUntil:'domcontentloaded'});
  await page.locator('[data-stage=overview]:visible').waitFor();
  assert.match(await page.locator('[data-remote=overviewSummary]').textContent(),/owner@example.test/);
  assert.equal(await page.locator('[data-action=manageLocal]').isVisible(),false);
  assert.equal(await page.locator('[data-action=unlock]').isVisible(),false);
  assert.equal(await page.locator('.remote-steps').isVisible(),false);
  await page.screenshot({path:artifact('remote-access-configured-dark.png')});
  await page.setViewportSize({width:390,height:844}); await page.emulateMedia({colorScheme:'light'});
  await page.reload(); await page.locator('[data-stage=overview]:visible').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:artifact('remote-access-configured-mobile.png'),fullPage:true});
  await page.route('**/api/remote-access/status',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Unavailable"}'}));
  await page.reload(); await page.locator('[data-action=refreshStatus]:visible').waitFor();
  assert.equal(await page.locator('[data-action=unlock]').isVisible(),false,'A status failure must not suggest setting up again');
  await page.unroute('**/api/remote-access/status');await page.locator('[data-action=refreshStatus]').click();
  await page.locator('[data-stage=overview]:visible').waitFor();
  assert.deepEqual(setupRequests,[],'Viewing deployed configuration must not open local setup or require a management token');
  page.off('request',watchSetup); await page.setViewportSize({width:1074,height:614});
  edgeToken=await token(8);
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.threads.length===3);
  await page.evaluate(async()=>{ await globalThis.__codexWebuiDebug.openThread('thread-A'); });
  await page.locator('#prompt').fill('Keep this draft, do not execute it');
  const before = readFileSync(log,'utf8').split('\n').filter(line=>line.includes('turn/start')||line.includes('turn/steer')).length;
  blocked=true;
  await page.locator('#accessGate').waitFor({state:'visible'});
  assert.equal(await page.locator('#passwordGate').isVisible(),false);
  const stopped = await page.evaluate(()=>({required:globalThis.__codexWebuiAccessSession.required,ws:globalThis.__codexWebuiDebug.state.ws,events:globalThis.__codexWebuiDebug.state.events}));assert.deepEqual(stopped,{required:true,ws:null,events:null});
  await page.screenshot({path:artifact('access-session-expired.png')});
  blocked=false;edgeToken=await token();
  await page.locator('#accessLogin').click();
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.active?.id==='thread-A');
  await page.waitForFunction(()=>document.querySelector('#prompt').value==='Keep this draft, do not execute it');
  const after = readFileSync(log,'utf8').split('\n').filter(line=>line.includes('turn/start')||line.includes('turn/steer')).length; assert.equal(after,before);
  await context.setOffline(true);
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiAccessSession.check()),false);
  assert.equal(await page.locator('#accessGate').isVisible(),false);
  await context.setOffline(false);
  // An authenticated refresh renews transports, reconciles requests, and preserves the current draft too.
  await page.evaluate(()=>globalThis.__codexWebuiDebug.state.ws.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'bridge/reconnect',code:'AUTH_REFRESH'})})));
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug.state.connected);
  assert.equal(await page.locator('#prompt').inputValue(),'Keep this draft, do not execute it');
  assert.deepEqual(errors,[]);
  await context.close();
  const fallbackContext = await browser.newContext({ ignoreHTTPSErrors:true });
  await fallbackContext.addInitScript(() => { globalThis.WebSocket = class { constructor() { throw new Error('Fixture blocks WS'); } }; });
  const fallback = await fallbackContext.newPage(); fallback.setDefaultTimeout(10000);
  edgeToken = await token(8);
  await fallback.goto(origin, { waitUntil:'domcontentloaded' });
  await fallback.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.transport==='sse' && globalThis.__codexWebuiDebug.state.connected);
  await fallback.locator('#prompt').fill('SSE draft'); blocked=true;
  await fallback.locator('#accessGate').waitFor({state:'visible'});
  assert.equal(await fallback.evaluate(()=>globalThis.__codexWebuiDebug.state.events),null);
  await fallbackContext.close();
  // A deployed gateway can also expose an explicit local inspection entry.
  // Exercise the real bootstrap and mutation guard, not only its static HTML.
  server.kill('SIGTERM'); await server.exited; server = startGateway(true, true);
  for (let attempt=0;;attempt++) { try { if((await (await fetch(base+'/api/health')).json()).codex)break; } catch {} if(attempt>100)throw new Error('Local inspection restart failed');await Bun.sleep(50); }
  const localStatus = await fetch(base+'/api/auth/status');
  assert.equal(localStatus.status,200);
  assert.deepEqual(await localStatus.json(), {mode:'cloudflare-access',authenticated:true,setupRequired:false,passwordRequired:false,expiresAt:null,identity:null,loginUrl:origin+'/'});
  assert.equal((await request('/api/config')).status,401,'Public Host still requires Access');
  for (const extra of [{origin:'https://evil.example'}, {'cf-connecting-ip':'203.0.113.1'}, {'x-forwarded-for':'127.0.0.1'}]) assert.equal((await fetch(base+'/api/config',{headers:extra})).status,403);
  assert.equal(await deniedSocket('/ws', {host:`127.0.0.1:${serverPort}`,origin:'https://evil.example'}),403);
  assert.equal(await deniedSocket('/terminal', {host:`127.0.0.1:${serverPort}`,origin:'https://evil.example'}),403);
  const localContext = await browser.newContext();
  const localPage = await localContext.newPage(); const localErrors=[];localPage.on('pageerror',error=>localErrors.push(error.message));
  await localPage.goto(base,{waitUntil:'domcontentloaded'});
  await localPage.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
  assert.equal(await localPage.locator('#accessGate').isVisible(),false);
  const uploadStatus = await localPage.evaluate(async cwd => (await fetch('/api/attachments/upload?name=local-check.txt&cwd='+encodeURIComponent(cwd), {method:'POST',headers:{'content-type':'application/octet-stream','x-workspace-request':'1'},body:'Local inspection fixture'})).status, fixture);
  assert.equal(uploadStatus,200);
  const localEvents = await fetch(base+'/api/events');
  assert.equal(localEvents.status,200);const eventReader=localEvents.body.getReader();
  assert.match(new TextDecoder().decode((await eventReader.read()).value),/retry:/);await eventReader.cancel();
  assert.deepEqual(localErrors,[]);await localContext.close();
  console.log('PASS: Access HTTP/WS/SSE identity, origin, bypass denial, key rotation, expiry, draft recovery and no automatic turn submission');
} finally {
  await browser?.close(); server.kill('SIGTERM'); await server.exited;
  for (const socket of sockets) socket.destroy(); await new Promise(resolve=>edge.close(resolve));
  rmSync(fixture,{recursive:true,force:true});
}
