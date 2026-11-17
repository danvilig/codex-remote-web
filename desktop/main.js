import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, powerMonitor } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktopDirectory } from '../src/shared/desktop-config.js';
import { agentRequest } from './client.js';
import { privateDirectory } from '../src/server/desktop/private-store.js';
import { configureSession } from './session.js';
import { desktopLocale, nativeText, trayTemplate } from './localization.js';
import { removeAppData } from './cleanup.js';
import { uninstallBackground } from './uninstall.js';

const background = process.argv.includes('--background-agent');
const uninstall = process.argv.includes('--uninstall-background');
const trace = message => { if (process.argv.some(value => value.startsWith('--inspect'))) console.error('[desktop] ' + message); };
trace('bootstrap');
const here = app.getAppPath();
const directory = desktopDirectory();
const root = app.isPackaged ? join(process.resourcesPath, 'gateway') : resolve(here, '../..');
const launchArgs = app.isPackaged ? [] : [join(here, 'main.cjs')];
const controlCommand = app.isPackaged ? [join(root, process.platform === 'win32' ? 'codex-remote-web.exe' : 'codex-remote-web')] : [process.env.CODEX_DESKTOP_BUN || 'bun', 'run', join(root, 'src/server/cli.ts')];
// Independent locks: quitting the tray must never terminate the agent.
const appData = app.getPath('userData');
const userData = join(appData, background ? 'background' : 'desktop');
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath('userData', userData);
trace('private application path selected');
const ownsLock = app.requestSingleInstanceLock({ uninstall, executable: process.execPath });
trace('instance lock checked');
if (!ownsLock && !uninstall) app.quit();
else {
  let window, tray, quitting = false, backgroundChild, sessionWindow;
  let locale = 'en';
  const t = message => nativeText(message, locale);
  const systemLanguages = () => app.getPreferredSystemLanguages();
  const menuActions = {
    openSettings: () => void openWindow(),
    openWorkspace: () => void operation('openWorkspace').catch(() => {}),
    start: () => void operation('start').catch(error => dialog.showErrorBox('Codex Remote Web', error.message)),
    stop: () => void operation('stop').catch(error => dialog.showErrorBox('Codex Remote Web', error.message)),
    quit: () => { quitting = true; app.quit(); },
  };
  function updateMenus(preference = 'system') {
    locale = desktopLocale(preference, systemLanguages());
    const gateway = trayTemplate(locale, menuActions);
    tray?.setContextMenu(Menu.buildFromTemplate(gateway));
    const item = (label, role) => ({ label: t(label), role });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Codex Remote Web', submenu: [gateway[0], gateway[1], { type: 'separator' }, gateway[3], gateway[4], { type: 'separator' }, ...(process.platform === 'darwin' ? [item('Hide Codex Remote Web', 'hide'), item('Hide Others', 'hideOthers'), item('Show All', 'unhide'), { type: 'separator' }] : []), gateway[6]] },
      { label: t('Edit'), submenu: [item('Undo', 'undo'), item('Redo', 'redo'), { type: 'separator' }, item('Cut', 'cut'), item('Copy', 'copy'), item('Paste', 'paste'), item('Select All', 'selectAll')] },
      { label: t('View'), submenu: [item('Toggle Full Screen', 'togglefullscreen')] },
      { label: t('Window'), submenu: [item('Minimize', 'minimize'), item('Zoom', 'zoom'), item('Close', 'close')] },
    ]));
  }
  const pageURL = pathToFileURL(join(here, 'index.html')).href;
  const sessionOptions = { executable: process.execPath, args: launchArgs, directory, command: controlCommand };
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
    if (action === 'cleanUninstall') {
      const confirm = await dialog.showMessageBox(window, { type: 'warning', message: t('Clean up and quit?'), detail: t('Remove app settings, caches, logs and saved management tokens. Projects and your Codex account are preserved.') + '\n' + t(process.platform === 'darwin' && app.isPackaged ? 'The application will move to the Trash.' : 'Then uninstall the application using your system package manager.'), buttons: [t('Cancel'), t('Clean up')], cancelId: 0, defaultId: 0 });
      if (confirm.response !== 1) return;
      await agentRequest(directory, 'cleanupCheck', undefined, { expectedInstallation: process.execPath });
      await uninstallBackground(sessionOptions, process.execPath);
      await promisify(execFile)(controlCommand[0], [...controlCommand.slice(1), 'cleanup-desktop'], { cwd: root, windowsHide: true, timeout: 20000 });
      const session = window.webContents.session;
      await session.clearStorageData(); await session.clearCache(); await session.clearAuthCache();
      if (process.platform === 'darwin' && app.isPackaged) await shell.trashItem(dirname(dirname(dirname(process.execPath))));
      const logs = app.getPath('logs');
      if (app.isPackaged && basename(logs) === app.getName() && logs !== appData) await removeAppData(logs);
      quitting = true; window.destroy(); tray?.destroy(); tray = null;
      try { await removeAppData(appData); }
      catch (error) { dialog.showErrorBox('Codex Remote Web', error.message); app.exit(1); return; }
      app.exit(0); return;
    }
    if (action === 'removeBackground') {
      const confirm = await dialog.showMessageBox(window, { type: 'question', message: t('Stop and remove the background component?'), detail: t('Your projects, credentials and remote deployment records will be preserved.'), buttons: [t('Cancel'), t('Remove')], cancelId: 0, defaultId: 0 });
      if (confirm.response !== 1) return;
      await uninstallBackground(sessionOptions, process.execPath); return;
    }
    if (!['status', 'dependencies', 'config', 'start', 'stop', 'restart', 'setup', 'language'].includes(action)) throw new Error('Unsupported desktop operation');
    if (action === 'config') {
      // Reject invalid settings before touching the user's login registration.
      await agentRequest(directory, 'validateConfig', body);
      const restore = await configureSession(body.autostart, sessionOptions);
      try { const state = await agentRequest(directory, action, body); updateMenus(state.config.language); return state; }
      catch (error) { await restore(); throw error; }
    }
    const result = await agentRequest(directory, action, body);
    if (action === 'language') updateMenus(result.config.language);
    return action === 'status' ? { ...result, systemLocale: desktopLocale('system', systemLanguages()) } : result;
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
      await uninstallBackground(sessionOptions, process.execPath);
      app.exit(0);
    } catch { app.exit(1); }
  } else if (background) {
    await privateDirectory(directory);
    if (process.platform === 'darwin') app.dock?.hide();
    const command = [...controlCommand, 'agent'];
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
    let preference = 'system';
    try { preference = (await agentRequest(directory, 'status')).config.language; } catch {}
    updateMenus(preference);
    try {
      if (process.platform === 'linux') {
        const { stdout } = await promisify(execFile)('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.kde.StatusNotifierWatcher'], { timeout: 2000 });
        if (!stdout.includes('true')) throw new Error('Tray unavailable');
      }
      const icon = nativeImage.createFromPath(join(here, 'tray.png'));
      if (process.platform === 'darwin') icon.setTemplateImage(true);
      tray = new Tray(icon); tray.setToolTip('Codex Remote Web'); tray.on('click', () => void openWindow());
      updateMenus(preference);
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
