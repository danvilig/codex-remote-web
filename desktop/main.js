import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, powerMonitor } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktopDirectory } from '../src/shared/desktop-config.js';
import { agentRequest } from './client.js';
import { privateDirectory, readPrivate } from '../src/server/desktop/private-store.js';
import { configureSession } from './session.js';

const background = process.argv.includes('--background-agent');
const uninstall = process.argv.includes('--uninstall-background');
const trace = message => { if (process.argv.some(value => value.startsWith('--inspect'))) console.error('[desktop] ' + message); };
trace('bootstrap');
const here = app.getAppPath();
const directory = desktopDirectory();
const root = app.isPackaged ? join(process.resourcesPath, 'gateway') : resolve(here, '../..');
const launchArgs = app.isPackaged ? [] : [join(here, 'main.cjs')];
// Independent locks: quitting the tray must never terminate the agent.
const userData = join(app.getPath('userData'), background ? 'background' : 'desktop');
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath('userData', userData);
trace('private application path selected');
const ownsLock = app.requestSingleInstanceLock({ uninstall, executable: process.execPath });
trace('instance lock checked');
if (!ownsLock && !uninstall) app.quit();
else {
  let window, tray, quitting = false, backgroundChild, sessionWindow;
  const pageURL = pathToFileURL(join(here, 'index.html')).href;
  const sessionOptions = { executable: process.execPath, args: launchArgs, directory };
  async function ensureAgent() {
    try { await agentRequest(directory, 'status', undefined, { timeoutMs: 1000 }); return; } catch {}
    const child = spawn(process.execPath, [...launchArgs, '--background-agent'], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await agentRequest(directory, 'status', undefined, { timeoutMs: 500 }); return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Background agent could not start. Check installation and private directory permissions.');
  }
  async function openWindow() {
    if (window) { window.show(); window.focus(); return; }
    window = new BrowserWindow({ width: 1100, height: 800, minWidth: 660, minHeight: 540, title: 'Codex Remote Web', show: false, webPreferences: { preload: join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.webContents.on('will-navigate', (event, url) => { if (url !== pageURL) event.preventDefault(); });
    window.webContents.setWindowOpenHandler(({ url }) => { void external(url); return { action: 'deny' }; });
    window.on('close', event => { if (!quitting && tray) { event.preventDefault(); window.hide(); } else if (!quitting && process.platform === 'linux') { event.preventDefault(); window.minimize(); } });
    window.on('closed', () => { window = null; });
    window.once('ready-to-show', () => window.show());
    await window.loadURL(pageURL);
  }
  async function external(value) {
    try { const url = new URL(value); if (!url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))) await shell.openExternal(url.href); } catch {}
  }
  async function operation(action, body) {
    if (action === 'chooseDirectory' || action === 'chooseCodex' || action === 'chooseCloudflared') {
      const result = await dialog.showOpenDialog(window, { properties: [action === 'chooseDirectory' ? 'openDirectory' : 'openFile'] });
      return result.canceled ? null : result.filePaths[0];
    }
    if (action === 'openWorkspace') { const state = await agentRequest(directory, 'status'); await external(state.url); return; }
    if (action === 'removeBackground') {
      const confirm = await dialog.showMessageBox(window, { type: 'question', message: 'Stop and remove the background component? / 停止并移除后台组件？', detail: 'Your projects, credentials and remote deployment records will be preserved. / 项目、凭据与远程部署记录将保留。', buttons: ['Cancel / 取消', 'Remove / 移除'], cancelId: 0, defaultId: 0 });
      if (confirm.response !== 1) return;
      await agentRequest(directory, 'stop'); await configureSession(false, sessionOptions); await agentRequest(directory, 'shutdown'); return;
    }
    if (!['status', 'dependencies', 'config', 'start', 'stop', 'restart', 'setup'].includes(action)) throw new Error('Unsupported desktop operation');
    if (action === 'config') {
      // Reject invalid settings before touching the user's login registration.
      await agentRequest(directory, 'validateConfig', body);
      const restore = await configureSession(body.autostart, sessionOptions);
      try { return await agentRequest(directory, action, body); }
      catch (error) { await restore(); throw error; }
    }
    return agentRequest(directory, action, body);
  }
  app.on('second-instance', (_event, argv, _cwd, data) => { if (data?.uninstall) { if (data.executable === process.execPath) { quitting = true; app.quit(); } } else if (!background) { if (argv.includes('--open-workspace')) void operation('openWorkspace').catch(() => {}); else void openWindow(); } });
  app.on('activate', () => { if (!background) void openWindow(); });
  app.on('window-all-closed', () => { if (!background && !tray && !quitting) app.quit(); });
  app.on('before-quit', event => {
    quitting = true;
    if (backgroundChild?.connected) { event.preventDefault(); backgroundChild.disconnect(); setTimeout(() => app.exit(0), 12000).unref(); }
  });
  void app.whenReady().then(async () => {
  trace('native application ready');
  if (uninstall) {
    try {
      const registration = await readPrivate(join(directory, 'session.json'));
      const descriptor = await readPrivate(join(directory, 'agent.json'));
      if (registration?.executable === process.execPath || descriptor?.installation === process.execPath) {
        await agentRequest(directory, 'stop').catch(() => {});
        if (registration?.executable === process.execPath) await configureSession(false, sessionOptions);
        await agentRequest(directory, 'shutdown').catch(() => {});
      }
      app.exit(0);
    } catch { app.exit(1); }
  } else if (background) {
    await privateDirectory(directory);
    if (process.platform === 'darwin') app.dock?.hide();
    const command = app.isPackaged ? [join(root, process.platform === 'win32' ? 'codex-remote-web.exe' : 'codex-remote-web'), 'agent'] : [process.env.CODEX_DESKTOP_BUN || 'bun', 'run', join(root, 'src/server/cli.ts'), 'agent'];
    backgroundChild = spawn(command[0], command.slice(1), { cwd: root, env: { ...process.env, CODEX_WEBUI_DESKTOP_INSTALLATION: process.execPath }, windowsHide: true, serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    backgroundChild.once('error', () => app.exit(1)); backgroundChild.once('exit', code => app.exit(code || 0));
    powerMonitor.on('shutdown', () => { backgroundChild?.disconnect(); });
    // A hidden native window receives Windows logoff/session-end messages.
    if (process.platform === 'win32') { sessionWindow = new BrowserWindow({ show: false, skipTaskbar: true, webPreferences: { sandbox: true } }); sessionWindow.on('session-end', () => { backgroundChild?.disconnect(); }); }
  } else {
    await privateDirectory(directory);
    ipcMain.handle('desktop:operation', async (event, action, body) => {
      if (event.senderFrame !== window?.webContents.mainFrame || event.senderFrame.url !== pageURL || JSON.stringify(body || {}).length > 16384) throw new Error('Untrusted desktop request');
      try { return { ok: true, value: await operation(action, body) }; }
      catch (error) { return { ok: false, error: error.message, status: error.status || 400 }; }
    });
    await ensureAgent().catch(error => dialog.showErrorBox('Codex Remote Web', error.message));
    try {
      if (process.platform === 'linux') {
        const { stdout } = await promisify(execFile)('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.kde.StatusNotifierWatcher'], { timeout: 2000 });
        if (!stdout.includes('true')) throw new Error('Tray unavailable');
      }
      const icon = nativeImage.createFromPath(join(here, 'tray.png'));
      if (process.platform === 'darwin') icon.setTemplateImage(true);
      tray = new Tray(icon); tray.setToolTip('Codex Remote Web'); tray.on('click', () => void openWindow());
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Settings / 设置', click: () => void openWindow() },
        { label: 'Open workspace / 打开工作区', click: () => void operation('openWorkspace').catch(() => {}) },
        { type: 'separator' },
        ...[['Start gateway / 启动网关', 'start'], ['Stop gateway / 停止网关', 'stop']].map(([label, action]) => ({ label, click: () => void operation(action).catch(error => dialog.showErrorBox('Codex Remote Web', error.message)) })),
        { type: 'separator' },
        { label: 'Quit tray (gateway continues) / 退出托盘（网关继续运行）', click: () => { quitting = true; app.quit(); } },
      ]));
    } catch { tray = null; }
    await openWindow();
    if (process.argv.includes('--open-workspace')) await operation('openWorkspace').catch(() => {});
  }
  }).catch(error => {
    if (background || uninstall) console.error('Desktop background component could not start. Check installation and private state permissions.');
    else dialog.showErrorBox('Codex Remote Web', error.message);
    app.exit(1);
  });
}
