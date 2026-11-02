import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createAppServerBridge } from '../../src/server/bridge/app-server.ts';
import { ServerRequestStore } from '../../src/server/bridge/server-requests.js';
import { createSubmissionService } from '../../src/server/services/submissions.js';

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 500; n++) { if (await predicate()) return; await Bun.sleep(10); }
  throw Error('Native recovery fixture timed out');
}

test('shared native disconnect automatically reconnects, rotates approval epoch and reconciles exact accepted clientId without replay', async () => {
  const root = await mkdtemp('/tmp/crw-native-reconnect-'), socket = join(root,'native.sock');
  const server = createServer(), wss = new WebSocketServer({server});
  await new Promise<void>(resolve => server.listen(socket,resolve));
  let connectionCount = 0, connected = false, nativeWrites = 0, current: WebSocket;
  const statuses: string[] = [], replies: any[] = [], store = new ServerRequestStore({requireEpoch:true});
  let accepted: any = null;
  wss.on('connection',ws => {
    connectionCount++; current = ws;
    ws.on('message',raw => {
      const message = JSON.parse(String(raw));
      if (!message.method) {replies.push(message);return;}
      const send = (result:any) => ws.send(JSON.stringify({id:message.id,result}));
      if (message.method === 'initialize') send({codexHome:root});
      if (message.method === 'thread/read') send({thread:{id:'shared-thread',turns:accepted?[accepted]:[]}});
      if (message.method === 'thread/turns/list') send({data:accepted?[accepted]:[],nextCursor:null});
      if (message.method === 'turn/start') {
        nativeWrites++;
        accepted = {id:'surviving-native-turn',status:'inProgress',items:[{id:'native-user',type:'userMessage',clientId:message.params.clientUserMessageId,content:message.params.input}]};
        // Simulate acceptance followed by loss of the RPC response/connection.
        ws.terminate();
      }
    });
  });
  const bridge = createAppServerBridge({cwd:root,clientInfo:{name:'reconnect-fixture',version:'1'},connection:{mode:'shared',socket},onHome:()=>{},onMessage:message=>{if(message.id !== undefined && message.method)store.add(message);},onStatus:status=>{connected=status.status==='connected';statuses.push(status.status);if(!connected)store.clear();}});
  const submissions = createSubmissionService({privateRoot:root,request:bridge.request,connected:()=>connected});
  bridge.start();
  try {
    await until(()=>connected);
    const approval = {id:'reused-native-id',method:'item/commandExecution/requestApproval',params:{threadId:'shared-thread',command:'echo fixture'}};
    current!.send(JSON.stringify(approval)); await until(()=>store.list().length===1);
    const oldEpoch = store.list()[0].requestEpoch;
    const submission = {id:randomUUID(),method:'turn/start',params:{threadId:'shared-thread',input:[{type:'text',text:'native fixture only'}]}};
    expect((await submissions.submit(submission)).status).toBe('unknown');
    await until(()=>connectionCount===2 && connected);
    expect(statuses).toContain('disconnected'); expect(store.epoch).not.toBe(oldEpoch);
    expect(store.list()).toEqual([]);
    const read = await bridge.request('thread/read',{threadId:'shared-thread',includeTurns:true});
    expect(read.thread.turns[0]).toMatchObject({id:'surviving-native-turn',status:'inProgress'});
    current!.send(JSON.stringify(approval)); await until(()=>store.list().length===1);
    const newEpoch = store.list()[0].requestEpoch;
    expect(()=>store.respond(approval.id,{decision:'decline'},null,bridge.send,oldEpoch)).toThrow('earlier connection');
    expect(replies).toHaveLength(0);
    store.respond(approval.id,{decision:'decline'},null,bridge.send,newEpoch);
    await until(()=>replies.length===1);
    expect((await submissions.reconcile(submission.id))?.status).toBe('accepted');
    expect((await submissions.submit(submission)).result.turn.id).toBe('surviving-native-turn');
    expect(nativeWrites).toBe(1);
    await bridge.stop(); expect(server.listening).toBe(true);
  } finally {
    await submissions.close(); await bridge.stop();
    for(const client of wss.clients)client.terminate(); wss.close();
    await new Promise<void>(resolve=>server.close(()=>resolve())); await rm(root,{recursive:true,force:true});
  }
},15000);

async function alive(pid:number) {
  try {const info=await readFile(`/proc/${pid}/stat`,'utf8');return info.split(') ').at(-1)!.split(' ')[0]!=='Z';}
  catch(error:any){if(error.code==='ENOENT')return false;throw error;}
}

test('isolated native exit marks delivery unknown, cleans its descendants, restarts idle and never replays execution', async () => {
  const root = await mkdtemp('/tmp/crw-isolated-exit-'), bin=join(root,'bin'), pids=join(root,'pids.jsonl'), writes=join(root,'writes.jsonl');
  await mkdir(bin);
  const program = `#!${process.execPath}\nimport {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
    const child=spawn(process.execPath,['--eval','setInterval(()=>{},1000)'],{stdio:'inherit'});
    appendFileSync(${JSON.stringify(pids)},JSON.stringify({pid:process.pid,child:child.pid})+'\\n');
    for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);const send=r=>process.stdout.write(JSON.stringify({id:m.id,result:r})+'\\n');
      if(m.method==='initialize')send({codexHome:${JSON.stringify(root)}});
      if(m.method==='thread/read')send({thread:{id:'isolated-thread',turns:[],status:{type:'idle'}}});
      if(m.method==='turn/start')appendFileSync(${JSON.stringify(writes)},JSON.stringify(m)+'\\n');
      if(m.method==='fixture/exit')process.exit(23);
    }`;
  await writeFile(join(bin,'codex'),program,{mode:0o700});
  const originalPath=process.env.PATH; process.env.PATH=bin+delimiter+originalPath;
  let connected=false;
  const statuses:any[]=[];
  const bridge=createAppServerBridge({cwd:root,clientInfo:{name:'isolated-exit-fixture',version:'1'},connection:{mode:'isolated',socket:null},onHome:()=>{},onMessage:()=>{},onStatus:status=>{connected=status.status==='connected';statuses.push(status);}});
  const submissions=createSubmissionService({privateRoot:root,request:bridge.request,connected:()=>connected});
  const records=async()=>{try{return(await readFile(pids,'utf8')).trim().split('\n').map(JSON.parse);}catch{return[];}};
  bridge.start();
  try {
    await until(()=>connected);
    const submission={id:randomUUID(),method:'turn/start',params:{threadId:'isolated-thread',input:[{type:'text',text:'offline fixture'}]}};
    const sending=submissions.submit(submission);
    await until(async()=>{try{return(await readFile(writes,'utf8')).includes(submission.id);}catch{return false;}});
    const first=(await records())[0];
    await expect(bridge.request('fixture/exit')).rejects.toMatchObject({code:'RPC_DISCONNECTED'});
    expect((await sending).status).toBe('unknown');
    await until(async()=>!await alive(first.child));
    await until(()=>statuses.filter(status=>status.status==='connected').length===2);
    const snapshot=await bridge.request('thread/read',{threadId:'isolated-thread',includeTurns:true});
    expect(snapshot.thread.turns).toEqual([]); expect(snapshot.thread.status.type).toBe('idle');
    expect(statuses.some(status=>status.status==='disconnected'&&status.code===23)).toBe(true);
    expect((await submissions.submit(submission)).status).toBe('unknown');
    expect((await readFile(writes,'utf8')).trim().split('\n')).toHaveLength(1);
    await bridge.stop();
    for(const record of await records()) {await until(async()=>!await alive(record.pid));await until(async()=>!await alive(record.child));}
  } finally {
    await submissions.close();await bridge.stop();process.env.PATH=originalPath;
    // Only this test's recorded fixture descendants are eligible for cleanup.
    for(const record of await records())for(const pid of [record.pid,record.child])try{process.kill(pid,'SIGKILL');}catch{}
    await rm(root,{recursive:true,force:true});
  }
},15000);
