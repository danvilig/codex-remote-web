import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDeliveryQueue } from '../../src/server/services/delivery-queue.js';
import { createDeliveryStore } from '../../src/server/services/delivery-store.js';
import { createSubmissionService } from '../../src/server/services/submissions.js';

const wait = async (fn:()=>Promise<boolean>) => { for(let n=0;n<100;n++){if(await fn())return;await Bun.sleep(20);}throw Error('Timed out'); };
async function fixture(run:any) {
  const root=await mkdtemp(join(tmpdir(),'crw-queue-'));let active:any={id:'turn-existing',status:'inProgress'},starts=0,steers=0,fail=false;
  const calls:any[]=[];
  const request=async(method:string,params:any)=>{
    calls.push({method,params});
    if(method==='thread/read'||method==='thread/resume')return {thread:{id:params.threadId,turns:active?[active]:[]}};
    if(method==='turn/start'||method==='turn/steer'){
      if(method==='turn/start')starts++;else steers++;
      if(fail)throw Object.assign(Error('Connection lost after send'),{code:'RPC_DISCONNECTED'});
      active={id:'turn-'+starts,status:'inProgress'};return {turn:active};
    }
    return {};
  };
  const submissions=createSubmissionService({privateRoot:root,request,connected:()=>true});
  const opts={privateRoot:root,submissions,request,connected:()=>true,pollMs:25};
  const queue=createDeliveryQueue(opts),instances=[queue];
  const enqueue=(id:string,text=id)=>queue.mutate('enqueue',{id,threadId:'thread-A',text,mentions:[],params:{threadId:'thread-A',input:[{type:'text',text}],cwd:root,model:'captured-model',effort:'high',approvalPolicy:'on-request'}});
  try{await run({root,queue,opts,instances,submissions,enqueue,calls,starts:()=>starts,steers:()=>steers,setActive:(turn:any)=>{active=turn},fail:()=>{fail=true}});}finally{for(const instance of instances)await instance.stop();await submissions.close();await rm(root,{recursive:true,force:true});}
}

test('durable queue retains enqueue settings, serializes FIFO, and never dispatches while active',()=>fixture(async(e:any)=>{
  const first=await e.enqueue('00000000-0000-4000-8000-000000000001','First');await e.enqueue('00000000-0000-4000-8000-000000000002','Second');await e.queue.start();
  await wait(async()=>(await e.queue.list()).entries[0]?.status==='waiting');expect(e.starts()).toBe(0);
  e.setActive({id:'turn-existing',status:'completed'});await e.queue.notification({method:'turn/completed',params:{threadId:'thread-A',turn:{id:'turn-existing',status:'completed'}}});
  await wait(async()=>e.starts()===1);await wait(async()=>(await e.queue.list()).entries.length===1);
  expect(e.calls.find((c:any)=>c.method==='turn/start').params).toMatchObject({clientUserMessageId:first.id,model:'captured-model',effort:'high',approvalPolicy:'on-request'});
  await Bun.sleep(60);expect(e.starts()).toBe(1);
  e.setActive(null);await wait(async()=>e.starts()===2);await wait(async()=>(await e.queue.list()).entries.length===0);
  const state=await stat(join(e.root,'remote-web-delivery','queue.json'));expect(state.mode&0o077).toBe(0);
}));

test('queue edits and reordering use versions; stale mutations fail without altering captured settings',()=>fixture(async(e:any)=>{
  const a=await e.enqueue('00000000-0000-4000-8000-000000000001','Old'),b=await e.enqueue('00000000-0000-4000-8000-000000000002','Second');
  const updated=await e.queue.mutate('edit',{id:a.id,version:a.version,text:'Edited'});
  await expect(e.queue.mutate('cancel',{id:a.id,version:a.version})).rejects.toMatchObject({code:'QUEUE_CONFLICT'});
  await e.queue.mutate('reorder',{id:b.id,version:b.version,direction:-1});
  const entries=(await e.queue.list()).entries;expect(entries.map((x:any)=>x.id)).toEqual([b.id,a.id]);
  expect(entries[1].params).toMatchObject({model:'captured-model',input:[{type:'text',text:'Edited'}]});
  expect(updated.owner).toBeUndefined();expect(updated.fingerprint).toBeUndefined();
  await expect(e.enqueue('00000000-0000-4000-8000-000000000001','Changed')).rejects.toMatchObject({code:'QUEUE_CONFLICT'});
}));

test('send now uses expectedTurnId steering and cancellation never interrupts the running turn',()=>fixture(async(e:any)=>{
  const a=await e.enqueue('00000000-0000-4000-8000-000000000001','Steer this');await e.queue.mutate('sendNow',{id:a.id,version:a.version});await e.queue.start();
  await wait(async()=>e.steers()===1);expect(e.calls.find((c:any)=>c.method==='turn/steer').params.expectedTurnId).toBe('turn-existing');
  const b=await e.enqueue('00000000-0000-4000-8000-000000000002','Cancel');
  // The live dispatcher can legitimately advance queued -> waiting between
  // enqueue and cancel. Re-read the actual CAS version, just as the UI does.
  await wait(async()=>{
    const current=(await e.queue.list()).entries.find((entry:any)=>entry.id===b.id);
    if(!current)return true;
    try{await e.queue.mutate('cancel',{id:b.id,version:current.version});return true;}
    catch(error){if(error.code==='QUEUE_CONFLICT')return false;throw error;}
  });
  expect(e.calls.some((c:any)=>c.method==='turn/interrupt')).toBe(false);
}));

test('second live gateway does not pause or duplicate the owning gateway queue',()=>fixture(async(e:any)=>{
  await e.enqueue('00000000-0000-4000-8000-000000000001');await e.queue.start();await wait(async()=>(await e.queue.list()).entries[0]?.status==='waiting');
  const other=createDeliveryQueue(e.opts);e.instances.push(other);await other.start();await Bun.sleep(80);
  expect((await other.list()).entries[0].status).toBe('waiting');expect(e.starts()).toBe(0);
  e.setActive(null);await wait(async()=>e.starts()===1);await Bun.sleep(100);expect(e.starts()).toBe(1);
}));

test('restart pauses dead-owner queues and uncertain submissions are not replayed or mutable',()=>fixture(async(e:any)=>{
  await e.enqueue('00000000-0000-4000-8000-000000000001');await createDeliveryStore(e.root).transaction((state:any)=>{state.entries[0].owner={pid:2147483647,host:'dead-owner'};return {};});
  await e.queue.start();expect((await e.queue.list()).entries[0].status).toBe('paused');
  const paused=(await e.queue.list()).entries[0];await e.queue.mutate('resume',{id:paused.id,version:paused.version});e.fail();e.setActive(null);
  await wait(async()=>(await e.queue.list()).entries[0]?.status==='unknown');expect(e.starts()).toBe(1);
  await Bun.sleep(120);expect(e.starts()).toBe(1);
  const unknown=(await e.queue.list()).entries[0];await expect(e.queue.mutate('resume',{id:unknown.id,version:unknown.version})).rejects.toMatchObject({code:'QUEUE_CONFLICT'});
}));

test('protected attachment IDs include queued and uncertain messages but exclude cancellation',()=>fixture(async(e:any)=>{
  const a=await e.queue.mutate('enqueue',{id:'00000000-0000-4000-8000-000000000001',threadId:'thread-A',text:'Attachment',mentions:[{id:'attachment-1',source:'attachment'}],params:{threadId:'thread-A',input:[{type:'text',text:'Attachment'}]}});
  expect(await e.queue.protectedAttachmentIds()).toEqual(new Set(['attachment-1']));await e.queue.mutate('cancel',{id:a.id,version:a.version});expect((await e.queue.protectedAttachmentIds()).size).toBe(0);
}));

test('deferred beforeDispatch records a newly active turn so interruption pauses the queue',()=>fixture(async(e:any)=>{
  e.setActive(null);
  let guarded=false;
  const submissions={...e.submissions,submit:async(input:any)=>{
    e.setActive({id:'external-new-turn',status:'inProgress'});
    guarded=await input.beforeDispatch();
    return {id:input.id,status:'deferred'};
  }};
  const queue=createDeliveryQueue({...e.opts,submissions,pollMs:500});e.instances.push(queue);
  await queue.mutate('enqueue',{id:'00000000-0000-4000-8000-000000000003',threadId:'thread-A',text:'Later',params:{threadId:'thread-A',input:[{type:'text',text:'Later'}]}});
  await queue.start();await wait(async()=>(await queue.list()).entries[0]?.status==='waiting');
  expect(guarded).toBe(false);expect((await queue.list()).entries[0].waitTurnId).toBe('external-new-turn');
  await queue.notification({method:'turn/completed',params:{threadId:'thread-A',turn:{id:'external-new-turn',status:'interrupted'}}});
  expect((await queue.list()).entries[0].status).toBe('paused');expect(e.starts()).toBe(0);
}));

test('unknown receipt reconciliation unblocks visibility but requires explicit resume of subsequent messages',()=>fixture(async(e:any)=>{
  let resolved=false;
  const submissions={submit:async(input:any)=>({id:input.id,status:'unknown'}),get:async(id:string)=>resolved?{id,status:'accepted'}:{id,status:'unknown'}};
  const queue=createDeliveryQueue({...e.opts,submissions});e.instances.push(queue);
  for(const id of ['00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004'])await queue.mutate('enqueue',{id,threadId:'thread-A',text:id,params:{threadId:'thread-A',input:[{type:'text',text:id}]}});
  e.setActive(null);await queue.start();await wait(async()=>(await queue.list()).entries[0]?.status==='unknown');
  resolved=true;const entries=(await queue.list()).entries;expect(entries).toHaveLength(1);expect(entries[0].status).toBe('paused');expect(entries[0].requiresResume).toBe(true);
  await Bun.sleep(100);expect((await queue.list()).entries[0].status).toBe('paused');
}));

test('unknown queued delivery blocks sendNow, resume and reorder without bypassing FIFO',()=>fixture(async(e:any)=>{
  let submits=0;
  const submissions={submit:async(input:any)=>{submits++;return {id:input.id,status:'unknown'};},get:async(id:string)=>({id,status:'unknown'}),list:async()=>[]};
  const queue=createDeliveryQueue({...e.opts,submissions});e.instances.push(queue);
  for(const [index,text] of ['Unknown first','Second','Third'].entries())await queue.mutate('enqueue',{id:`00000000-0000-4000-8000-00000000000${index+3}`,threadId:'thread-A',text,params:{threadId:'thread-A',input:[{type:'text',text}]}});
  e.setActive(null);await queue.start();await wait(async()=>(await queue.list()).entries[0]?.status==='unknown');
  const entries=(await queue.list()).entries;
  for(const [action,entry,extra] of [['sendNow',entries[1],{}],['resume',entries[1],{}],['reorder',entries[2],{direction:-1}]])
    await expect(queue.mutate(action,{id:entry.id,version:entry.version,...extra})).rejects.toMatchObject({code:'QUEUE_DELIVERY_UNCONFIRMED'});
  await Bun.sleep(100);expect(submits).toBe(1);expect((await queue.list()).entries.map((entry:any)=>entry.text)).toEqual(['Unknown first','Second','Third']);
}));

test('direct pending or unknown submission blocks queue dispatch and mutations until accepted or rejected',()=>fixture(async(e:any)=>{
  let status='unknown',submits=0;
  const directId='00000000-0000-4000-8000-000000000009';
  const submissions={submit:async(input:any)=>{submits++;return {id:input.id,status:'accepted'};},get:async()=>null,list:async()=>[{id:directId,threadId:'thread-A',status}]};
  const queue=createDeliveryQueue({...e.opts,submissions});e.instances.push(queue);
  const first=await queue.mutate('enqueue',{id:'00000000-0000-4000-8000-000000000003',threadId:'thread-A',text:'Queued',params:{threadId:'thread-A',input:[{type:'text',text:'Queued'}]}});
  e.setActive(null);await queue.start();
  for(const pending of ['unknown','prepared','dispatching']){
    status=pending;await Bun.sleep(75);expect(submits).toBe(0);
    await expect(queue.mutate('sendNow',{id:first.id,version:first.version})).rejects.toMatchObject({code:'QUEUE_DELIVERY_UNCONFIRMED'});
  }
  status='accepted';await wait(async()=>submits===1);await wait(async()=>(await queue.list()).entries.length===0);
  status='rejected';await queue.mutate('enqueue',{id:'00000000-0000-4000-8000-000000000004',threadId:'thread-A',text:'Next',params:{threadId:'thread-A',input:[{type:'text',text:'Next'}]}});
  await wait(async()=>submits===2);
}));

test('guard under the thread lock defers when another direct submission becomes unknown after reservation',()=>fixture(async(e:any)=>{
  let listCalls=0,nativeSends=0;
  const receipt={id:'00000000-0000-4000-8000-000000000009',threadId:'thread-A',status:'unknown'};
  const submissions={
    list:async()=>++listCalls===1?[]:[receipt],
    get:async()=>null,
    submit:async(input:any)=>{if(!await input.beforeDispatch())return {id:input.id,status:'deferred'};nativeSends++;return {id:input.id,status:'accepted'};}
  };
  const queue=createDeliveryQueue({...e.opts,submissions});e.instances.push(queue);
  await queue.mutate('enqueue',{id:'00000000-0000-4000-8000-000000000003',threadId:'thread-A',text:'Later',params:{threadId:'thread-A',input:[{type:'text',text:'Later'}]}});
  e.setActive(null);await queue.start();await wait(async()=>(await queue.list()).entries[0]?.status==='waiting');
  expect(nativeSends).toBe(0);await Bun.sleep(100);expect(nativeSends).toBe(0);
}));
