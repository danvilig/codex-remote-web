// Isolated project outside HOME; no model, personal credentials or cloud access.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {createServer} from 'node:net';
import WebSocket from 'ws';
import {root} from '../helpers/browser-runtime.mjs';
const fixture=await mkdtemp(join(tmpdir(),'crw-project-roots-'));
const home=join(fixture,'home'),project=join(fixture,'project'),outside=join(fixture,'outside');
for(const directory of [home,project,outside])await mkdir(directory);
await writeFile(join(project,'visible.txt'),'PROJECT_FILE');await writeFile(join(outside,'secret.txt'),'OUTSIDE');
await writeFile(join(project,'.env'),'PRIVATE_FIXTURE');
await symlink(outside,join(project,'escape'));
const init=Bun.spawnSync(['git','init','-q',project]);assert.equal(init.exitCode,0);
const port=await new Promise(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const base=`http://127.0.0.1:${port}`;
const server=Bun.spawn(['bun','src/server/index.ts'],{cwd:root,env:{...process.env,HOME:home,CODEX_HOME:join(home,'.codex'),CODEX_AUTH_PATH:join(home,'auth.json'),HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_AUTH_MODE:'local',CODEX_WEBUI_CWD:project,CODEX_WEBUI_REVIEW_ROOT:project,CODEX_WEBUI_ENABLE_TERMINAL:'true',PATH:join(root,'tests/fixtures')+delimiter+process.env.PATH},stdout:'ignore',stderr:'ignore'});
let ws;
try {
 for(let i=0;;i++){try{if((await(await fetch(base+'/api/health')).json()).codex)break;}catch{}if(i>100)throw new Error('Fixture startup failed');await Bun.sleep(40);}
 for(const endpoint of ['/api/customize','/api/workspace/context','/api/files/search?query=visible','/api/settings/worktrees']) {
  const response=await fetch(base+endpoint);assert.equal(response.status,200,endpoint);
  const result=await response.json();if(endpoint==='/api/customize')assert.equal(result.skillsAvailable,true);
  if(endpoint.startsWith('/api/files/search'))assert.ok(JSON.stringify(result).includes('visible.txt'));
 }
 for(const path of [fixture,outside,join(project,'escape')])for(const endpoint of ['/api/customize','/api/workspace/context','/api/files/search','/api/settings/worktrees']) {
  assert.equal((await fetch(base+endpoint+'?query=visible&cwd='+encodeURIComponent(path))).status,400,endpoint+' must reject '+path);
 }
 assert.equal((await(await fetch(base+'/api/folders?path='+encodeURIComponent(project))).json()).parent,null);
 assert.equal((await fetch(base+'/api/files/download?path='+encodeURIComponent(join(outside,'secret.txt')))).status,404);
 assert.equal((await fetch(base+'/api/files/download?path='+encodeURIComponent(join(project,'.env')))).status,404);
 for(const path of [fixture,outside,join(project,'escape')]) {
  // Existing terminal compatibility behavior falls back to the configured project.
  const bounded=new WebSocket(`ws://127.0.0.1:${port}/terminal?cwd=${encodeURIComponent(path)}`);let output='';
  bounded.on('message',data=>output+=String(data));
  try {
   await new Promise((resolve,reject)=>{bounded.once('open',resolve);bounded.once('error',reject);});
   bounded.send(Buffer.from('pwd\n'));
   for(let i=0;!output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split('\n').some(line=>line.trim()===project);i++){if(i>100)throw new Error('Terminal did not confirm its configured project');await Bun.sleep(30);}
  }finally{bounded.terminate();}
 }
 ws=new WebSocket(`ws://127.0.0.1:${port}/terminal?cwd=${encodeURIComponent(project)}`);let output='';ws.on('message',data=>output+=String(data));
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
 ws.send(Buffer.from("printf 'ROOTS_PTY_OK\\n'\n"));
 for(let i=0;!/(?:\r|\n)ROOTS_PTY_OK\r?\n/.test(output);i++){if(i>100)throw new Error('PTY failed in outside-HOME project');await Bun.sleep(30);}
 console.log('PASS: explicit outside-HOME project serves all project APIs and PTY; parent, siblings and symlink escapes denied');
}finally{ws?.terminate();server.kill('SIGTERM');await server.exited;await rm(fixture,{recursive:true,force:true});}
