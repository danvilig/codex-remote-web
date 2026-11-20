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
import { command } from '../../scripts/distribution.ts';
import { root } from '../helpers/browser-runtime.mjs';
import { windowsIsolatedStartupTimeout } from '../../src/server/bridge/windows-isolated.js';

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
if (windows) env.CODEX_WEBUI_NODE = process.execPath;
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
  if(process.platform==='darwin') {
    // Inspect the real installed Electron window on each macOS version. All
    // projects/accounts are disposable fixtures; no personal sessions appear.
    await window.locator('#gatewayState').filter({hasText:'Stopped'}).waitFor();
    await window.screenshot({path:join(root,'.artifacts/macos-desktop-overview.png'),animations:'disabled'});
    await window.locator('[data-page=configuration]').click();
    await window.locator('#projectPath').waitFor();
    assert.equal(await window.locator('#projectPath').inputValue(),home);
    for(const theme of ['light','dark']) {
      await window.locator('#desktopTheme').selectOption(theme,{force:true});
      await window.waitForFunction(value=>document.documentElement.dataset.theme===value,theme);
      assert.equal(await window.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Native settings must not overflow horizontally');
      await window.screenshot({path:join(root,`.artifacts/macos-desktop-settings-${theme}.png`),animations:'disabled'});
    }
    await window.locator('#desktopTheme').selectOption('system',{force:true});
    await window.locator('[data-page=diagnostics]').click();
    await window.locator('#removeBackground').waitFor();
    await window.locator('[data-page=overview]').click();
    await window.locator('#start').waitFor();
  }
  // Capture actual native menus in the test process; no production debug API.
  await application.evaluate(({ Tray, dialog }) => {
    const original = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function(menu) { globalThis.__nativeTray = menu; return original.call(this, menu); };
    dialog.showMessageBox = async (...args) => { globalThis.__confirmation = args.at(-1); return { response: 0 }; };
  });
  await window.locator('[data-page=configuration]').click();
  for (const [language, expected, title] of [['zh', ['设置', '打开工作区', '启动网关', '停止网关', '退出托盘（网关继续运行）'], '网关设置'], ['en', ['Settings', 'Open workspace', 'Start gateway', 'Stop gateway', 'Quit tray (gateway continues)'], 'Gateway settings']]) {
    await window.locator('#desktopLanguage').selectOption(language, {force:true});
    await window.waitForFunction(value => document.querySelector('#pageTitle').textContent === value && !document.querySelector('#desktopLanguage').disabled, title);
    const menus = await application.evaluate(({ Menu }) => ({ tray: globalThis.__nativeTray?.items.filter(item => item.type !== 'separator').map(item => item.label), app: Menu.getApplicationMenu().items.map(item => item.label) }));
    if (process.platform === 'darwin') {
      assert.deepEqual(menus.tray, expected, 'Actual status-bar menu must match the selected language');
      assert.equal(menus.app[1], language === 'zh' ? '编辑' : 'Edit');
      // Inspect the actual status-bar Menu, without entering Cocoa's modal
      // popup tracking loop inside a synchronous CDP evaluation.
      console.log('Native tray menu:',language,JSON.stringify(menus.tray));
    }
    await window.locator('[data-page=diagnostics]').click();
    await window.locator('#removeBackground').click();
    const confirmation = await application.evaluate(() => globalThis.__confirmation);
    assert.deepEqual(confirmation.buttons, language === 'zh' ? ['取消', '移除'] : ['Cancel', 'Remove']);
    await window.locator('[data-page=configuration]').click();
  }
  await window.locator('[data-page=overview]').click();
  await window.locator('#start').click(); await window.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Running');
  const state = await agentRequest(directory, 'status'); assert.equal(state.local.phase, 'running');
  await window.locator('[data-page=configuration]').click();
  await window.locator('#desktopLanguage').selectOption('zh',{force:true});
  await window.waitForFunction(()=>document.documentElement.lang==='zh-CN'&&!document.querySelector('#desktopLanguage').disabled);
  assert.equal((await agentRequest(directory,'status')).local.pid,state.local.pid,'Native language change must preserve gateway PID');
  // Saved Chinese must survive quitting and reopening the native tray.
  // Running means the HTTP gateway is ready; its isolated native connection
  // initializes independently. Establish connectivity before testing whether
  // quitting the tray preserves it (including cold PowerShell compilation).
  console.error('Verifying native connection before tray exit');
  // Windows helper compilation has its own bounded startup phase before the
  // unchanged 30s initialize RPC budget. The immediate post-exit check below
  // still has no reconnect retry.
  const deadline = Date.now() + (windows ? windowsIsolatedStartupTimeout + 30000 : 30000);
  for (;;) {
    const health = await (await fetch(state.url + '/api/health', { signal: AbortSignal.timeout(10000) })).json();
    if (health.codex) break;
    assert.ok(Date.now() < deadline, 'Native fixture must connect before tray exit: ' + JSON.stringify((await agentRequest(directory, 'status')).events));
    await delay(100);
  }
  console.error('Verifying tray exit preserves gateway');
  await closeApplication();
  console.error('Verifying background control after tray exit');
  assert.equal((await agentRequest(directory, 'status')).local.pid, state.local.pid);
  console.error('Verifying gateway health after tray exit');
  assert.equal((await (await fetch(state.url + '/api/health', { signal: AbortSignal.timeout(10000) })).json()).codex, true);
  console.error('Verifying native desktop reconnect');
  application = await launch(); window = await application.firstWindow({ timeout: 30000 });
  await window.waitForFunction(() => document.querySelector('#gatewayState').textContent === '运行中');
  assert.equal(await application.evaluate(({Menu})=>Menu.getApplicationMenu().items[1].label),'编辑');
  await window.locator('[data-page=configuration]').click();
  await window.locator('#desktopLanguage').selectOption('en',{force:true});
  await window.waitForFunction(()=>document.documentElement.lang==='en'&&!document.querySelector('#desktopLanguage').disabled);
  await window.locator('[data-page=overview]').click();
  assert.equal((await agentRequest(directory, 'status')).local.pid, state.local.pid);
  console.error('Verifying native gateway stop');
  await window.locator('#stop').click(); await window.waitForFunction(() => document.querySelector('#gatewayState').textContent === 'Stopped');
  assert.equal((await agentRequest(directory, 'status')).local.pid, null);
  if (process.platform === 'darwin') {
    // Exercise confirmed cleanup only against this installed disposable copy.
    const dataPath = await application.evaluate(({app}) => app.getPath('userData'));
    const sentinel = join(home, '.codex', 'auth-preserved.txt');
    await mkdir(join(home,'.codex'),{recursive:true}); await writeFile(sentinel,'fixture account');
    await application.evaluate(({dialog}) => { dialog.showMessageBox = async () => ({response:1}); });
    await window.locator('[data-page=diagnostics]').click();
    await window.locator('#cleanUninstall').click();
    const child = application.process();
    for (let i=0; child.exitCode===null && i<200; i++) await delay(100);
    assert.equal(child.exitCode,0,'Clean uninstall must exit normally');
    assert.equal(await readFile(sentinel,'utf8'),'fixture account');
    assert.equal(await readFile(join(directory,'config.json'),'utf8').catch(error=>error.code),'ENOENT');
    assert.equal(await readFile(dataPath,'utf8').catch(error=>error.code),'ENOENT');
    assert.equal(await readFile(executable,'utf8').catch(error=>error.code),'ENOENT','Disposable .app must move to Trash');
  }
  console.log('PASS: real sandboxed desktop window, isolated preload, native gateway, tray-app exit independence, reconnect and stop');
} catch (error) {
  console.error('Native desktop failure:',error.stack || error);
  if (process.platform === 'darwin') await command(['screencapture','-x',join(root,'.artifacts/macos-desktop-failure.png')],root).catch(()=>{});
  console.error('Native Chromium log:',await readFile(env.ELECTRON_LOG_FILE,'utf8').catch(()=>'(unavailable)'));
  throw error;
} finally {
  console.error('Cleaning native desktop fixture');
  await closeApplication().catch(error=>console.error('Secondary cleanup failure:',error.message)); await agentRequest(directory, 'shutdown').catch(() => {});
  for (let i = 0; i < 100; i++) { try { await agentRequest(directory, 'status', undefined, { timeoutMs: 100 }); } catch { break; } await delay(50); }
  await rm(home, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
}
