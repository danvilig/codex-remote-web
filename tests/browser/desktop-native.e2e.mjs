import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { desktopConfig, desktopDirectory } from '../../src/shared/desktop-config.js';
import { writePrivate } from '../../src/server/desktop/private-store.js';
import { agentRequest } from '../../desktop/client.js';
import { root } from '../helpers/browser-runtime.mjs';

const executable = process.env.CODEX_WEBUI_DESKTOP_EXECUTABLE;
assert.ok(executable, 'Test an actual desktop executable');
const home = await mkdtemp(join(tmpdir(), 'desktop-native-')), directory = desktopDirectory(home);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
const windows = process.platform === 'win32';
const fixture = join(home, 'codex-fixture.mjs'); await cp(join(root, 'tests/fixtures/codex'), fixture);
let codex;
if (windows) {
  const entry = join(home, 'node_modules/@openai/codex/bin'); await mkdir(entry, { recursive: true }); await cp(fixture, join(entry, 'codex.js')); await writeFile(join(entry, '../package.json'), '{"type":"module"}');
  codex = join(home, 'codex.cmd'); await writeFile(codex, '@echo off\r\nexit /b 91\r\n');
} else {
  codex = join(home, 'codex'); const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(codex, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
}
await writePrivate(join(directory, 'config.json'), desktopConfig({ initialized: true, enabled: false, autostart: false, cwd: home, codex, port, language: 'en' }, home));
const env = { ...process.env, PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), CODEX_AUTH_PATH: join(home, 'auth.json'), XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'), CODEX_DESKTOP_BUN: process.env.CODEX_DESKTOP_BUN || 'bun', ELECTRON_ENABLE_LOGGING: '1', ELECTRON_LOG_FILE: join(home, 'electron.log') };
for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
// Windows known-folder lookup requires the substituted profile directories to
// exist before Electron asks for userData. These belong only to this fixture.
for (const path of [env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]) await mkdir(path, { recursive: true, mode: 0o700 });
let application;
async function closeApplication() {
  const current = application; application = null;
  if (!current) return;
  // ChildProcess 'close' waits for inherited automation pipes, even after the
  // tray process exits. The independent background process may retain them.
  // Close the test's readers only after real OS process exit. The OS exit and
  // code are authoritative; Playwright's context-close promise can outlive its
  // already-disposed Electron dispatcher when the gateway stays independent.
  const child = current.process();
  const releasePipes = () => { for (const stream of child.stdio) stream?.destroy?.(); };
  child.once('exit', releasePipes);
  if (child.exitCode !== null) releasePipes();
  let timer;
  try {
    const exited = child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
    void current.close().catch(() => {});
    await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native desktop quit timed out')), 20000); })]);
    assert.equal(child.exitCode, 0, 'The tray process must exit normally');
  } catch (error) {
    console.error('Native desktop exit state:', { exitCode: child.exitCode, signalCode: child.signalCode });
    child.kill(); throw error;
  } finally { clearTimeout(timer); child.off('exit', releasePipes); }
}
const launch = async () => {
  const args = process.env.CODEX_WEBUI_DESKTOP_MAIN ? [process.env.CODEX_WEBUI_DESKTOP_MAIN] : [];
  try { return await electron.launch({ executablePath: executable, args, chromiumSandbox: true, env, timeout: 60000 }); }
  catch (error) {
    console.error('Electron launch diagnostics:', await readFile(env.ELECTRON_LOG_FILE, 'utf8').catch(() => '(no Chromium log)'));
    throw error;
  }
};
try {
  console.error('Verifying native desktop launch');
  application = await launch(); let window = await application.firstWindow({ timeout: 30000 });
  await window.locator('#start').waitFor(); await window.waitForFunction(() => document.querySelector('#start').disabled === false);
  assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
  const webPreferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(webPreferences.sandbox, true); assert.equal(webPreferences.contextIsolation, true); assert.equal(webPreferences.nodeIntegration, false);
  await window.locator('#start').click(); await window.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Running');
  const state = await agentRequest(directory, 'status'); assert.equal(state.local.phase, 'running');
  console.error('Verifying tray exit preserves gateway');
  await closeApplication();
  console.error('Verifying background control after tray exit');
  assert.equal((await agentRequest(directory, 'status')).local.pid, state.local.pid);
  console.error('Verifying gateway health after tray exit');
  assert.equal((await (await fetch(state.url + '/api/health', { signal: AbortSignal.timeout(10000) })).json()).codex, true);
  console.error('Verifying native desktop reconnect');
  application = await launch(); window = await application.firstWindow({ timeout: 30000 });
  await window.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Running');
  assert.equal((await agentRequest(directory, 'status')).local.pid, state.local.pid);
  console.error('Verifying native gateway stop');
  await window.locator('#stop').click(); await window.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Stopped');
  assert.equal((await agentRequest(directory, 'status')).local.pid, null);
  console.log('PASS: real sandboxed desktop window, isolated preload, native gateway, tray-app exit independence, reconnect and stop');
} finally {
  console.error('Cleaning native desktop fixture');
  await closeApplication(); await agentRequest(directory, 'shutdown').catch(() => {});
  for (let i = 0; i < 100; i++) { try { await agentRequest(directory, 'status', undefined, { timeoutMs: 100 }); } catch { break; } await delay(50); }
  await rm(home, { recursive: true, force: true });
}
