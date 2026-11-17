import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const unix = process.platform === 'win32' ? test.skip : test;
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await Bun.sleep(25); }
}
async function alive(pid) {
  try {
    process.kill(pid, 0);
    // A terminated orphan may briefly await the container's init reaper.
    if (process.platform === 'linux' && /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error; }
}
async function fixture(run, missing = false, closePipes = false) {
  const home = await mkdtemp(join(tmpdir(), 'desktop-isolated-')), pids = join(home, 'pids');
  const bridgePath = resolve(import.meta.dir, '../../src/server/bridge/app-server.ts');
  const code = `import {createAppServerBridge} from ${JSON.stringify(bridgePath)};
    const bridge=createAppServerBridge({cwd:process.cwd(),clientInfo:{name:'fixture',version:'0'},connection:{mode:'isolated'},onMessage:()=>{},onStatus:s=>console.log(JSON.stringify(s)),onHome:()=>{}});
    const {createInterface}=await import('node:readline');
    createInterface({input:process.stdin}).on('line',async line=>{if(line==='stop'){await bridge.stop();process.exit(0)}else if(line==='crash')bridge.send({method:'fixture/crash'});});bridge.start();`;
  const child = spawn(process.execPath, ['--eval', code], { env: { ...process.env, HOME: home, CODEX_WEBUI_DESKTOP_CHILD: '1', CODEX_WEBUI_CODEX: missing ? join(home, 'missing-codex') : resolve(import.meta.dir, '../fixtures/desktop-isolated.mjs'), FIXTURE_PIDS: pids, FIXTURE_CLOSE_PIPES: closePipes ? '1' : '0' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', exited = false;
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; }); child.once('exit', () => { exited = true; });
  const records = async () => (await readFile(pids, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  try { await run({ child, records, output: () => output, errors: () => errors, exited: () => exited }); }
  finally {
    if (!exited) { child.kill('SIGKILL'); await until(() => exited, 'driver exit'); }
    const owned = await records();
    await until(async () => (await Promise.all(owned.map(async p => !await alive(p.tool) && !await alive(p.native)))).every(Boolean), 'fixture cleanup').catch(() => {});
    for (const p of owned) { try { process.kill(-p.group, 'SIGKILL'); } catch {} }
    await rm(home, { recursive: true, force: true });
  }
}
unix('isolated desktop stop reaps tools that retain pipes and ignore TERM', async () => fixture(async f => {
  await until(() => f.output().includes('connected'), 'initialize'); const [p] = await f.records();
  expect(await alive(p.tool)).toBe(true); f.child.stdin.write('stop\n');
  await until(f.exited, 'stop'); expect(await alive(p.native)).toBe(false); expect(await alive(p.tool)).toBe(false);
}), 20000);
unix('native exit reaps retained pipes and reconnects instead of waiting forever for close', async () => fixture(async f => {
  await until(() => f.output().includes('connected'), 'initialize'); const [p] = await f.records();
  f.child.stdin.write('crash\n');
  await until(async () => (await f.records()).length >= 2 && (f.output().match(/"status":"connected"/g) || []).length >= 2, 'reconnect');
  expect(await alive(p.native)).toBe(false); expect(await alive(p.tool)).toBe(false);
  f.child.stdin.write('stop\n'); await until(f.exited, 'stop');
}), 25000);
unix('gateway SIGKILL closes supervisor IPC and reaps the isolated native group', async () => fixture(async f => {
  await until(() => f.output().includes('connected'), 'initialize'); const [p] = await f.records();
  f.child.kill('SIGKILL'); await until(f.exited, 'gateway crash');
  await until(async () => !await alive(p.native) && !await alive(p.tool), 'orphan cleanup');
  expect(await alive(p.tool)).toBe(false);
}), 20000);
unix('missing isolated Codex reports disconnected and remains stoppable', async () => fixture(async f => {
  await until(() => f.output().includes('disconnected'), 'spawn failure').catch(error => { throw new Error(error.message + '\nstdout: ' + f.output() + '\nstderr: ' + f.errors()); });
  expect(f.exited()).toBe(false); f.child.stdin.write('stop\n'); await until(f.exited, 'stop after spawn failure');
}, true), 20000);

unix('gateway process-group SIGKILL also reaps tools that close their pipes', async () => fixture(async f => {
  await until(() => f.output().includes('connected'), 'initialize'); const [p] = await f.records();
  process.kill(-f.child.pid, 'SIGKILL'); await until(f.exited, 'gateway group crash');
  await until(async () => !await alive(p.native) && !await alive(p.tool), 'closed-pipe orphan cleanup');
  expect(await alive(p.tool)).toBe(false);
}, false, true), 20000);
