import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workerCommand } from '../config/paths.js';
import { readPrivate, privateDirectory } from './private-store.js';
import { privateAccess } from '../config/private-access.js';
import { stat } from 'node:fs/promises';

export class DesktopConnector {
  constructor({ directory, worker, env, log = () => {} }) { Object.assign(this, { directory, worker, env, log }); this.ids = new Set(); }
  async start(binary, tokenPath, owner) {
    await this.stop();
    const saved = await readPrivate(tokenPath);
    if (!saved || saved.owner !== owner) throw new Error('Connector ownership could not be verified');
    // cloudflared accepts a token file, so it never appears in argv or logs.
    const runtimeToken = this.runtimeToken = join(this.directory, `connector-${randomUUID()}.token`);
    await privateDirectory(this.directory);
    await writeFile(runtimeToken, saved.token + '\n', { mode: 0o600, flag: 'wx' });
    if (!privateAccess(await stat(runtimeToken), runtimeToken)) { await rm(runtimeToken, { force: true }); throw new Error('Connector token permissions are unsafe'); }
    const [runtime, ...workerArgs] = workerCommand('worker-connector', this.worker, this.env);
    const worker = spawn(runtime, workerArgs, { env: this.env, windowsHide: true, serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.workerProcess = worker; this.ids.clear();
    this.closed = new Promise(resolve => { worker.once('exit', resolve); worker.once('error', resolve); });
    this.closed = this.closed.then(async () => { if (this.workerProcess === worker) { this.workerProcess = null; this.ids.clear(); } await rm(runtimeToken, { force: true }); this.log('connector-stopped'); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Connector did not become ready')); void this.stop(); }, 90000);
      worker.on('message', message => {
        if (message?.type === 'connector-id' && /^[a-f0-9-]{36}$/i.test(message.id)) this.ids.add(message.id.toLowerCase());
        if (message?.type === 'ready') { clearTimeout(timer); resolve(); }
      });
      this.closed.then(() => { clearTimeout(timer); reject(new Error('Connector exited before it became ready')); });
      worker.send({ binary, tokenFile: runtimeToken, args: ['tunnel', '--no-autoupdate', '--output', 'json', 'run', '--token-file', runtimeToken] }, error => { if (error) { clearTimeout(timer); reject(new Error('Connector could not start')); } });
    });
    this.log('connector-ready');
  }
  async stop() {
    const worker = this.workerProcess;
    if (worker?.connected) worker.send({ type: 'stop' }, () => {});
    else worker?.kill('SIGTERM');
    if (worker) {
      const timeout = setTimeout(() => worker.kill('SIGKILL'), 5000);
      try { await this.closed; } finally { clearTimeout(timeout); }
    }
    if (this.runtimeToken) await rm(this.runtimeToken, { force: true });
  }
}
