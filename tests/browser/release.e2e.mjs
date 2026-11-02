import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, realpathSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, delimiter, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { root } from '../helpers/browser-runtime.mjs';
import { documentationImages } from '../../scripts/documentation-assets.ts';

const fixture = mkdtempSync(join(tmpdir(), 'crw-package-test-'));
const home = join(fixture, 'home'), project = join(fixture, 'project');
mkdirSync(home); mkdirSync(project);
writeFileSync(join(project, 'visible.txt'), 'PACKAGED_PROJECT_FILE');
const pkg = JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const name = `${pkg.name}-${pkg.version}`;
const archive = join(fixture, 'releases', `${name}.tar.gz`);
async function run(args, cwd = root, extraEnv = {}) { const child = Bun.spawn(args,{cwd,env:{...process.env,...extraEnv},stdout:'pipe',stderr:'pipe'});const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);assert.equal(code,0,`${args[0]} failed: ${error.slice(-3000)}`);return out; }
let server, setup;
try {
  if (process.env.CODEX_WEBUI_RELEASE_ARCHIVE) {
    // Validate the exact immutable candidate, not a newly generated substitute.
    mkdirSync(join(fixture, 'releases'));
    copyFileSync(process.env.CODEX_WEBUI_RELEASE_ARCHIVE, archive);
    copyFileSync(process.env.CODEX_WEBUI_RELEASE_ARCHIVE + '.sha256', archive + '.sha256');
  } else await run(['bun','scripts/release.ts','--allow-dirty','--output-dir',join(fixture,'releases')]);
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex'); assert.ok(readFileSync(`${archive}.sha256`,'utf8').startsWith(digest));
  const listing = await run(['tar','-tzf',archive]);
  for (const internal of ['docs/images/README.md', 'scripts/capture-docs.ts', 'tests/browser/readme-screenshot.mjs', 'tests/fixtures/showcase-codex.mjs']) assert.equal(listing.includes(`/${internal}`),false,`Internal documentation tooling leaked into archive: ${internal}`);
  assert.equal(/\/(?:node_modules|src|tests|history|\.artifacts|\.git)\//.test(listing),false);
  assert.equal(listing.split('\n').some(path=>path.endsWith('/.env')),false);
  assert.equal(/codex-app-icon|codex-motion|overview\.png/.test(listing),false);
  await run(['tar','-xzf',archive,'-C',fixture]);
  const unpacked = join(fixture,name);
  for (const readme of ['README.md', 'README-zh.md']) assert.equal(readFileSync(join(unpacked,readme),'utf8'),readFileSync(join(root,readme),'utf8'),`Bilingual README missing or changed: ${readme}`);
  for (const image of documentationImages) assert.deepEqual(readFileSync(join(unpacked,image)),readFileSync(join(root,image)),`README image missing or changed in archive: ${image}`);
  const manifest=JSON.parse(readFileSync(join(unpacked,'release.json'),'utf8'));assert.equal(manifest.version,pkg.version);
  if (existsSync(join(root,'SOURCE_PROVENANCE.json'))) {
    const provenance=JSON.parse(readFileSync(join(root,'SOURCE_PROVENANCE.json'),'utf8'));
    assert.equal(manifest.source,'public-snapshot');assert.equal(manifest.developmentCommit,provenance.developmentCommit);
    assert.equal(manifest.commit,(await run(['git','rev-parse','HEAD'])).trim());
    assert.deepEqual(JSON.parse(readFileSync(join(unpacked,'SOURCE_PROVENANCE.json'),'utf8')),provenance);
  }
  function scan(directory) { for(const entry of readdirSync(directory,{withFileTypes:true})) { const path=join(directory,entry.name);if(entry.isDirectory())scan(path);else { const data=readFileSync(path,'utf8');assert.equal(/\/home\/ubuntu|M11\.9434 0\.430908|assets\/codex-motion|lottie-web/.test(data),false,`Private/extracted material in ${entry.name}`); } } }
  scan(unpacked);
  const inventory=JSON.parse(readFileSync(join(unpacked,'third-party/dependencies.json'),'utf8'));
  assert.ok(inventory.length>10);
  const purifier=inventory.find(item=>item.name==='dompurify');assert.equal(purifier.version,'3.4.17');
  assert.ok(purifier.notices.some(path=>/LICENSE$/i.test(path)));
  assert.match(readFileSync(join(unpacked,purifier.notices.find(path=>/LICENSE$/i.test(path))),'utf8'),/Apache License/);
  assert.equal(inventory.find(item=>item.name==='katex').version,'0.18.2');
  // Keep clean-install verification independent of the developer's caches and
  // writable HOME. This also exercises installation on sandboxed release hosts.
  await run(['bun','install','--production','--frozen-lockfile'],unpacked,{BUN_INSTALL_CACHE_DIR:join(fixture,'bun-cache')});
  // PTY is a native dependency: validate source rebuild with installed headers, without downloading Node.
  const nodePath=realpathSync(Bun.which('node'));
  await run(['npm','rebuild','node-pty'],unpacked,{npm_config_nodedir:dirname(dirname(nodePath)),npm_config_cache:join(fixture,'npm-cache')});
  const port = await new Promise(resolve=>{const probe=createServer();probe.listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>resolve(value));});});
  const quickBin=join(fixture,'quick-bin');mkdirSync(quickBin);
  copyFileSync(join(root,'tests/fixtures/quick-cloudflared.mjs'),join(quickBin,'quick-cloudflared.mjs'));
  const quickPort=await new Promise(resolve=>{const probe=createServer();probe.listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>resolve(value));});});
  writeFileSync(join(quickBin,'quick-fixture.json'),JSON.stringify({port:quickPort,state:join(fixture,'quick-state.json')}));
  writeFileSync(join(quickBin,'cloudflared'),`#!/bin/sh\nexec '${nodePath.replaceAll("'","'\\''")}' '${join(quickBin,'quick-cloudflared.mjs').replaceAll("'","'\\''")}' "$@"\n`,{mode:0o700});
  const env={...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_AUTH_MODE:'local',HOME:home,CODEX_HOME:join(home,'.codex'),CODEX_AUTH_PATH:join(home,'auth.json'),CODEX_WEBUI_CWD:project,CODEX_WEBUI_REVIEW_ROOT:project,CODEX_WEBUI_ENABLE_TERMINAL:'true',CODEX_WEBUI_ENABLE_REVIEW_WRITE:'false',SHELL:'/bin/bash',PATH:`${quickBin}${delimiter}${join(root,'tests/fixtures')}${delimiter}${process.env.PATH}`};
  // Start from a different cwd and without source: no frontend rebuild may be needed.
  server=Bun.spawn(['bun',join(unpacked,'dist/server.js')],{cwd:fixture,env,stdout:'pipe',stderr:'pipe'});
  const serverError=new Response(server.stderr).text();
  for(let attempt=0;;attempt++){try {const response=await fetch(`http://127.0.0.1:${port}/api/health`);if((await response.json()).codex)break;}catch{} if(attempt>=100)throw new Error('Packaged gateway failed to start');await Bun.sleep(50);}
  for (const path of ['/', '/app.bundle.js', '/auth-bootstrap.js', '/access-session.js', '/i18n.js', '/codex-brand.js', '/workspace.css', '/remote-access.css', '/setup', '/setup.bundle.js', '/setup-assets/style.css', '/vendor/katex/katex.min.css', '/vendor/xterm/xterm.css']) assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status,200,path);
  assert.equal(existsSync(join(unpacked,'public/app.js')),false);assert.ok(existsSync(join(unpacked,'dist/quick-worker.js')));
  // The standalone configuration page must also start without source or an App Server.
  const setupLog=join(fixture,'setup.log');
  setup=Bun.spawn(['bun',join(unpacked,'dist/setup.js')],{cwd:fixture,env,stdout:Bun.file(setupLog),stderr:'pipe'});
  let setupUrl;
  for(let attempt=0;;attempt++){try { setupUrl=readFileSync(setupLog,'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/setup#setup=[A-Za-z0-9_-]+/)?.[0];if(setupUrl)break; }catch{} if(attempt>100)throw new Error('Packaged setup failed to start');await Bun.sleep(50);}
  const setupOrigin=new URL(setupUrl).origin;
  for(const path of ['/setup','/setup.bundle.js','/setup-assets/style.css','/setup-assets/workspace.css','/setup-assets/remote-access.css'])assert.equal((await fetch(setupOrigin+path)).status,200,path);
  setup.kill('SIGTERM');await setup.exited;setup=null;

  for(const endpoint of ['/api/customize','/api/schedules','/api/library','/api/workspace/context','/api/files/search?query=visible'])assert.equal((await fetch(`http://127.0.0.1:${port}${endpoint}`)).status,200,endpoint);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/api/files/download?path=${encodeURIComponent(join(project,'visible.txt'))}`)).text(),'PACKAGED_PROJECT_FILE');
  assert.equal((await(await fetch(`http://127.0.0.1:${port}/api/library/preview?path=${encodeURIComponent(join(project,'visible.txt'))}`)).json()).text,'PACKAGED_PROJECT_FILE');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/workspace/context?cwd=${encodeURIComponent(fixture)}`)).status,400);
  const ws=new WebSocket(`ws://127.0.0.1:${port}/terminal?cwd=${encodeURIComponent(project)}`);
  let terminal='';ws.on('message',data=>{terminal+=String(data);});
  await new Promise((resolve,reject)=>{ws.on('open',resolve);ws.on('error',reject);});
  ws.send(Buffer.from("printf 'PACKAGED_PTY_OK\\n'\nexit\n"));
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.terminate();reject(new Error('Packaged terminal timed out'));},5000);ws.on('close',()=>{clearTimeout(timer);resolve();});});
  assert.match(terminal,/(?:\r|\n)PACKAGED_PTY_OK\r?\n/);
  let csrf,setupCookie;const base=`http://127.0.0.1:${port}`;
  const setupRequest=async(path,body)=>{
    const response=await fetch(base+'/api/setup/'+path,{method:body===undefined?'GET':'POST',headers:{origin:base,'x-setup-request':'1','content-type':'application/json',...(csrf?{'x-setup-csrf':csrf}:{}),...(setupCookie?{cookie:setupCookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return {response,data};
  };
  let session=await setupRequest('launch',{});session=await setupRequest('session',{key:session.data.key});csrf=session.data.csrf;setupCookie=session.response.headers.get('set-cookie').split(';')[0];
  await setupRequest('quick/start',{email:'owner@example.test'});
  for(let attempt=0;;attempt++){const {data}=await setupRequest('quick/status');if(data.phase==='ready')break;if(data.phase==='failed'||attempt>100)throw new Error(data.error||'Packaged temporary origin failed');await Bun.sleep(50);}
  const quickState=JSON.parse(readFileSync(join(fixture,'quick-state.json'),'utf8'));assert.equal(quickState.email,'owner@example.test');
  await setupRequest('quick/stop',{});
  for(let attempt=0;;attempt++){if((await setupRequest('quick/status')).data.phase==='stopped')break;if(attempt>100)throw new Error('Packaged temporary connector did not stop');await Bun.sleep(30);}
  server.kill('SIGTERM');await server.exited;assert.equal((await serverError).includes('Frontend build failed'),false);server=null;
  console.log('PASS: allowlisted archive, checksum, dependency notices, frozen production install, outside-HOME production installation, restricted project APIs, foreign-cwd gateway/setup startup and packaged PTY/temporary-connector workers');
} finally { if(setup){setup.kill('SIGTERM');await setup.exited;}if(server){server.kill('SIGTERM');await server.exited;}rmSync(fixture,{recursive:true,force:true}); }
