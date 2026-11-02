import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export function appServerConnection(env = process.env) {
  const mode = env.CODEX_WEBUI_APP_SERVER_MODE || 'auto';
  if (!['auto', 'shared', 'isolated'].includes(mode)) throw new Error('Invalid CODEX_WEBUI_APP_SERVER_MODE');
  const home = env.CODEX_HOME || join(env.HOME || process.cwd(), '.codex');
  const socket = env.CODEX_WEBUI_APP_SERVER_SOCKET || join(home, 'app-server-control', 'app-server-control.sock');
  if (!isAbsolute(socket) || /[\0\r\n]/.test(socket)) throw new Error('App Server socket must be an absolute local path');
  // Once a shared transport is selected, connection failures stay visible. Never
  // silently create a second writer while Desktop owns the shared workspace.
  if (mode === 'shared' || (mode === 'auto' && (env.CODEX_WEBUI_APP_SERVER_SOCKET || existsSync(socket)))) {
    return { mode: 'shared', socket };
  }
  return { mode: 'isolated', socket: null };
}
