// Isolated native protocol check. Never starts a model turn or uses real credentials.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const root=await mkdtemp('/tmp/crw-native-tools-');await writeFile(join(root,'config.toml'),'');
const child=spawn(process.env.CODEX_BINARY || 'codex',['app-server'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:root,CODEX_AUTH_PATH:join(root,'auth.json')},stdio:['pipe','pipe','ignore']});
const pending=new Map();let next=0;const lines=createInterface({input:child.stdout});
lines.on('line',line=>{const msg=JSON.parse(line),task=pending.get(msg.id);if(task){pending.delete(msg.id);msg.error?task.reject(new Error(msg.error.message)):task.resolve(msg.result);}});
const request=(method,params)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
const timeout=setTimeout(()=>{for(const task of pending.values())task.reject(Error('Native probe timed out'));child.kill('SIGKILL');},15000);
try{
 await request('initialize',{clientInfo:{name:'conversation-validation',version:'1'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 const started=await request('thread/start',{cwd:root,sandbox:'read-only',approvalPolicy:'on-request'});
 const {createConversationTools}=await import('../../src/server/services/conversation-tools.js');const tools=createConversationTools(request);
 const saved=await tools.goal({threadId:started.thread.id,action:'set',objective:'Validate native goal storage without starting a model',tokenBudget:1000});assert.equal(saved.goal.status,'active');
 assert.equal((await tools.goal({threadId:started.thread.id,action:'get'})).goal.objective,saved.goal.objective);
 assert.equal((await tools.goal({threadId:started.thread.id,action:'pause'})).goal.status,'paused');
 assert.equal((await tools.goal({threadId:started.thread.id,action:'resume'})).goal.status,'active');
 await tools.goal({threadId:started.thread.id,action:'clear'});assert.equal((await tools.goal({threadId:started.thread.id,action:'get'})).goal,null);
 const {createSideChatService}=await import('../../src/server/services/side-chats.js');
 const {randomUUID}=await import('node:crypto');
 const side=createSideChatService({request,resolveCwd:()=>root});
 try{
  const sessionId=randomUUID();const temporary=await side.handle({action:'create',sessionId,sourceThreadId:started.thread.id,cwd:root});
  assert.equal(temporary.thread.ephemeral,true);assert.equal(temporary.thread.path,null);
  await assert.rejects(tools.goal({threadId:temporary.thread.id,action:'set',objective:'Temporary side objective'}),/ephemeral/);
  const listed=await request('thread/list',{limit:100});assert(!listed.data.some(thread=>thread.id===temporary.thread.id));
  await assert.rejects(request('thread/turns/list',{threadId:temporary.thread.id,limit:1}));
  await assert.rejects(request('thread/resume',{threadId:temporary.thread.id,excludeTurns:true}));
  // Feed deterministic events to the gateway cache, without issuing a model turn.
  side.observeTurn({threadId:temporary.thread.id,input:[{type:'text',text:'SIDE_PROTOCOL_QUESTION'}]},{turn:{id:'probe-turn',status:'completed'}});
  side.notify({method:'item/completed',params:{threadId:temporary.thread.id,turnId:'probe-turn',item:{id:'probe-answer',type:'agentMessage',text:'SIDE_PROTOCOL_ANSWER',phase:'final_answer'}}});
  const saved=await side.handle({action:'promote',sessionId});assert.equal(saved.thread.ephemeral,false);
  for(let attempt=0;;attempt++){
   const log=await readFile(saved.thread.path,'utf8');
   if(log.includes('SIDE_PROTOCOL_QUESTION')&&log.includes('SIDE_PROTOCOL_ANSWER'))break;
   if(attempt>50)throw Error('Native context import was not persisted');await new Promise(resolve=>setTimeout(resolve,20));
  }
  await side.handle({action:'release',sessionId});await assert.rejects(side.handle({action:'snapshot',sessionId}));
 }finally{await side.stop();}
 console.log('PASS: native Goal lifecycle, paginated ephemeral fork/list exclusion, unsupported resume/history, explicit persistent context import and release; no model turn or real credentials');
}catch(error){console.error(error.message);process.exitCode=1;}finally{clearTimeout(timeout);const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');lines.close();await closed;await rm(root,{recursive:true,force:true});}
