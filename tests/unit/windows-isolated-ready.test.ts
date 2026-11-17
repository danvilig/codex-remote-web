import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { waitForWindowsIsolatedReady } from '../../src/server/bridge/windows-isolated.js';

function helper() {
  const proc = Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null, signalCode: null });
  // Keep a pre-existing listener to prove cleanup only removes owned listeners.
  proc.on('error', () => {});
  return proc;
}
function expectClean(proc) {
  expect(proc.listenerCount('error')).toBe(1);
  expect(proc.listenerCount('exit')).toBe(0);
  expect(proc.listenerCount('close')).toBe(0);
  expect(proc.stderr.listenerCount('data')).toBe(0);
}

test('Windows helper startup waits beyond a normal RPC budget for the native marker', async () => {
  const proc = helper();
  let state = 'pending';
  const ready = waitForWindowsIsolatedReady(proc, { timeoutMs: 1000 }).then(() => { state = 'ready'; });
  proc.stderr.write('[codex-isolated:compile]\n');
  await Bun.sleep(60); // A mock ordinary RPC budget of 10ms has long expired.
  expect(state).toBe('pending');
  proc.stderr.write('[codex-isolated:native-wait]\n');
  await ready;
  expect(state).toBe('ready');
  expectClean(proc);
});

test('Windows helper startup accepts split exact lines and rejects embedded or oversized lookalikes', async () => {
  const proc = helper();
  let ready = false;
  const result = waitForWindowsIsolatedReady(proc, { timeoutMs: 1000 }).then(() => { ready = true; });
  proc.stderr.write('prefix[codex-isolated:native-wait]\n');
  proc.stderr.write('[codex-isolated:native-wait:0]\n');
  proc.stderr.write('x'.repeat(2 * 1024 * 1024) + '[codex-isolated:native-wait]\n');
  await Bun.sleep(1);
  expect(ready).toBe(false);
  proc.stderr.write('[codex-isolated:native-');
  proc.stderr.write('wait]\r');
  await Bun.sleep(1);
  expect(ready).toBe(false);
  proc.stderr.write('\n');
  await result;
  expect(ready).toBe(true);
  expectClean(proc);
});

test('Windows helper with no readiness marker has a bounded startup deadline', async () => {
  const proc = helper();
  const result = waitForWindowsIsolatedReady(proc, { timeoutMs: 30 });
  proc.stderr.write('[codex-isolated:compile]\n');
  await expect(result).rejects.toThrow('startup timed out');
  expectClean(proc);
});

for (const event of ['error', 'exit', 'close']) {
  test(`Windows helper ${event} before native readiness rejects and removes owned listeners`, async () => {
    const proc = helper();
    const result = waitForWindowsIsolatedReady(proc, { timeoutMs: 1000 });
    const rejection = result.catch(error => error);
    if (event === 'error') proc.emit(event, new Error('fixture spawn failure'));
    else proc.emit(event, 1, null);
    expect((await rejection).message).toContain(event === 'error' ? 'could not start' : 'exited before readiness');
    expectClean(proc);
  });
}

test('stale Windows helper lifecycle events cannot settle replacement readiness', async () => {
  const old = helper(), replacement = helper();
  const oldReady = waitForWindowsIsolatedReady(old, { timeoutMs: 1000 });
  const rejected = oldReady.catch(error => error);
  let state = 'pending';
  const newReady = waitForWindowsIsolatedReady(replacement, { timeoutMs: 1000 }).then(() => { state = 'ready'; });
  old.emit('exit', 1, null);
  expect((await rejected).message).toContain('exited before readiness');
  old.stderr.write('[codex-isolated:native-wait]\n'); old.emit('close', 1, null);
  await Bun.sleep(1);
  expect(state).toBe('pending');
  replacement.stderr.write('[codex-isolated:native-wait]\n');
  await newReady;
  expect(state).toBe('ready');
  expectClean(old); expectClean(replacement);
});

for (const earlyInitialize of [false, true]) {
(process.platform === 'win32' ? test.skip : test)(`Windows bridge startup has its own deadline with initialize reply ${earlyInitialize ? 'before' : 'after'} readiness`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'windows-bridge-ready-'));
  const system = join(home, 'Windows'), bin = join(system, 'System32/WindowsPowerShell/v1.0');
  const calls = join(home, 'methods.jsonl');
  try {
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'powershell.exe'), '#!' + Bun.which('node') + '\n' + `
      const {createInterface}=require('node:readline'),{appendFileSync}=require('node:fs');
      let ready=false;const queued=[];
      function reply(message){if(message.id!==undefined&&message.method!=='fixture/hang')process.stdout.write(JSON.stringify({id:message.id,result:message.method==='initialize'?{codexHome:'fixture'}:{ok:true}})+'\\n')}
      createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);appendFileSync(process.env.FIXTURE_METHODS,JSON.stringify(message.method)+'\\n');if(ready||(process.env.FIXTURE_EARLY_INITIALIZE==='1'&&message.method==='initialize'))reply(message);else queued.push(message)});
      process.stderr.write('[codex-isolated:compile]\\n');
      setTimeout(()=>{ready=true;process.stderr.write('[codex-isolated:native-wait]\\n');setTimeout(()=>queued.splice(0).forEach(reply),5)},150);
    `, { mode: 0o700 });
    const driver = `
      const {createAppServerBridge}=await import(${JSON.stringify(resolve(import.meta.dir, '../../src/server/bridge/app-server.ts'))});
      Object.defineProperty(process,'platform',{value:'win32'});
      let connected;const connection=new Promise(resolve=>{connected=resolve});
      const bridge=createAppServerBridge({cwd:process.cwd(),clientInfo:{name:'fixture',version:'0'},connection:{mode:'isolated'},requestTimeoutMs:()=>20,onMessage:()=>{},onHome:()=>{},onStatus:status=>{if(status.status==='connected')connected()}});
      let deadline;
      try {
        bridge.start();
        let earlyRequest,earlySend;
        try{await bridge.request('fixture/early')}catch(error){earlyRequest={code:error.code,dispatchState:error.dispatchState}}
        try{bridge.send({method:'fixture/early-send'})}catch(error){earlySend={code:error.code,dispatchState:error.dispatchState}}
        await Promise.race([connection,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('connection deadline')),3000)})]);clearTimeout(deadline);
        const echo=await bridge.request('fixture/echo');
        let timeout;try{await bridge.request('fixture/hang')}catch(error){timeout=error.code}
        console.log(JSON.stringify({earlyRequest,earlySend,echo,timeout}));
      } finally {clearTimeout(deadline);await bridge.stop()}
    `;
    const child = Bun.spawn([process.execPath, '--eval', driver], {
      env: { ...process.env, SystemRoot: system, FIXTURE_METHODS: calls, FIXTURE_EARLY_INITIALIZE: earlyInitialize ? '1' : '0', CODEX_WEBUI_CODEX: join(home, 'fixture-native.exe') },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, error: exit ? stderr : '' }).toEqual({ exit: 0, error: '' });
    expect(JSON.parse(stdout.trim())).toEqual({
      earlyRequest: { code: 'RPC_NOT_SENT', dispatchState: 'not-sent' },
      earlySend: { code: 'RPC_NOT_SENT', dispatchState: 'not-sent' },
      echo: { ok: true }, timeout: 'RPC_TIMEOUT',
    });
    expect((await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse)).toEqual(['initialize', 'initialized', 'fixture/echo', 'fixture/hang']);
  } finally { await rm(home, { recursive: true, force: true }); }
}, 10000);
}
