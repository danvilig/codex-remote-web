import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { stat, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { desktopConfig, desktopDirectory } from '../../shared/desktop-config.js';
import { acquirePrivateLock } from '../services/private-lock.js';
import { applicationRoot, gatewayCommand, nodeRuntime, standalone } from '../config/paths.js';
import { codexCommand } from '../config/codex-command.js';
import { localSetupRequest } from '../setup/http.js';
import { readJsonBody } from '../http/body.ts';
import { SetupService } from '../setup/service.js';
import { SetupError } from '../setup/cloudflare.js';
import { privateDirectory, readPrivate, writePrivate } from './private-store.js';
import { GatewayProcess } from './process.js';
import { DesktopDeployment } from './deployment.js';
import { DesktopConnector } from './connector.js';

const exec = promisify(execFile);
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function startDesktopAgent({ home = homedir(), directory = desktopDirectory(home), root = applicationRoot(), command = gatewayCommand(root), env = process.env, serviceFactory, startupMs } = {}) {
  await privateDirectory(directory);
  const release = await acquirePrivateLock(join(directory, 'agent-lock'), { timeoutMs: 100 });
  const configPath = join(directory, 'config.json'), descriptorPath = join(directory, 'agent.json');
  let config, server, closing = false, busy = false, closePromise;
  const inflight = new Set();
  const events = [];
  const log = event => { events.push({ time: new Date().toISOString(), event }); if (events.length > 200) events.shift(); };
  const local = new GatewayProcess({ command, log: event => log('local:' + event), startupMs });
  const protectedGateway = new GatewayProcess({ command, log: event => log('protected:' + event), startupMs });
  let connector, setup;
  const environment = () => {
    const result = {};
    for (const key of ['HOME', 'USERPROFILE', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'CODEX_HOME', 'CODEX_AUTH_PATH', 'CODEX_WEBUI_APP_SERVER_MODE', 'CODEX_WEBUI_APP_SERVER_SOCKET']) if (env[key]) result[key] = env[key];
    result.HOME = home;
    result.PATH = [env.PATH, join(home, '.local/bin'), join(home, '.bun/bin'), ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []), ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : [])].filter(Boolean).join(delimiter);
    Object.assign(result, { HOST: '127.0.0.1', PORT: String(config.port), CODEX_WEBUI_CWD: config.cwd, CODEX_WEBUI_REVIEW_ROOT: config.cwd, CODEX_WEBUI_ENABLE_TERMINAL: String(config.terminal), CODEX_WEBUI_NODE: nodeRuntime(env), CODEX_WEBUI_AUTH_MODE: 'local' });
    if (config.codex) result.CODEX_WEBUI_CODEX = config.codex;
    if (config.cloudflared) result.CODEX_WEBUI_CLOUDFLARED = config.cloudflared;
    return result;
  };
  async function dependencies(candidate = config) {
    const current = config; config = candidate; const values = environment(); config = current;
    const results = [];
    for (const [name, selected] of [['codex', candidate.codex], ['git', ''], ['cloudflared', candidate.cloudflared]]) {
      const binary = selected || Bun.which(name, { PATH: values.PATH });
      if (!binary) { results.push({ name, ok: false, error: 'Executable not found' }); continue; }
      try {
        const args = name === 'codex' ? codexCommand({ binary, node: values.CODEX_WEBUI_NODE }) : [binary];
        const { stdout } = await exec(args[0], [...args.slice(1), '--version'], { env: values, windowsHide: true, timeout: 5000, maxBuffer: 32768 });
        results.push({ name, ok: true, path: binary, version: stdout.trim().split('\n')[0].slice(0, 120) });
      } catch { results.push({ name, ok: false, path: binary, error: 'Executable could not be verified' }); }
    }
    return results;
  }
  async function start() {
    if (!config.initialized) throw new SetupError('Complete initialization first', 409);
    await local.start({ env: environment(), cwd: config.cwd });
    const receipt = await setup.receipt();
    if (receipt?.phase === 'complete' && !receipt.identityChange && !receipt.configurationChange) {
      await setup.deployment.assertOwned(receipt);
      if (protectedGateway.phase !== 'running') await setup.deployment.activate(receipt);
      if (receipt.connector && !connector.workerProcess) await connector.start(receipt.connector.binary, setup.deployment.connectorToken, receipt.connector.owner);
    }
    config = { ...config, enabled: true }; await writePrivate(configPath, config);
  }
  async function stop() {
    await connector.stop(); await Promise.all([local.stop(), protectedGateway.stop()]);
    config = { ...config, enabled: false }; await writePrivate(configPath, config);
  }
  async function status() {
    return { config, local: local.status(), protected: protectedGateway.status(), connector: { running: !!connector.workerProcess }, url: `http://127.0.0.1:${config.port}`, events: [...events], setup: { ...setup.status(), busy: setup.busy } };
  }
  async function setupRequest(path, body) {
    const [action, query] = path.split('?');
    if (action === 'session') return { unlocked: true, csrf: 'desktop' };
    if (action === 'launch') return { key: 'desktop' };
    if (action === 'status') { await setup.resume(); const receipt = await setup.receipt(); return { ...setup.status(), deployment: receipt ? { phase: receipt.phase, input: receipt.input, identityRecovery: !!receipt.identityChange, configurationRecovery: !!receipt.configurationChange } : null }; }
    if (action === 'quick/status' && local.phase !== 'running') return { available: false, running: false, phase: 'stopped' };
    if (['quick/status', 'quick/start', 'quick/stop'].includes(action)) return local.request(action, body);
    switch (action) {
      case 'resources': return setup.discover(new URLSearchParams(query).get('accountId'));
      case 'connect': return { accounts: await setup.connect(body?.token) };
      case 'preview': if (local.phase !== 'running') throw new SetupError('Initialize and start the local gateway first', 409); return setup.preview(body);
      case 'change/preview': return setup.previewConfiguration(body);
      case 'apply': if (local.phase !== 'running') throw new SetupError('Start the local gateway first', 409); setup.startApply(body?.id); return setup.status();
      case 'change/recover': setup.startIdentityRecovery(); return setup.status();
      case 'remove': setup.startRemove(); return setup.status();
      case 'doctor': return setup.diagnose();
      case 'credential/forget': await setup.forgetCredential(); return { forgotten: true };
      case 'credential/retry': setup.restoreAttempted = false; await setup.resume(); return setup.status();
      case 'lock': setup.disconnect(); return { locked: true };
      default: throw new SetupError('Unknown desktop setup operation', 404);
    }
  }
  async function validateConfig(body) {
    if (local.desired || protectedGateway.desired || local.child || protectedGateway.child) throw new SetupError('Stop the gateway before changing its settings', 409);
    const next = desktopConfig({ ...body, enabled: false, initialized: true }, home);
    const receipt = await setup.receipt();
    if (receipt && receipt.phase !== 'removed' && next.port === receipt.input.port) throw new SetupError('The local gateway and fixed-domain gateway need different ports');
    if (!(await stat(next.cwd)).isDirectory()) throw new SetupError('Choose an existing project directory');
    const checks = await dependencies(next);
    if (!checks.find(item => item.name === 'codex')?.ok || !checks.find(item => item.name === 'git')?.ok) throw new SetupError('Codex and Git must pass dependency checks');
    return next;
  }
  function dispatch(action, body = {}) {
    const pending = perform(action, body);
    inflight.add(pending);
    return pending.finally(() => inflight.delete(pending));
  }
  async function perform(action, body) {
    if (action === 'status') return status();
    if (closing) throw new SetupError('The desktop agent is shutting down', 503);
    if (action === 'dependencies') return dependencies(body.config ? desktopConfig(body.config, home) : config);
    if (busy) throw new SetupError('Wait for the current desktop operation', 409);
    busy = true;
    try {
      if (action === 'setup') return await setupRequest(body.path, body.body);
      if (setup.busy) throw new SetupError('Wait for the remote access operation', 409);
      if (action === 'validateConfig') return await validateConfig(body);
      if (action === 'config') {
        const next = await validateConfig(body);
        await writePrivate(configPath, next); config = next; log('configuration-saved');
      } else if (action === 'start') await start();
      else if (action === 'stop') await stop();
      else if (action === 'restart') { await stop(); await start(); }
      else if (action === 'shutdown') { setTimeout(() => void close().catch(() => log('shutdown-failed')), 20); }
      else throw new SetupError('Unknown desktop operation', 404);
      return status();
    } finally { busy = false; }
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      // Finish accepted mutations before stopping children. Session shutdown
      // preserves the desired state for the next login.
      await Promise.allSettled([...inflight]);
      if (setup?.operation) await setup.operation.catch(() => {});
      try {
        await Promise.allSettled([connector?.stop(), local.stop(), protectedGateway.stop()]);
        setup?.disconnect();
        server?.closeAllConnections();
        if (server?.listening) await new Promise(resolve => server.close(resolve));
      } finally {
        try { await rm(descriptorPath, { force: true }); } finally { await release(); }
        process.off('SIGTERM', signal); process.off('SIGINT', signal); process.off('disconnect', signal);
        log('agent-stopped');
      }
    })();
    return closePromise;
  }
  const signal = () => { void close().catch(() => log('shutdown-failed')).finally(() => { if (process.connected) process.disconnect(); }); };
  try {
    config = desktopConfig(await readPrivate(configPath, {}), home);
    const worker = standalone ? join(root, 'dist/desktop-connector-worker.js') : join(root, 'src/server/desktop/connector-worker.js');
    connector = new DesktopConnector({ directory, worker, env: environment(), log });
    const deployment = new DesktopDeployment({ directory, root, env: environment(), gateway: protectedGateway, connector, environment });
    setup = serviceFactory ? serviceFactory(deployment) : new SetupService({ deployment, connectorIds: async () => [...connector.ids] });
    const token = randomBytes(32).toString('base64url');
    server = createServer(async (req, res) => {
      const reply = (code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
      if (!localSetupRequest(req) || req.headers.origin || !equal(req.headers.authorization, `Bearer ${token}`)) return reply(403, { error: 'Desktop control is private to this user' });
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') return reply(405, { error: 'Use an authenticated JSON operation' });
      try {
        if (req.url !== '/v1/control') throw new SetupError('Not found', 404);
        const request = await readJsonBody(req, 16384); reply(200, await dispatch(request.action, request.body));
      } catch (error) { reply(error instanceof SetupError ? error.status : 400, { error: error instanceof SetupError ? error.message : 'Desktop operation failed. Check local paths, permissions and dependencies.' }); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await writePrivate(descriptorPath, { version: 1, port: server.address().port, token, pid: process.pid, installation: env.CODEX_WEBUI_DESKTOP_INSTALLATION || null });
    process.on('SIGTERM', signal); process.on('SIGINT', signal); if (process.connected) process.on('disconnect', signal);
    if (config.initialized && config.enabled) void dispatch('start').catch(() => log('startup-failed'));
    log('agent-ready');
    return { server, dispatch, close, directory };
  } catch (error) { await close(); throw error; }
}
