// Private stdin/stdout protocol used only by the native macOS executable.
// The renderer never supplies installation paths or gets the control token.
import { desktopDirectory } from '../../src/shared/desktop-config.js';
import { agentRequest } from '../client.js';
import { configureSession } from '../session.js';
import { uninstallBackground } from '../uninstall.js';
import { privateDirectory } from '../../src/server/desktop/private-store.js';
import { removeAppData } from '../cleanup.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanDesktopState } from '../../src/server/desktop/cleanup.js';

export async function macOperation(installation, action, body, { directory = desktopDirectory() } = {}) {
  if (typeof installation !== 'string' || !installation.startsWith('/') || /[\0\r\n]/.test(installation)) throw new Error('Invalid desktop installation');
  if (action === 'prepare') { await privateDirectory(directory); return null; }
  const options = { executable: installation, directory };
  const request = (name, value) => agentRequest(directory, name, value, { expectedInstallation: installation });
  if (action === 'removeBackground' || action === 'cleanUninstall') {
    if (action === 'cleanUninstall') await request('cleanupCheck');
    await uninstallBackground(options, installation);
    if (action === 'cleanUninstall') {
      await cleanDesktopState(directory);
      // Also remove preferences/caches left by the previous Electron shell.
      for (const path of [join(homedir(), 'Library/Application Support/Codex Remote Web'), join(homedir(), 'Library/Caches/io.github.danvilig.codex-remote-web'), join(homedir(), 'Library/Logs/Codex Remote Web')]) await removeAppData(path);
    }
    return null;
  }
  if (action === 'config') {
    await request('validateConfig', body);
    const restore = await configureSession(body.autostart, options);
    try { return await request(action, body); }
    catch (error) { await restore(); throw error; }
  }
  if (!['status', 'dependencies', 'start', 'stop', 'restart', 'setup', 'language'].includes(action)) throw new Error('Unsupported desktop operation');
  return request(action, body);
}
export async function nativeOperationInput(installation) {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 16384) throw new Error('Desktop request is too large'); }
    const { action, body } = JSON.parse(input);
    const value = await macOperation(installation, action, body);
    console.log(JSON.stringify({ ok: true, value }));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message, code: error.code, status: error.status || 400 })); }
}
