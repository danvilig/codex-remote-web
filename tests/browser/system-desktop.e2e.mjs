import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { agentRequest } from '../../desktop/client.js';
import { writePrivate } from '../../src/server/desktop/private-store.js';
import { desktopConfig, desktopDirectory } from '../../src/shared/desktop-config.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const executable = process.env.CODEX_WEBUI_DESKTOP_EXECUTABLE;
assert.ok(executable && ['linux', 'win32'].includes(process.platform));
const windows = process.platform === 'win32';
const home = await mkdtemp(join(tmpdir(), 'crw-system-desktop-'));
const directory = desktopDirectory(home);
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local'), XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.data'), CODEX_HOME: join(home, '.codex'), CODEX_AUTH_PATH: join(home, 'auth.json') };
if (!windows) {
  env.GTK_A11Y = '1';
  env.WEBKIT_FORCE_ACCESSIBILITY = '1';
}
const command = promisify(execFile);
let child, output = '';

async function nativeControl(name, invoke = false) {
  assert.ok(child && child.exitCode === null && !child.signalCode, output);
  const driver = windows ? 'powershell.exe' : '/usr/bin/python3';
  const args = windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests/helpers/system-desktop-uia.ps1'), '-ProcessId', String(child.pid), '-Name', name, ...(invoke ? ['-Invoke'] : [])] : [join(root, 'tests/helpers/system-desktop-atspi.py'), String(child.pid), name, invoke ? 'invoke' : 'find'];
  try { await command(driver, args, { env, timeout: 5000 }); return true; }
  catch (error) { if (error.code === 2) return false; throw error; }
}

async function until(action, description, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await action()) return;
    await delay(250);
  }
  assert.fail(`${description} timed out. ${output}`);
}

function launch() {
  child = spawn(executable, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + String(chunk)).slice(-4000); });
}

async function close() {
  const current = child; child = null;
  if (current && current.exitCode === null && !current.signalCode) {
    const signal = AbortSignal.timeout(10_000);
    const exited = once(current, 'exit', { signal });
    current.kill('SIGTERM');
    await exited;
  }
  current?.stdout.destroy(); current?.stderr.destroy();
}

try {
  for (const folder of [env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME]) await mkdir(folder, { recursive: true, mode: 0o700 });
  const fixture = join(home, 'codex-fixture.mjs');
  const codex = join(home, windows ? 'codex.exe' : 'codex');
  await copyFile(join(root, 'tests/fixtures/codex'), fixture);
  if (windows) await command('bun', ['build', fixture, '--compile', '--outfile', codex], { timeout: 60_000 });
  else {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(codex, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
  }
  const port = await new Promise(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
  await writePrivate(join(directory, 'config.json'), desktopConfig({ initialized: true, enabled: false, autostart: false, cwd: home, codex, port, language: 'en' }, home));
  launch();
  await until(() => nativeControl('Start gateway', true), 'Starting the gateway from the installed WebView');
  const base = `http://127.0.0.1:${port}`;
  const connected = async () => (await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(3000) })).json()).codex === true;
  await until(() => connected().catch(() => false), 'Native Codex fixture connection');
  const status = await agentRequest(directory, 'status');
  assert.ok(status.local.pid > 0);
  await close();
  assert.equal((await agentRequest(directory, 'status')).local.pid, status.local.pid);
  assert.equal(await connected(), true);

  launch();
  await until(() => nativeControl('Stop gateway', true), 'Stopping the gateway from the reopened WebView');
  await until(async () => (await agentRequest(directory, 'status')).local.pid === null, 'Gateway stopped');
  await close();
  await command(executable, ['--uninstall-background'], { env, timeout: 30_000 });
  assert.ok((await readFile(join(directory, 'config.json'), 'utf8')).includes('initialized'));
  console.log('PASS: installed system WebView controls, gateway survival after window process exit, reopened controls, and background uninstall');
} finally {
  await close().catch(() => {});
  await agentRequest(directory, 'shutdown', undefined, { timeoutMs: 1500 }).catch(() => {});
  await rm(home, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
}
