import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { quickWorkerPath } from '../config/paths.js';
import { SetupError } from './cloudflare.js';
const exec = promisify(execFile);
export function quickEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email) || email.includes('*') || email.includes(',')) throw new SetupError('Enter the one email address allowed to sign in.');
  return email;
}
export function quickOrigin(value) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(value)) throw new SetupError('The temporary address could not be verified.', 502);
  return value;
}
export function connectorEnvironment(env, directory) {
  const result = { HOME: directory, PATH: env.PATH || '/usr/bin:/bin' };
  for (const key of ['TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SystemRoot']) if (env[key]) result[key] = env[key];
  return result;
}
export async function quickPreflight(env = process.env) {
  if (process.platform === 'win32') throw new SetupError('Temporary access requires a Unix socket on Linux or macOS.');
  const binary = Bun.which('cloudflared', { PATH: env.PATH });
  if (!binary) throw new SetupError('Install cloudflared to use temporary access.');
  let stdout;
  try { ({ stdout } = await exec(binary, ['tunnel','--help'], { env: connectorEnvironment(env, tmpdir()), timeout: 5000, maxBuffer: 150000 })); }
  catch { throw new SetupError('Unable to check cloudflared. Check its installation.'); }
  if (!stdout.includes('--allowed-mail') || !stdout.includes('--unix-socket')) throw new SetupError('Update cloudflared to a version supporting protected Quick Tunnels.');
  return binary;
}
export function quickConnectorArgs(directory, email) {
  // --hello-world selects Quick Tunnel mode. Explicit ingress takes precedence,
  // so no demonstration server is exposed; --url conflicts with ingress validation.
  return ['tunnel','--no-autoupdate','--config',join(directory,'config.yml'),'--output','json','--loglevel','info','--protocol','auto','--hello-world','--allowed-mail',email,'--metrics','127.0.0.1:0','--management-diagnostics=false','--grace-period','1s'];
}
export async function validateQuickConfiguration(binary, args, env, directory) {
  try {
    const { stdout, stderr } = await exec(binary, [...args,'ingress','validate'], { env:connectorEnvironment(env,directory), cwd:directory, timeout:5000, maxBuffer:150000 });
    // Some cloudflared CLI usage errors exit with status 0. Check the success
    // marker as well as the exit code, without returning raw output or paths.
    if (!/^OK\s*$/m.test(stdout) || /Incorrect Usage|flag provided but not defined/i.test(stdout+stderr)) throw new Error('Invalid configuration');
  } catch { throw new SetupError('cloudflared rejected the temporary access configuration. Update cloudflared and retry.'); }
}
export function quickFailure(code) {
  return new SetupError({
    arguments:'cloudflared rejected its startup arguments. Update the WebUI and cloudflared, then retry.',
    configuration:'cloudflared rejected the temporary access configuration. Update cloudflared and retry.',
    tls:'The secure connection to Cloudflare failed certificate verification. Check the system clock and trusted certificates.',
    network:'Cloudflare temporary access could not be reached. Check DNS, proxy and network connectivity, then retry.',
    provisioning:'Cloudflare could not create the temporary address. Check connectivity and try again later.',
    protection:'cloudflared did not confirm email protection. Update cloudflared; access was not opened.',
    launch:'The temporary access connector could not start. Check the Node.js and cloudflared installations.',
    timeout:'Temporary access did not become ready in time. Check connectivity to Cloudflare and retry.',
  }[code] || 'Temporary access could not connect securely. Check cloudflared and the network, then retry.');
}
export function createQuickConnector({ binary, args, directory, env, onMessage, onExit }) {
  const node = env.CODEX_WEBUI_NODE || Bun.which('node', { PATH: env.PATH });
  if (!node) throw new SetupError('Node.js is required to supervise temporary access.');
  const worker = spawn(node, [quickWorkerPath()], { env: connectorEnvironment(env, directory), stdio: ['ignore','ignore','ignore','ipc'] });
  const closed = new Promise(resolve => { worker.once('exit', resolve); worker.once('error', resolve); });
  worker.on('message', onMessage); worker.once('exit', onExit);
  worker.once('error', () => onMessage({ type: 'error', code: 'launch' }));
  worker.send({ type: 'start', binary, args, directory }, error => { if (error) onMessage({ type: 'error', code: 'launch' }); });
  return { closed, stop() { if (worker.connected) worker.send({ type: 'stop' }, () => {}); else worker.kill('SIGTERM'); } };
}
export class QuickTunnel {
  constructor({ workspace, directory = join(process.env.HOME, '.config/codex-remote-web'), env = process.env, preflight = quickPreflight, validate = validateQuickConfiguration, connector = createQuickConnector, startupMs = 90000 } = {}) {
    this.workspace = workspace; this.directory = directory; this.env = env; this.preflight = preflight; this.validate = validate; this.connector = connector; this.startupMs = startupMs;
    this.state = { phase: 'stopped', publicOrigin: null, email: null, startedAt: null, error: null };
  }
  status() { return { ...this.state, running: !!this.runtime, available: !!this.workspace }; }
  start(rawEmail) {
    if (!this.workspace) throw new SetupError('Open the full WebUI to start temporary access.', 409);
    if (this.runtime) throw new SetupError('Temporary access is already starting or running.', 409);
    const email = quickEmail(rawEmail), runtime = { id: randomUUID(), cancelled: false, abort: new AbortController() };
    this.runtime = runtime; this.state = { phase: 'starting', publicOrigin: null, email, startedAt: null, error: null };
    runtime.starting = this.run(runtime, email).catch(async error => {
      const disposed = await this.dispose(runtime);
      if (this.runtime === runtime) { if (disposed) this.runtime = null; this.state.phase = disposed && runtime.cancelled ? 'stopped' : 'failed'; this.state.publicOrigin = null; this.state.error = !disposed ? this.cleanupError() : runtime.cancelled ? null : error instanceof SetupError ? error.message : 'Temporary access could not start. Check the network and try again.'; }
    });
  }
  active(runtime) { if (runtime.cancelled) throw new SetupError('Temporary access was stopped.'); }
  async acquire(runtime) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'quick-tunnel.lock'), value = JSON.stringify({ pid: process.pid, id: runtime.id });
    const claim = () => writeFile(path, value, { flag: 'wx', mode: 0o600 });
    try { await claim(); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(await readFile(path, 'utf8')); process.kill(previous.pid, 0); }
      catch (failure) { if (failure.code === 'ESRCH') { await rm(path, { force: true }); await claim(); runtime.lock = { path, value }; return; } }
      throw new SetupError('Temporary access is managed by another WebUI process. Stop it there first.', 409);
    }
    runtime.lock = { path, value };
  }
  async run(runtime, email) {
    const binary = await this.preflight(this.env); this.active(runtime);
    await this.acquire(runtime); this.active(runtime);
    runtime.directory = await mkdtemp(join(tmpdir(), 'codex-quick-')); this.active(runtime);
    await writeFile(join(runtime.directory, 'config.yml'), JSON.stringify({ ingress:[{service:`unix:${join(runtime.directory,'origin.sock')}`}] })+'\n', { mode: 0o600 }); this.active(runtime);
    const args = quickConnectorArgs(runtime.directory, email);
    await this.validate(binary,args,this.env,runtime.directory); this.active(runtime);
    runtime.origin = await this.workspace({ socketPath: join(runtime.directory, 'origin.sock'), email }); this.active(runtime);
    let ready;
    const started = new Promise((resolve,reject) => {
      const fail = code => reject(quickFailure(code));
      const timeout = setTimeout(() => fail('timeout'), this.startupMs); timeout.unref?.();
      const abort = () => reject(new SetupError('Temporary access was stopped.'));
      runtime.abort.signal.addEventListener('abort', abort, { once: true });
      ready = message => {
        if (runtime.cancelled) return;
        if (message?.type === 'error') { fail(message.code); if (this.state.phase === 'ready') void this.fail(runtime,message.code); }
        if (message?.type === 'ready') {
          try { resolve(quickOrigin(message.publicOrigin)); } catch (error) { reject(error); }
        }
      };
      runtime.clear = () => { clearTimeout(timeout); runtime.abort.signal.removeEventListener('abort', abort); };
    });
    try {
      runtime.connector = this.connector({ binary, args, directory: runtime.directory, env: this.env, onMessage: message => ready(message), onExit: () => { ready({ type:'error' }); } });
      const publicOrigin = await started; this.active(runtime);
      runtime.origin.activate(publicOrigin);
      this.state = { phase:'ready', publicOrigin, email, startedAt:Date.now(), error:null };
    } finally { runtime.clear(); }
  }
  async fail(runtime, code) {
    if (this.runtime !== runtime || runtime.cancelled) return;
    runtime.cancelled = true;
    const disposed = await this.dispose(runtime);
    if (this.runtime === runtime) { if (disposed) this.runtime = null; this.state.phase='failed'; this.state.publicOrigin=null; this.state.error=disposed ? code && code!=='exited' ? quickFailure(code).message : 'Temporary access ended. Start again to generate a new address.' : this.cleanupError(); }
  }
  cleanupError() { return 'Temporary access cleanup is incomplete. Stop it again before starting a new connection.'; }
  async dispose(runtime) {
    return runtime.disposing ||= (async () => {
      // Always stop the connector, even if closing the origin fails. Keep the
      // process lock after a cleanup error, and allow an explicit stop to retry.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => runtime.origin?.close()),
        Promise.resolve().then(async () => { runtime.connector?.stop(); await runtime.connector?.closed; }),
      ]);
      if (results.some(result => result.status === 'rejected')) return false;
      try {
        if (runtime.directory) await rm(runtime.directory, { recursive:true, force:true });
        if (runtime.lock && await readFile(runtime.lock.path,'utf8').catch(()=>null) === runtime.lock.value) await rm(runtime.lock.path,{force:true});
        return true;
      } catch { return false; }
    })().then(disposed => { if (!disposed) runtime.disposing = null; return disposed; });
  }
  async stop() {
    const runtime = this.runtime;
    if (!runtime) return this.status();
    this.state.phase='stopping'; this.state.publicOrigin=null; runtime.cancelled=true; runtime.abort.abort();
    await runtime.starting; const disposed = await this.dispose(runtime);
    if (this.runtime === runtime) { if (disposed) this.runtime=null; this.state.phase=disposed?'stopped':'failed'; this.state.error=disposed?null:this.cleanupError(); }
    return this.status();
  }
}
