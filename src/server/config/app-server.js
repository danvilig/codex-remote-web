import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export function appServerConnection(env = process.env) {
  const mode = env.CODEX_WEBUI_APP_SERVER_MODE || 'shared';
  if (!['auto', 'shared', 'isolated'].includes(mode)) throw new Error('Invalid CODEX_WEBUI_APP_SERVER_MODE');
  const home = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  const socket = env.CODEX_WEBUI_APP_SERVER_SOCKET || join(home, 'app-server-control', 'app-server-control.sock');
  if (!isAbsolute(socket) || /[\0\r\n]/.test(socket)) throw new Error('App Server socket must be an absolute local path');
  // A missing socket can mean the daemon is still starting. Never choose a
  // second writer based on startup order. Keep `auto` as a shared-mode alias
  // for existing deployments; standalone writers now require an explicit opt-in.
  return mode === 'isolated' ? { mode: 'isolated', socket: null } : { mode: 'shared', socket };
}
