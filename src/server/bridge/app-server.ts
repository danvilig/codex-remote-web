import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { connect } from 'node:net';
import { WebSocket } from 'ws';
import { appServerConnection } from '../config/app-server.js';

export const nativeRequestTimeout = (method: string) =>
  ['thread/read', 'thread/turns/list', 'thread/resume'].includes(method) ? 90000 : 30000;
const transportError = (message: string, code: string, dispatchState = 'unknown') =>
  Object.assign(new Error(message), { code, dispatchState });

// Owns a stdio process or a connection to the shared native daemon. Browser
// lifetimes never own a turn, and shared-daemon lifetimes are external.
export function createAppServerBridge({ cwd, clientInfo, onMessage, onStatus, onHome, connection = appServerConnection(), requestTimeoutMs = nativeRequestTimeout }: any) {
  let child: ChildProcessWithoutNullStreams | null = null;
  let socket: WebSocket | null = null;
  let stopping = false, seq = 1, buffer = '';
  let restart: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const rejectPending = (message: string) => { for (const item of pending.values()) item.reject(transportError(message, 'RPC_DISCONNECTED')); pending.clear(); };
  function terminate(signal: NodeJS.Signals = 'SIGTERM') {
    if (!child || child.exitCode !== null) return;
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, signal); return; } catch { /* wrapper fallback */ }
    }
    child.kill(signal);
  }
  function send(message: any) {
    if (stopping) throw transportError('Codex WebUI is shutting down', 'RPC_NOT_SENT', 'not-sent');
    start();
    if (connection.mode === 'shared') {
      if (socket?.readyState !== WebSocket.OPEN) throw transportError('Shared Codex App Server is connecting', 'RPC_NOT_SENT', 'not-sent');
      socket.send(JSON.stringify(message));
    } else child!.stdin.write(JSON.stringify(message) + '\n');
  }
  function request(method: string, params: any = {}, { onLateResponse }: { onLateResponse?: (result: any, error?: any) => unknown } = {}) {
    const id = seq++;
    return new Promise<any>((resolve, reject) => {
      let timedOut = false, cleanup: ReturnType<typeof setTimeout> | undefined;
      const late = (result: any, error?: any) => {
        clearTimeout(cleanup);
        try { Promise.resolve(onLateResponse?.(result, error)).catch(() => {}); } catch { /* receipt recovery can retry reads */ }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        if (onLateResponse) {
          // Retain correlation briefly so a delayed native result can settle
          // the original receipt without resending its mutation.
          cleanup = setTimeout(() => pending.delete(id), 300000);
          cleanup.unref?.();
        } else pending.delete(id);
        reject(transportError(`Codex request timed out: ${method}`, 'RPC_TIMEOUT'));
      }, requestTimeoutMs(method));
      pending.set(id, {
        resolve: value => { clearTimeout(timer); if (timedOut) late(value); else resolve(value); },
        reject: error => { clearTimeout(timer); if (timedOut) late(undefined, error); else reject(error); }
      });
      try { send({ id, method, params }); } catch (error) { pending.get(id)?.reject(error as Error); pending.delete(id); }
    });
  }
  function receive(raw: string) {
    try {
      const message = JSON.parse(raw);
      const item = message.id !== undefined && ('result' in message || 'error' in message) ? pending.get(Number(message.id)) : null;
      if (item) {
        pending.delete(Number(message.id));
        if (message.error) item.reject(Object.assign(new Error(message.error.message || 'App Server error'), {
          code: message.error.code, data: message.error.data, nativeResponse: true,
        }));
        else item.resolve(message.result);
      }
      else onMessage(message);
    } catch { console.error('[codex-webui] invalid app-server message'); }
  }
  function startShared() {
    if (socket) return;
    // socketPath is passed separately, so a configured filename cannot become a
    // URL, remote endpoint, query or WebSocket path. This is a local connection.
    const ws = new WebSocket('ws://localhost/', {
      createConnection: () => connect(connection.socket),
      handshakeTimeout: 10000,
    });
    socket = ws;
    ws.on('message', data => receive(String(data)));
    ws.on('error', () => console.error('[codex-webui] cannot connect to shared Codex App Server'));
    ws.on('close', () => {
      if (socket !== ws) return;
      socket = null; rejectPending('Shared Codex App Server disconnected');
      onStatus({ status: 'disconnected' });
      if (!stopping) restart = setTimeout(start, 1000);
    });
    ws.on('open', () => {
      request('initialize', { clientInfo, capabilities: { experimentalApi: true } }).then(result => {
        if (socket !== ws || stopping) return;
        send({ method: 'initialized', params: {} });
        if (typeof result?.codexHome === 'string') onHome(result.codexHome);
        onStatus({ status: 'connected' });
      }).catch(() => { console.error('[codex-webui] shared initialize failed'); ws.close(); });
    });
  }
  function start() {
    if (stopping || child?.exitCode === null) return;
    if (connection.mode === 'shared') { startShared(); return; }
    const proc = spawn('codex', ['app-server', '--stdio'], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child = proc; buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const pos = buffer.indexOf('\n'); if (pos < 0) break;
        const line = buffer.slice(0, pos).trim(); buffer = buffer.slice(pos + 1); if (!line) continue;
        receive(line);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', data => console.error('[codex app-server]', String(data).trimEnd()));
    proc.on('error', () => console.error('[codex-webui] cannot start Codex app-server'));
    proc.once('exit', () => {
      // An unexpectedly exited stdio server can leave its own tool descendants
      // holding its stdio pipes open, so waiting for `close` would deadlock
      // recovery. Reap only our isolated group on `exit`, never shared daemons.
      if (process.platform !== 'win32' && proc.pid) {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already exited */ }
      }
    });
    proc.on('close', (code, signal) => {
      rejectPending('Codex app-server exited');
      if (child === proc) child = null;
      onStatus({ status: 'disconnected', code, signal });
      if (!stopping) restart = setTimeout(start, 1000);
    });
    request('initialize', { clientInfo, capabilities: { experimentalApi: true } }).then(result => {
      if (child !== proc || stopping) return;
      send({ method: 'initialized', params: {} });
      if (typeof result?.codexHome === 'string') onHome(result.codexHome);
      onStatus({ status: 'connected' });
    }).catch(() => { console.error('[codex-webui] initialize failed'); terminate(); });
  }
  async function stop() {
    stopping = true; clearTimeout(restart); rejectPending('Codex WebUI is shutting down');
    // The shared daemon and its turns belong to all connected Codex clients.
    // Gateway shutdown closes only this connection, never the daemon process.
    if (socket) { socket.close(); socket = null; }
    if (!child) return;
    const proc = child;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { terminate('SIGKILL'); resolve(); }, 4000);
      proc.once('close', () => { clearTimeout(timer); resolve(); });
      terminate();
    });
  }
  return { start, request, send, stop };
}
