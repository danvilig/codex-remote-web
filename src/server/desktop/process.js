import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export class GatewayProcess {
  constructor({ command, log = () => {}, startupMs = 20000, restart = true } = {}) {
    this.command = command; this.log = log; this.startupMs = startupMs; this.restart = restart;
    this.phase = 'stopped'; this.failures = []; this.pending = new Map(); this.desired = false;
  }
  status() { return { phase: this.phase, pid: this.child?.pid || null, error: this.error || null }; }
  async start(options) {
    this.desired = true; this.options = options;
    if (this.child) { if (this.phase === 'running') return; if (this.starting) return this.starting; throw new Error('Wait for the gateway to stop'); }
    clearTimeout(this.retry); this.phase = 'starting'; this.error = null;
    this.starting = this.launch(options).finally(() => { this.starting = null; });
    return this.starting;
  }
  async launch({ env, cwd }) {
    const [binary, ...args] = this.command;
    const child = spawn(binary, args, { env: { ...env, CODEX_WEBUI_DESKTOP_CHILD: '1' }, cwd, windowsHide: true, detached: process.platform !== 'win32', serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.child = child;
    const closed = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    this.closed = closed;
    closed.then(() => {
      if (this.child !== child) return;
      this.child = null;
      for (const request of this.pending.values()) request.reject(new Error('Gateway disconnected'));
      this.pending.clear();
      this.phase = this.desired ? 'failed' : 'stopped';
      if (this.desired) {
        this.error = 'Gateway exited. Check dependencies, directory and port.'; this.log('gateway-exited');
        this.failures = this.failures.filter(time => Date.now() - time < 60000); this.failures.push(Date.now());
        if (this.restart && this.failures.length < 3) this.retry = setTimeout(() => { if (this.desired) void this.start(this.options).catch(() => {}); }, 2000);
      }
    });
    child.on('message', message => {
      const request = this.pending.get(message?.id);
      if (message?.type !== 'desktop-result' || !request) return;
      this.pending.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Gateway startup timed out')); void this.stop(); }, this.startupMs);
      const done = error => { clearTimeout(timer); child.off('message', message); error ? reject(error) : resolve(); };
      const message = value => { if (value?.type === 'desktop-ready') { this.phase = 'running'; this.log('gateway-ready'); done(); } };
      child.on('message', message); child.once('error', () => done(new Error('Gateway executable could not start')));
      closed.then(() => { if (this.phase !== 'running') done(new Error('Gateway failed to start. Check dependencies, directory and port.')); });
    });
  }
  async request(action, body) {
    if (!this.child?.connected || this.phase !== 'running') throw new Error('Start the local gateway first');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Gateway control timed out')); }, 10000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child.send({ type: 'desktop-control', id, action, body }, error => { if (error) { const request = this.pending.get(id); this.pending.delete(id); request?.reject(new Error('Gateway disconnected')); } });
    });
  }
  async stop() {
    this.desired = false; clearTimeout(this.retry);
    const child = this.child; if (!child) { this.phase = 'stopped'; return; }
    this.phase = 'stopping';
    if (child.connected) child.send({ type: 'desktop-control', action: 'shutdown' }, () => {});
    else child.kill('SIGTERM');
    let timer;
    await Promise.race([this.closed, new Promise(resolve => { timer = setTimeout(resolve, 8000); })]); clearTimeout(timer);
    if (child.exitCode === null && this.child === child) {
      if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, resolve));
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      await this.closed;
    }
    this.phase = 'stopped'; this.error = null;
  }
}
