// Real Unix transport, isolated state and a local provider stub. No model turn,
// real account, daemon configuration or user's conversation is touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, chmod, writeFile, rm, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createAppServerBridge } from '../../src/server/bridge/app-server.ts';

const home=await mkdtemp('/tmp/crw-shared-native-');await chmod(home,0o700);
const socket=join(home,'server.sock'),calls=[],events=[];
const provider=createServer((request,response)=>{response.writeHead(503,{'content-type':'application/json'});response.end('{"error":{"message":"Isolated test provider; execution disabled"}}');});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
await writeFile(join(home,'config.toml'),`model = "fixture-no-execution"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Isolated fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
const processServer=spawn(process.env.CODEX_BINARY||'codex',['app-server','--listen',`unix://${socket}`],{cwd:home,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,CODEX_AUTH_PATH:join(home,'absent-auth.json')},stdio:['ignore','ignore','pipe']});
let stderr='';processServer.stderr.on('data',chunk=>stderr+=chunk);
const bridges=[];
async function connect(name){
  let resolve;const ready=new Promise(done=>resolve=done);
  const bridge=createAppServerBridge({cwd:home,connection:{mode:'shared',socket},clientInfo:{name,version:'1'},onHome:value=>assert.equal(value,home),onMessage:message=>events.push(message),onStatus:status=>{if(status.status==='connected')resolve();}});
  bridges.push(bridge);bridge.start();
  let timeout;try{await Promise.race([ready,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Shared readiness failed: '+stderr)),10000);})]);}finally{clearTimeout(timeout);}
  return {request:async(method,params)=>{calls.push(method);return bridge.request(method,params);},stop:()=>bridge.stop()};
}
try{
  for(let attempt=0;;attempt++){try{await access(socket);break}catch{}if(attempt>100||processServer.exitCode!==null)throw Error('Native Unix startup failed: '+stderr);await Bun.sleep(30);}
  const desktop=await connect('shared-desktop-fixture'),web=await connect('shared-web-fixture');
  const {thread}=await desktop.request('thread/start',{cwd:home,sandbox:'read-only',approvalPolicy:'on-request'});
  await desktop.request('thread/inject_items',{threadId:thread.id,items:[{type:'message',role:'user',content:[{type:'input_text',text:'SHARED_DESKTOP_HISTORY'}]}]});
  // New empty threads are not persisted until their first history item.
  let resumed;for(let attempt=0;;attempt++){try{resumed=await web.request('thread/resume',{threadId:thread.id,excludeTurns:true});break}catch(error){if(attempt>50)throw error;await Bun.sleep(30);}}
  assert.equal(resumed.thread.id,thread.id);
  await web.request('thread/inject_items',{threadId:thread.id,items:[{type:'message',role:'user',content:[{type:'input_text',text:'SHARED_WEB_HISTORY'}]}]});
  let persisted='';for(let attempt=0;;attempt++){const {readFile}=await import('node:fs/promises');persisted=await readFile(thread.path,'utf8');if(persisted.includes('SHARED_WEB_HISTORY')&&persisted.includes('SHARED_DESKTOP_HISTORY'))break;if(attempt>50)throw Error('Shared history was not persisted');await Bun.sleep(30);}
  await web.stop();
  assert.equal(processServer.exitCode,null,'gateway detach must preserve native server');
  assert.equal((await desktop.request('thread/read',{threadId:thread.id,includeTurns:false})).thread.id,thread.id);
  assert(!calls.some(method=>['turn/start','turn/steer'].includes(method)));
  console.log('PASS: installed native Unix App Server, two clients resume/write the same persistent thread without writer conflict, detach preserves the other client; isolated provider, no model turn');
}finally{
  for(const bridge of bridges)await bridge.stop();
  const closed=processServer.exitCode!==null?Promise.resolve():new Promise(resolve=>processServer.once('close',resolve));
  processServer.kill('SIGTERM');await closed;
  await new Promise(resolve=>provider.close(resolve));await rm(home,{recursive:true,force:true});
}
