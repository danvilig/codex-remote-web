import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
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
  await writeFile(codex, `#!/bin/sh\nexec ${quote(Bun.which('node'))} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
}
await writePrivate(join(directory, 'config.json'), desktopConfig({ initialized: true, enabled: false, autostart: false, cwd: home, codex, port, language: 'en' }, home));
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), CODEX_AUTH_PATH: join(home, 'auth.json'), XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'), CODEX_DESKTOP_BUN: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
let application;
const launch = () => electron.launch({ executablePath: executable, args: process.env.CODEX_WEBUI_DESKTOP_MAIN ? [process.env.CODEX_WEBUI_DESKTOP_MAIN] : [], chromiumSandbox: true, env, timeout: 60000 });
try {
  application = await launch(); let window = await application.firstWindow({ timeout: 30000 });
  await window.locator('#start').waitFor(); await window.waitForFunction(() => document.querySelector('#start').disabled === false);
  assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
  const webPreferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(webPreferences.sandbox, true); assert.equal(webPreferences.contextIsolation, true); assert.equal(webPreferences.nodeIntegration, false);
  await window.locator('#start').click(); await window.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Running');
  const state = await agentRequest(directory, 'status'); assert.equal(state.local.phase, 'running');
  await application.close(); application = null;
  assert.equal((await agentRequest(directory, 'status')).local.pid, state.local.pid);
  assert.equal((await (await fetch(state.url + '/api/health')).json()).codex, true);
  application = await launch(); window = await application.firstWindow({ timeout: 30000 });
  await window.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Running');
  assert.equal((await agentRequest(directory, 'status')).local.pid, state.local.pid);
  await window.locator('#stop').click(); await window.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Stopped');
  assert.equal((await agentRequest(directory, 'status')).local.pid, null);
  console.log('PASS: real sandboxed desktop window, isolated preload, native gateway, tray-app exit independence, reconnect and stop');
} finally {
  await application?.close(); await agentRequest(directory, 'shutdown').catch(() => {});
  for (let i = 0; i < 100; i++) { try { await agentRequest(directory, 'status', undefined, { timeoutMs: 100 }); } catch { break; } await Bun.sleep(50); }
  await rm(home, { recursive: true, force: true });
}
