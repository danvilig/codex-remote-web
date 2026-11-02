import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createSideChatService } from '../../src/server/services/side-chats.js';

function fixture() {
 const calls:any[]=[];let time=0,next=0;
 const service=createSideChatService({now:()=>time,resolveCwd:value=>{if(value!=='/project')throw Error('Invalid project');return value;},request:async(method,params)=>{
  calls.push({method,params});
  if(method==='thread/read')return {thread:{id:params.threadId,cwd:'/project'}};
  if(method==='thread/turns/list')return {data:[{id:'running',status:'inProgress',items:[]},{id:'boundary',status:'completed',items:[]}]};
  if(['thread/fork','thread/start'].includes(method))return {thread:{id:`native-${++next}`,cwd:'/project',ephemeral:params.ephemeral,turns:[]}};
  return {};
 }});
 return {service,calls,advance:()=>time=700000};
}
test('temporary native branch uses a stable source prefix and never hydrates/resumes ephemeral history',async()=>{
 const {service,calls}=fixture(),sessionId=randomUUID();
 try{
  const [a,b]=await Promise.all([service.handle({action:'create',sessionId,sourceThreadId:'source'}),service.handle({action:'create',sessionId,sourceThreadId:'source'})]);
  expect(a.thread.id).toBe(b.thread.id);
  expect(calls.filter(c=>c.method==='thread/fork')).toEqual([{method:'thread/fork',params:{threadId:'source',lastTurnId:'boundary',ephemeral:true,excludeTurns:true}}]);
  service.observeTurn({threadId:a.thread.id,input:[{type:'text',text:'Side question'}]}, {turn:{id:'side-turn',status:'inProgress'}});
  service.notify({method:'item/completed',params:{threadId:a.thread.id,turnId:'side-turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Side answer'}}});
  service.notify({method:'turn/completed',params:{threadId:a.thread.id,turn:{id:'side-turn',status:'completed',items:[]}}});
  const snapshot=await service.handle({action:'snapshot',sessionId});expect(snapshot.turns[0].items.length).toBe(2);expect(snapshot.activeTurnId).toBe('');
  expect(calls.some(c=>c.method==='turn/start'||c.method==='thread/resume')).toBe(false);
  const saved=await service.handle({action:'promote',sessionId});expect(saved.thread.ephemeral).toBe(false);
  expect(calls).toContainEqual({method:'thread/fork',params:{threadId:'source',lastTurnId:'boundary',ephemeral:false,excludeTurns:true}});
  expect(calls.find(c=>c.method==='thread/inject_items').params.items).toEqual([{type:'message',role:'user',content:[{type:'input_text',text:'Side question'}]},{type:'message',role:'assistant',content:[{type:'output_text',text:'Side answer'}]}]);
  expect((await service.handle({action:'promote',sessionId})).thread.id).toBe(saved.thread.id);
  expect(calls.filter(c=>c.method==='thread/inject_items').length).toBe(1);
  await service.handle({action:'release',sessionId});await expect(service.handle({action:'snapshot',sessionId})).rejects.toThrow();
  expect(calls).toContainEqual({method:'thread/unsubscribe',params:{threadId:a.thread.id}});
 }finally{await service.stop();}
});
test('release interrupts only its side turn and rejects invalid page keys and payloads',async()=>{
 const {service,calls}=fixture(),sessionId=randomUUID();
 try{
  for(const payload of [{action:'create',sessionId:'forged',cwd:'/project'},{action:'create',sessionId,cwd:'/etc'},{action:'create',sessionId,cwd:'/project',config:{}}])await expect(service.handle(payload)).rejects.toThrow();
  const {thread}=await service.handle({action:'create',sessionId:randomUUID(),cwd:'/project'});
  const id=randomUUID();const side=await service.handle({action:'create',sessionId:id,cwd:'/project'});
  service.observeTurn({threadId:side.thread.id,input:[]},{turn:{id:'active-side',status:'inProgress'}});
  await expect(service.handle({action:'promote',sessionId:id})).rejects.toThrow();
  await service.handle({action:'release',sessionId:id});
  expect(calls.filter(c=>c.method==='turn/interrupt')).toEqual([{method:'turn/interrupt',params:{threadId:side.thread.id,turnId:'active-side'}}]);
  expect(calls.some(c=>c.method==='thread/delete')).toBe(false);
 }finally{await service.stop();}
});
test('uncertain context import is never automatically replayed',async()=>{
 let injections=0;
 const sessionId=randomUUID();const service=createSideChatService({resolveCwd:()=>'/project',request:async(method,params)=>{
  if(method==='thread/start')return {thread:{id:params.ephemeral?'side':'saved',cwd:'/project',ephemeral:params.ephemeral}};
  if(method==='thread/inject_items'){injections++;throw Error('Transport lost');}return {};
 }});
 try{
  const {thread}=await service.handle({action:'create',sessionId,cwd:'/project'});
  service.observeTurn({threadId:thread.id,input:[{type:'text',text:'Question'}]},{turn:{id:'done',status:'completed'}});
  await expect(service.handle({action:'promote',sessionId})).rejects.toThrow();
  await expect(service.handle({action:'promote',sessionId})).rejects.toThrow();expect(injections).toBe(1);
 }finally{await service.stop();}
});
test('closing during turn submission waits for acceptance and interrupts the accepted side turn',async()=>{
 const {service,calls}=fixture(),sessionId=randomUUID();
 let accept;const accepted=new Promise(resolve=>accept=resolve);
 try{
  const {thread}=await service.handle({action:'create',sessionId,cwd:'/project'});
  const starting=service.startTurn({threadId:thread.id,input:[]},()=>accepted);
  await expect(service.startTurn({threadId:thread.id},()=>Promise.resolve({}))).rejects.toThrow();
  const closing=service.handle({action:'release',sessionId});
  accept({turn:{id:'late-accepted',status:'inProgress'}});await starting;await closing;
  expect(calls).toContainEqual({method:'turn/interrupt',params:{threadId:thread.id,turnId:'late-accepted'}});
  await expect(service.handle({action:'snapshot',sessionId})).rejects.toThrow();
 }finally{await service.stop();}
});
test('abandoned pages expire without retaining a recoverable session key',async()=>{
 const {service,advance}=fixture(),sessionId=randomUUID();
 try{await service.handle({action:'create',sessionId,cwd:'/project'});advance();await expect(service.handle({action:'snapshot',sessionId})).rejects.toThrow();}
 finally{await service.stop();}
});
