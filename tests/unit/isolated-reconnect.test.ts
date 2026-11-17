import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await Bun.sleep(20); }
}
async function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux' && /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error; }
}
for (const initDelay of [0, 2200]) (process.platform === 'win32' ? test.skip : test)(`old isolated close/output cannot invalidate a replacement (initialize delay ${initDelay} ms)`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'isolated-reconnect-')), pids = join(home, 'pids');
  const code = `import {createAppServerBridge} from ${JSON.stringify(resolve(import.meta.dir, '../../src/server/bridge/app-server.ts'))};
    const bridge=createAppServerBridge({cwd:process.cwd(),connection:{mode:'isolated'},clientInfo:{name:'fixture',version:'0'},onHome:()=>{},onMessage:m=>console.log(JSON.stringify({notification:m})),onStatus:s=>console.log(JSON.stringify(s))});
    const {createInterface}=await import('node:readline');createInterface({input:process.stdin}).on('line',async line=>{
      if(line==='crash')bridge.send({method:'fixture/crash'});
      if(line==='slow')try{console.log(JSON.stringify({result:await bridge.request('fixture/slow')}))}catch(error){console.log(JSON.stringify({error:error.code}))}
      if(line==='stop'){await bridge.stop();process.exit(0)}
    });bridge.start();`;
  const env = { ...process.env, HOME: home, CODEX_WEBUI_CODEX: resolve(import.meta.dir, '../fixtures/isolated-reconnect.mjs'), FIXTURE_PIDS: pids, FIXTURE_INIT_DELAY: String(initDelay) };
  delete env.CODEX_WEBUI_DESKTOP_CHILD;
  const driver = spawn(process.execPath, ['--eval', code], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', exited = false;
  driver.stdout.on('data', data => { output += data; }); driver.stderr.on('data', data => { errors += data; }); driver.once('exit', () => { exited = true; });
  const records = async () => (await readFile(pids, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  try {
    await until(() => output.includes('"status":"connected"'), 'first initialize');
    driver.stdin.write('crash\n'); await until(() => output.includes('"status":"disconnected"'), 'old server exit');
    driver.stdin.write('slow\n'); await until(() => output.includes('"result"') || output.includes('"error"'), 'replacement result');
    const [old, replacement] = await records();
    expect(output).not.toContain('"error"'); expect(output).toContain(`"pid":${replacement.native}`);
    expect(output).not.toContain('fixture/stale'); expect(errors).not.toContain('invalid app-server message'); expect(errors).not.toContain('initialize failed');
    const statuses = output.trim().split('\n').map(JSON.parse).filter(message => message.status).map(message => message.status);
    expect(statuses).toEqual(['connected', 'disconnected', 'connected']);
    expect(await alive(old.native)).toBe(false); expect(await alive(old.tool)).toBe(false); expect(await alive(replacement.native)).toBe(true);
    driver.stdin.write('stop\n'); await until(() => exited, 'stop'); expect(await alive(replacement.tool)).toBe(false);
  } finally {
    if (!exited) { driver.kill('SIGKILL'); await until(() => exited, 'driver cleanup'); }
    for (const p of await records()) { try { process.kill(-p.group, 'SIGKILL'); } catch {} }
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
