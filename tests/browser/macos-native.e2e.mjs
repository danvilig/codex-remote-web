import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, cp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { desktopConfig, desktopDirectory } from '../../src/shared/desktop-config.js';
import { writePrivate } from '../../src/server/desktop/private-store.js';
import { agentRequest } from '../../desktop/client.js';
// This harness runs under pinned Node; avoid Bun-only build helpers here.
async function command(args, cwd, { timeoutMs = 60000 } = {}) {
  const { stdout } = await promisify(execFile)(args[0], args.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}
import { root } from '../helpers/browser-runtime.mjs';

assert.equal(process.platform, 'darwin');
const executable = process.env.CODEX_WEBUI_DESKTOP_EXECUTABLE;
assert.ok(executable);
const home = await mkdtemp(join(tmpdir(), 'macos-native-')), directory = desktopDirectory(home);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
const fixture = join(home, 'codex-fixture.mjs'), codex = join(home, 'codex');
await cp(join(root, 'tests/fixtures/codex'), fixture);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
await writeFile(codex, `#!/bin/sh\nif [ "\${1-}" = "--version" ]; then printf 'codex-fixture 0.1\\n'; exit 0; fi\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
await writePrivate(join(directory, 'config.json'), desktopConfig({ initialized: true, enabled: false, autostart: false, cwd: home, codex, port, language: 'en' }, home));
const driver = join(home, 'NativeTestDriver.dylib');
await command(['xcrun', 'clang', '-dynamiclib', '-fobjc-arc', '-framework', 'AppKit', '-framework', 'WebKit', '-mmacosx-version-min=15.0', join(root, 'tests/helpers/macos-native-driver.m'), '-o', driver], root, { stream: true, timeoutMs: 60000 });
const env = { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), CODEX_AUTH_PATH: join(home, 'auth.json'), DYLD_INSERT_LIBRARIES: driver };
let application;
async function launch() {
  const child = spawn(executable, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  const pending = new Map(); let sequence = 0, logs = '';
  child.stderr.on('data', chunk => { logs += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let reply; try { reply = JSON.parse(line); } catch { return; }
    const entry = pending.get(reply.id); if (!entry) return;
    pending.delete(reply.id); clearTimeout(entry.timer);
    if (reply.error) entry.reject(new Error(reply.error)); else entry.resolve(reply.value);
  });
  child.on('error', error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); });
  child.on('exit', code => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`Native app exited ${code}: ${logs}`)); } pending.clear(); });
  const request = (action, extra = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native request timed out: ${action}; ${logs}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, action, ...extra }) + '\n');
  });
  const evaluate = script => request('evaluate', { script });
  const app = { child, request, evaluate, logs: () => logs };
  application = app;
  await waitFor(async () => evaluate("return Boolean(document.querySelector('#localAddress')?.textContent.startsWith('http://'))"), 'rendered native window');
  return app;
}
async function waitFor(probe, label) {
  const deadline = Date.now() + 45000;
  let last;
  while (Date.now() < deadline) {
    try { const result = await probe(); if (result) return result; } catch (error) { last = error; }
    assert.ok(!application || application.child.exitCode === null, `Native app exited while waiting for ${label}: ${application?.logs()}`);
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}: ${last?.message || application?.logs()}`);
}
const evaluate = script => application.evaluate(script);
async function click(selector) {
  // Match real interaction: wait for the asynchronously refreshed UI to
  // enable the control, then dispatch its click through the actual DOM.
  await waitFor(() => evaluate(`const node = document.querySelector(${JSON.stringify(selector)}); return Boolean(node && !node.disabled)`), `enabled ${selector}`);
  return evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); return true`);
}
const select = (selector, value) => evaluate(`const node = document.querySelector(${JSON.stringify(selector)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('change', {bubbles:true})); return true`);
const ready = () => evaluate("return !document.querySelector('#desktopLanguage').disabled && !document.querySelector('[aria-busy=true]')");
async function closeApplication() {
  if (!application) return;
  const current = application;
  await current.request('quit');
  await waitFor(() => current.child.exitCode !== null, 'real tray exit');
  assert.equal(current.child.exitCode, 0);
  current.child.stdin.destroy(); application = null;
}
const menus = [];
try {
  await launch();
  assert.deepEqual(await application.request('security'), { persistent: false, url: 'crw-desktop://settings/index.html', inspectable: false });
  assert.deepEqual(await evaluate("return [typeof window.require, typeof window.process, typeof window.Bun]"), ['undefined', 'undefined', 'undefined']);
  assert.equal((await evaluate("return await window.desktop.invoke('prepare')")).ok, false, 'Renderer cannot call host-only operations');
  assert.equal((await evaluate("return await window.desktop.invoke('cleanup-desktop', {directory:'/tmp'})")).ok, false);
  assert.equal((await evaluate("return await window.desktop.invoke('status', {padding:'a'.repeat(17000)}).then(()=>false,()=>true)")).valueOf(), true, 'Oversize messages are rejected before helper invocation');
  const secretRead = await evaluate("try { await import('crw-desktop://settings/../gateway/runtime/RUNTIMES.json'); return true } catch { return false }");
  assert.equal(secretRead, false, 'Custom scheme cannot expose the gateway tree');
  await application.request('snapshot', { path: join(root, '.artifacts/macos-desktop-overview.png') });
  // A WebKit snapshot alone can succeed while its remote layer is missing
  // from the visible native window. Also inspect the real screen composite.
  const geometry = await application.request('geometry');
  const onscreen = join(root, '.artifacts/macos-desktop-onscreen.png');
  await delay(500); await command(['screencapture', '-x', onscreen], root);
  const pixels = Number(await command(['swift', '-e', `import AppKit
    let bitmap = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))!
    let scale = Double(bitmap.pixelsWide) / Double(CommandLine.arguments[4])!
    let left = Double(CommandLine.arguments[2])!, top = Double(CommandLine.arguments[3])!
    var count = 0
    for y in Int((top + 90) * scale)..<Int((top + 300) * scale) {
      for x in Int((left + 20) * scale)..<Int((left + 200) * scale) {
        if let color = bitmap.colorAt(x:x,y:y)?.usingColorSpace(.deviceRGB), max(color.redComponent,color.greenComponent,color.blueComponent) < 0.65 { count += 1 }
      }
    }
    print(count)
  `, onscreen, String(geometry.left), String(geometry.top), String(geometry.screenWidth)], root));
  for (const mode of ['close', 'minimize']) {
    await application.request('window', {mode});
    await waitFor(async () => {
      const state = await application.request('window');
      return mode === 'close' ? !state.visible : state.minimized;
    }, `${mode} main window`);
    assert.equal(await application.request('window', {mode:'reopen'}), true, 'Launch Services must reopen the existing GUI process');
    await waitFor(async () => {
      const state = await application.request('window');
      return state.visible && !state.minimized;
    }, `restore ${mode} window`);
  }
  const runningApps = await application.request('runningApps');
  assert.deepEqual(runningApps.foreground, [application.child.pid]);
  assert.ok(runningApps.backgroundPolicies.every(policy => policy === 2), 'Background helper must not appear in the Dock');
  await click('[data-page=configuration]');
  assert.equal(await evaluate("return document.querySelector('#projectPath').value"), home);
  for (const theme of ['light', 'dark']) {
    await select('#desktopTheme', theme);
    await waitFor(() => evaluate(`return document.documentElement.dataset.theme === '${theme}'`), theme);
    assert.equal(await evaluate('return document.documentElement.scrollWidth <= innerWidth'), true);
    await application.request('snapshot', { path: join(root, `.artifacts/macos-desktop-settings-${theme}.png`) });
  }
  await select('#desktopTheme', 'system');
  for (const [language, expected, title] of [['zh', ['显示主窗口', '打开工作区', '启动网关', '停止网关', '重启网关', '退出应用（网关继续运行）'], '网关设置'], ['en', ['Show main window', 'Open workspace', 'Start gateway', 'Stop gateway', 'Restart gateway', 'Quit App (gateway keeps running)'], 'Gateway settings']]) {
    await select('#desktopLanguage', language);
    await waitFor(async () => await ready() && await evaluate(`return document.querySelector('#pageTitle').textContent === ${JSON.stringify(title)}`), language + ' rendered language');
    const native = await application.request('menus');
    assert.deepEqual(native.tray, expected);
    assert.deepEqual(native.app, language === 'zh' ? ['Codex Remote Web', '编辑', '显示', '网关', '窗口', '帮助'] : ['Codex Remote Web', 'Edit', 'View', 'Gateway', 'Window', 'Help']);
    assert.ok(native.commands['Codex Remote Web'].includes(language === 'zh' ? '设置…' : 'Settings…'));
    assert.deepEqual(native.commands[language === 'zh' ? '网关' : 'Gateway'], expected.slice(1, 5));
    menus.push({ language, ...native });
    await click('[data-page=diagnostics]'); await click('#removeBackground');
    await waitFor(async () => (await application.request('confirmation'))?.buttons?.[0] === (language === 'zh' ? '取消' : 'Cancel'), 'localized native confirmation');
    assert.deepEqual((await application.request('confirmation')).buttons, language === 'zh' ? ['取消', '移除'] : ['Cancel', 'Remove']);
    await waitFor(ready, 'cancel completes'); await click('[data-page=configuration]');
  }
  // Save through the real renderer/host transaction; this also checks the
  // native shell uses the same config validation and registration rollback.
  const dependencies = await evaluate("return await window.desktop.invoke('dependencies')");
  assert.equal(dependencies.ok, true, JSON.stringify(dependencies)); assert.ok(dependencies.value.find(item=>item.name==='codex')?.ok, JSON.stringify(dependencies.value));
  assert.ok(dependencies.value.find(item=>item.name==='git')?.ok, JSON.stringify(dependencies.value));
  await waitFor(() => evaluate("return !document.querySelector('#save').disabled"), 'configuration becomes editable');
  await click('#save');
  await waitFor(async () => (await agentRequest(directory, 'status')).events.some(item => item.event === 'configuration-saved'), 'native config save');
  await waitFor(ready, 'config reply');
  await click('[data-page=overview]'); await click('#start');
  await waitFor(async () => (await agentRequest(directory, 'status')).local.phase === 'running', 'gateway ready');
  const state = await agentRequest(directory, 'status');
  await click('[data-page=configuration]'); await select('#desktopLanguage', 'zh');
  await waitFor(async () => await ready() && await evaluate("return document.documentElement.lang === 'zh-CN'"), 'Chinese while running');
  assert.equal((await agentRequest(directory, 'status')).local.pid, state.local.pid);
  await waitFor(async () => (await (await fetch(state.url + '/api/health')).json()).codex, 'fixture native connection');
  await closeApplication();
  assert.equal((await agentRequest(directory, 'status')).local.pid, state.local.pid);
  assert.equal((await (await fetch(state.url + '/api/health')).json()).codex, true);
  await launch();
  await waitFor(() => evaluate("return document.querySelector('#gatewayState').textContent === '运行中'"), 'reconnect and persisted Chinese');
  assert.equal((await application.request('menus')).app[1], '编辑');
  await click('[data-page=configuration]'); await select('#desktopLanguage', 'en');
  await waitFor(async () => await ready() && await evaluate("return document.documentElement.lang === 'en'"), 'English while running');
  assert.equal((await agentRequest(directory, 'status')).local.pid, state.local.pid);
  await click('[data-page=overview]'); await click('#stop');
  await waitFor(async () => (await agentRequest(directory, 'status')).local.pid === null, 'native stop');
  await waitFor(ready, 'stop reply');
  const sentinel = join(home, '.codex/account-preserved.txt'); await mkdir(join(home, '.codex'), { recursive: true }); await writeFile(sentinel, 'fixture account');
  const legacy = join(home, 'Library/Application Support/Codex Remote Web'); await mkdir(legacy, { recursive: true }); await writeFile(join(legacy, 'old-cache'), 'fixture');
  await application.request('confirmation', { response: true });
  await click('[data-page=diagnostics]'); await click('#cleanUninstall');
  await waitFor(() => application.child.exitCode !== null, 'clean uninstall');
  assert.equal(application.child.exitCode, 0); application = null;
  assert.equal(await readFile(sentinel, 'utf8'), 'fixture account');
  await assert.rejects(access(join(directory, 'config.json')));
  await assert.rejects(access(join(directory, 'agent.json')));
  await assert.rejects(access(legacy));
  await assert.rejects(access(executable), 'Disposable application moves to Trash');
  await writeFile(join(root, '.artifacts/macos-native-menus.json'), JSON.stringify(menus, null, 2) + '\n');
  await writeFile(join(root, '.artifacts/macos-desktop-lifecycle.json'), JSON.stringify({ ...runningApps, closeAndMinimizeReopen: true, quitWithGatewayContinuity: true, relaunchAndCleanUninstall: true, sidebarInkPixels: pixels }, null, 2) + '\n');
  assert.ok(pixels > 100, `Visible native window lost its WebKit composite: ${pixels} sidebar ink pixels`);
  console.log('PASS: actual native WKWebView UI, restricted asset/bridge access, native menus/dialogs, saved settings/language, gateway continuity and clean uninstall');
} catch (error) {
  console.error('Native application diagnostics:', application?.logs());
  if (application) {
    console.error('Native rendered failure state:', await evaluate(`return {url:location.href,title:document.title,text:document.querySelector('#message')?.textContent,saveDisabled:document.querySelector('#save')?.disabled,invalid:[...document.querySelectorAll(':invalid')].map(n=>({id:n.id,value:n.value})),busy:[...document.querySelectorAll('[aria-busy]')].map(n=>({id:n.id,value:n.getAttribute('aria-busy')})),form:document.querySelector('#configuration')?.checkValidity()}`).catch(error=>error.message));
    await application.request('snapshot', {path:join(root,'.artifacts/macos-desktop-failure-webkit.png')}).catch(()=>{});
  }
  await command(['screencapture', '-x', join(root, '.artifacts/macos-desktop-failure.png')], root).catch(() => {});
  throw error;
} finally {
  await closeApplication().catch(() => { application?.child.kill(); });
  await agentRequest(directory, 'shutdown').catch(() => {});
  for (let i = 0; i < 100; i++) { try { await agentRequest(directory, 'status', undefined, { timeoutMs: 100 }); } catch { break; } await delay(100); }
  await rm(home, { recursive: true, force: true });
}
