import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { appServerConnection } from '../../src/server/config/app-server.js';
import { createAppServerBridge, nativeRequestTimeout } from '../../src/server/bridge/app-server.ts';

test('connection selection waits for the shared daemon and derives paths from each user environment',()=>{
  const home=mkdtempSync('/tmp/crw-bridge-config-');
  try{
    const env={HOME:home},socket=join(home,'.codex/app-server-control/app-server-control.sock');
    expect(appServerConnection(env)).toEqual({mode:'shared',socket});
    expect(appServerConnection({...env,CODEX_WEBUI_APP_SERVER_MODE:'auto'})).toEqual({mode:'shared',socket});
    expect(appServerConnection({...env,CODEX_HOME:join(home,'custom-state')})).toEqual({mode:'shared',socket:join(home,'custom-state/app-server-control/app-server-control.sock')});
    expect(appServerConnection({})).toEqual({mode:'shared',socket:join(homedir(),'.codex/app-server-control/app-server-control.sock')});
    mkdirSync(join(home,'.codex/app-server-control'),{recursive:true});writeFileSync(socket,'fixture');
    expect(appServerConnection(env)).toEqual({mode:'shared',socket});
    expect(appServerConnection({...env,CODEX_WEBUI_APP_SERVER_MODE:'isolated'}).mode).toBe('isolated');
    expect(appServerConnection({...env,CODEX_WEBUI_APP_SERVER_MODE:'shared'}).mode).toBe('shared');
    expect(appServerConnection({...env,CODEX_WEBUI_APP_SERVER_SOCKET:join(home,'absent.sock')})).toEqual({mode:'shared',socket:join(home,'absent.sock')});
    expect(()=>appServerConnection({...env,CODEX_WEBUI_APP_SERVER_SOCKET:'ws://foreign.example/'})).toThrow('absolute local path');
    expect(()=>appServerConnection({...env,CODEX_WEBUI_APP_SERVER_MODE:'fallback'})).toThrow('MODE');
  }finally{rmSync(home,{recursive:true,force:true})}
});

test('shared bridge rejoins one server, forwards approval IDs, and closes only its own connection',async()=>{
  const home=mkdtempSync('/tmp/crw-shared-bridge-'),path=join(home,'native.sock');
  const server=createServer(),wss=new WebSocketServer({server}),messages:any[]=[],notifications:any[]=[],clients=new Set<WebSocket>();
  await new Promise<void>(resolve=>server.listen(path,resolve));
  wss.on('connection',ws=>{clients.add(ws);ws.on('close',()=>clients.delete(ws));ws.on('message',raw=>{
    const message=JSON.parse(String(raw));messages.push(message);
    if(message.method==='initialize')ws.send(JSON.stringify({id:message.id,result:{codexHome:home}}));
    if(message.method==='thread/resume')ws.send(JSON.stringify({id:message.id,result:{thread:{id:message.params.threadId,turns:[],canAcceptDirectInput:true}}}));
    if(message.method==='test/error')ws.send(JSON.stringify({id:message.id,error:{code:-32602,message:'fixture failure',data:{reason:'native fixture'}}}));
  });});
  function create(name:string){
    let ready:(value?:unknown)=>void;const connected=new Promise(resolve=>{ready=resolve});
    const bridge=createAppServerBridge({cwd:home,clientInfo:{name,version:'1'},connection:{mode:'shared',socket:path},onHome:()=>{},onStatus:s=>{if(s.status==='connected')ready()},onMessage:message=>notifications.push(message)});
    bridge.start();return {bridge,connected};
  }
  const a=create('desktop'),b=create('webui');
  try{
    await Promise.all([a.connected,b.connected]);
    const results=await Promise.all([a.bridge.request('thread/resume',{threadId:'same-thread'}),b.bridge.request('thread/resume',{threadId:'same-thread'})]);
    expect(results.map(r=>r.thread.id)).toEqual(['same-thread','same-thread']);
    await expect(b.bridge.request('test/error')).rejects.toThrow('fixture failure');
    await expect(b.bridge.request('test/error')).rejects.toMatchObject({ code: -32602, data: { reason: 'native fixture' }, nativeResponse: true });
    const approval={id:'approval-native-42',method:'item/commandExecution/requestApproval',params:{threadId:'same-thread'}};
    for(const client of clients)client.send(JSON.stringify(approval));
    await new Promise(resolve=>setTimeout(resolve,15));
    expect(notifications.filter(message=>message.id===approval.id).length).toBe(2);
    b.bridge.send({id:approval.id,result:{decision:'decline'}});
    await new Promise(resolve=>setTimeout(resolve,15));
    expect(messages.some(message=>message.id===approval.id&&message.result?.decision==='decline')).toBe(true);
    await b.bridge.stop();
    expect((await a.bridge.request('thread/resume',{threadId:'same-thread'})).thread.id).toBe('same-thread');
    expect(server.listening).toBe(true);
    expect(messages.some(message=>message.method==='turn/start')).toBe(false);
  }finally{
    await a.bridge.stop();await b.bridge.stop();
    for(const client of wss.clients)client.terminate();
    wss.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(home,{recursive:true,force:true});
  }
});

test('a gateway started before the daemon waits, reconnects, and never replays rejected input', async () => {
  const home = mkdtempSync('/tmp/crw-delayed-daemon-');
  const connection = appServerConnection({ CODEX_HOME: home });
  expect(connection.mode).toBe('shared'); // Fail before spawning anything on the old fallback behavior.
  mkdirSync(join(home, 'app-server-control'));
  const server = createServer(), wss = new WebSocketServer({ server });
  const messages: any[] = [];
  let connected!: () => void;
  const ready = new Promise<void>(resolve => { connected = resolve; });
  const bridge = createAppServerBridge({ cwd: home, connection, clientInfo: { name: 'late-daemon-fixture', version: '1' }, onHome: () => {}, onMessage: () => {}, onStatus: status => { if (status.status === 'connected') connected(); } });
  wss.on('connection', ws => ws.on('message', raw => {
    const message = JSON.parse(String(raw)); messages.push(message);
    if (message.id !== undefined) ws.send(JSON.stringify({ id: message.id, result: message.method === 'initialize' ? { codexHome: home } : { data: [] } }));
  }));
  let deadline;
  try {
    bridge.start();
    await expect(bridge.request('turn/start', { threadId: 'do-not-replay', input: [] })).rejects.toMatchObject({ code: 'RPC_NOT_SENT', dispatchState: 'not-sent' });
    await new Promise(resolve => setTimeout(resolve, 30));
    await new Promise<void>(resolve => server.listen(connection.socket!, resolve));
    await Promise.race([ready, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Delayed daemon was not joined')), 3500); })]);
    expect(await bridge.request('thread/loaded/list')).toEqual({ data: [] });
    expect(messages.some(message => message.method === 'turn/start')).toBe(false);
    await bridge.stop();
    expect(server.listening).toBe(true);
  } finally {
    clearTimeout(deadline); await bridge.stop();
    for (const client of wss.clients) client.terminate();
    wss.close(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test('native reads have the longer timeout, while late mutation responses retain their correlation', async () => {
  expect(nativeRequestTimeout('thread/read')).toBe(90000);
  expect(nativeRequestTimeout('turn/start')).toBe(30000);
  const home=mkdtempSync('/tmp/crw-bridge-timeouts-'),path=join(home,'native.sock');
  const server=createServer(),wss=new WebSocketServer({server});
  await new Promise<void>(resolve=>server.listen(path,resolve));
  wss.on('connection',ws=>ws.on('message',raw=>{
    const message=JSON.parse(String(raw));
    if(message.method==='initialize')ws.send(JSON.stringify({id:message.id,result:{}}));
    if(message.method==='thread/read')setTimeout(()=>ws.send(JSON.stringify({id:message.id,result:{thread:{id:'slow-read'}}})),45);
    if(message.method==='turn/start')setTimeout(()=>ws.send(JSON.stringify({id:message.id,result:{turn:{id:'late-turn'}}})),65);
  }));
  let ready!:()=>void;
  const connected=new Promise<void>(resolve=>{ready=resolve});
  const bridge=createAppServerBridge({cwd:home,clientInfo:{name:'fixture',version:'1'},connection:{mode:'shared',socket:path},requestTimeoutMs:method=>nativeRequestTimeout(method)/1000,onHome:()=>{},onMessage:()=>{},onStatus:status=>{if(status.status==='connected')ready()}});
  bridge.start();
  try {
    await connected;
    expect((await bridge.request('thread/read',{threadId:'slow-read'})).thread.id).toBe('slow-read');
    let resolveLate!:(value:any)=>void;
    const late=new Promise<any>(resolve=>{resolveLate=resolve});
    await expect(bridge.request('turn/start',{threadId:'t',input:[]},{onLateResponse:resolveLate})).rejects.toMatchObject({code:'RPC_TIMEOUT',dispatchState:'unknown'});
    expect(await late).toEqual({turn:{id:'late-turn'}});
  } finally {
    await bridge.stop();
    for(const client of wss.clients)client.terminate();
    wss.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(home,{recursive:true,force:true});
  }
});
