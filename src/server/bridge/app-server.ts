import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { connect } from 'node:net';
import { WebSocket } from 'ws';
import { codexCommand } from '../config/codex-command.js';
import { appServerConnection } from '../config/app-server.js';
import { isolatedWorkerPath, nodeRuntime } from '../config/paths.js';
import { windowsIsolatedProcess } from './windows-isolated.js';

export const nativeRequestTimeout = (method: string) =>
  ['thread/read', 'thread/turns/list', 'thread/resume'].includes(method) ? 90000 : 30000;
const transportError = (message: string, code: string, dispatchState = 'unknown') =>
  Object.assign(new Error(message), { code, dispatchState });

// Owns a stdio process or a connection to the shared native daemon. Browser
// lifetimes never own a turn, and shared-daemon lifetimes are external.
export function createAppServerBridge({ cwd, clientInfo, onMessage, onStatus, onHome, connection = appServerConnection(), requestTimeoutMs = nativeRequestTimeout }: any) {
  let child: ChildProcessWithoutNullStreams | null = null;
  let socket: WebSocket | null = null;
  let stopping = false, seq = 1;
  let restart: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; owner: object | null }>();
  const rejectPending = (message: string, owner?: object) => {
    for (const [id, item] of pending) if (!owner || item.owner === owner) {
      pending.delete(id); item.reject(transportError(message, 'RPC_DISCONNECTED'));
    }
  };
  const lifecycles = new Set<Promise<void>>();
  function terminateProc(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = 'SIGTERM') {
    if (process.platform !== 'win32' && proc.pid) {
      try { process.kill(-proc.pid, signal); return; } catch { /* wrapper fallback */ }
    }
    if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
  }
  function terminate(signal: NodeJS.Signals = 'SIGTERM') {
    if (child) terminateProc(child, signal);
  }
  async function reapGroup(proc: ChildProcessWithoutNullStreams) {
    if (process.platform === 'win32' || !proc.pid) return;
    // Capture the old group. Reconnect may already own a different child by
    // the time escalation runs. Keep this timer alive even if stdio closes.
    const group = -proc.pid;
    try { process.kill(group, 'SIGTERM'); } catch { return; }
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      try { process.kill(group, 0); } catch { return; }
    }
    try { process.kill(group, 'SIGKILL'); } catch { /* group already gone */ }
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
      try {
        if (stopping) throw transportError('Codex WebUI is shutting down', 'RPC_NOT_SENT', 'not-sent');
        start();
      } catch (error) { reject(error); return; }
      const owner = connection.mode === 'shared' ? socket : child;
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
        owner,
        resolve: value => { clearTimeout(timer); if (timedOut) late(value); else resolve(value); },
        reject: error => { clearTimeout(timer); if (timedOut) late(undefined, error); else reject(error); }
      });
      try { send({ id, method, params }); } catch (error) { pending.get(id)?.reject(error as Error); pending.delete(id); }
    });
  }
  function receive(raw: string, owner: object) {
    if (owner !== (connection.mode === 'shared' ? socket : child)) return;
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
    ws.on('message', data => receive(String(data), ws));
    ws.on('error', () => console.error('[codex-webui] cannot connect to shared Codex App Server'));
    ws.on('close', () => {
      if (socket !== ws) return;
      socket = null; rejectPending('Shared Codex App Server disconnected', ws);
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
    const [binary, ...prefix] = codexCommand();
    const supervised = process.platform !== 'win32' && process.env.CODEX_WEBUI_DESKTOP_CHILD === '1';
    const command = [binary, ...prefix, 'app-server', '--stdio'];
    const windows = process.platform === 'win32' ? windowsIsolatedProcess(command, cwd) : null;
    const proc = spawn(windows?.binary || (supervised ? nodeRuntime() : binary), windows?.args || (supervised ? [isolatedWorkerPath()] : command.slice(1)), { cwd, env: windows?.env || process.env, stdio: supervised ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }) as ChildProcessWithoutNullStreams;
    child = proc; let buffer = '';
    let finish: () => void;
    const lifecycle = new Promise<void>(resolve => { finish = resolve; });
    lifecycles.add(lifecycle);
    void lifecycle.then(() => lifecycles.delete(lifecycle));
    let reaping = false;
    const reap = () => {
      if (reaping) return;
      reaping = true;
      void reapGroup(proc).finally(finish);
    };
    proc.stdin.on('error', () => { if (child === proc) terminate(); });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const pos = buffer.indexOf('\n'); if (pos < 0) break;
        const line = buffer.slice(0, pos).trim(); buffer = buffer.slice(pos + 1); if (!line) continue;
        receive(line, proc);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', data => console.error('[codex app-server]', String(data).trimEnd()));
    proc.on('error', (error: NodeJS.ErrnoException) => {
      console.error('[codex-webui] cannot start Codex app-server', error.code || 'UNKNOWN');
      if (!proc.pid) reap();
    });
    const disconnected = (code: number | null, signal: NodeJS.Signals | null) => {
      if (child !== proc) return;
      child = null; rejectPending('Codex app-server exited', proc);
      onStatus({ status: 'disconnected', code, signal });
      if (!stopping) restart = setTimeout(start, 1000);
    };
    // Exit invalidates only this connection. Descendants may retain pipes, so
    // close can arrive after a replacement has already initialized.
    proc.once('exit', (code, signal) => { reap(); disconnected(code, signal); });
    proc.on('close', disconnected); // spawn failures may have no exit event
    if (supervised && typeof proc.send === 'function') proc.send({ type: 'start', command, cwd }, error => { if (error && child === proc) terminate(); });
    request('initialize', { clientInfo, capabilities: { experimentalApi: true } }).then(result => {
      if (child !== proc || stopping) return;
      send({ method: 'initialized', params: {} });
      if (typeof result?.codexHome === 'string') onHome(result.codexHome);
      onStatus({ status: 'connected' });
    }).catch(() => { console.error('[codex-webui] initialize failed'); if (child === proc) terminateProc(proc); });
  }
  async function stop() {
    stopping = true; clearTimeout(restart); rejectPending('Codex WebUI is shutting down');
    // The shared daemon and its turns belong to all connected Codex clients.
    // Gateway shutdown closes only this connection, never the daemon process.
    if (socket) { socket.close(); socket = null; }
    const proc = child;
    if (proc) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { terminateProc(proc, 'SIGKILL'); resolve(); }, 4000);
      proc.once('close', () => { clearTimeout(timer); resolve(); });
      terminateProc(proc);
    });
    // Includes exited supervisors whose old descendants outlived their pipes.
    await Promise.all([...lifecycles]);
  }
  return { start, request, send, stop };
}
