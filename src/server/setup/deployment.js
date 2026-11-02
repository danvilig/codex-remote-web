import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { applicationRoot } from '../config/paths.js';
import { SetupError } from './cloudflare.js';
const MARKER = '# Managed by Codex Remote Web setup v1';
export async function atomicPrivate(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temp, value, { mode: 0o600, flag: 'wx' }); await rename(temp, path); await chmod(path, 0o600); }
  finally { await rm(temp, { force: true }); }
}
export async function readOptional(path) { try { return await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
const quote = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const unitQuote = value => quote(String(value).replaceAll('%', '%%'));
export class NativeDeployment {
  constructor({ env = process.env, root = applicationRoot(), run, probe = fetch } = {}) {
    this.env = env; this.root = root; this.probe = probe;
    this.home = env.HOME;
    this.directory = join(this.home, '.config/codex-remote-web');
    this.receiptPath = join(this.directory, 'setup-state.json');
    this.envPath = join(this.directory, 'remote.env');
    this.connectorUnit = join(this.home, '.config/systemd/user/codex-remote-web-tunnel.service');
    this.connectorToken = join(this.directory, 'tunnel-token');
    this.unitPath = join(this.home, '.config/systemd/user/codex-remote-web.service');
    this.run = run || (async args => {
      const proc = Bun.spawn(args, { cwd: this.root, env: this.env, stdout: 'pipe', stderr: 'pipe' });
      const timer = setTimeout(() => proc.kill('SIGKILL'), 60000);
      try { const [code] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]); if (code) throw new SetupError('Native service command failed. Check user systemd, Bun and the production build.', 500); }
      finally { clearTimeout(timer); }
    });
  }
  async preflight(port, owned) {
    if (/[^\S ]|[\r\n]/.test(this.root) || this.root.trim() !== this.root) throw new SetupError('Use an installation path without control characters or leading/trailing spaces.');
    if (process.platform !== 'linux') throw new SetupError('Native deployment currently requires Linux with user systemd.');
    await this.run(['systemctl', '--user', 'show-environment']);
    const existing = await readOptional(this.unitPath);
    if (!owned && await readOptional(this.envPath)) throw new SetupError('A native environment file already exists. Preserve it before choosing this installation.');
    if (existing && (!owned || !existing.startsWith(MARKER))) throw new SetupError('An existing service is not managed by this wizard. Choose a separate installation.');
    if (!owned) await this.availablePort(port);
    if (!existsSync(join(this.root, 'dist/server.js'))) {
      if (!existsSync(join(this.root, 'scripts/build.ts'))) throw new SetupError('Production build is missing.');
    }
  }
  async availablePort(port) {
    await new Promise((accept, reject) => {
      const server = createServer(); server.once('error', () => reject(new SetupError('The service port is in use. Choose another port to keep your existing service running.')));
      server.listen(port, '127.0.0.1', () => server.close(accept));
    });
  }
  async reconfigure(previous, next, persist) {
    await this.assertOwned(previous);
    const values = { PORT: String(next.input.port), CODEX_WEBUI_PUBLIC_ORIGIN: `https://${next.input.hostname}`, CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN: next.teamDomain, CODEX_WEBUI_CF_ACCESS_AUD: next.aud, CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL: next.input.email };
    for (const key of Object.keys(values)) if (!previous.local.environment.split('\n').some(line => line.startsWith(key + '='))) throw new SetupError('The managed service has an incomplete Access configuration.', 409);
    next.local = { ...structuredClone(previous.local), environment: previous.local.environment.split('\n').map(line => {
      const key = line.split('=')[0]; return Object.hasOwn(values,key) ? `${key}=${quote(values[key])}` : line;
    }).join('\n') };
    // Persist the exact expected file before replacement so recovery accepts
    // either side of an interrupted atomic rename, never arbitrary local edits.
    await persist(); await atomicPrivate(this.envPath, next.local.environment);
    await this.run(['systemctl', '--user', 'restart', 'codex-remote-web.service']);
    await this.ready(next.input, next);
  }
  async restoreConfiguration(previous, next, persist) {
    await this.assertOwned(next, [previous.local.environment]);
    await atomicPrivate(this.envPath, previous.local.environment);
    await this.run(['systemctl', '--user', 'restart', 'codex-remote-web.service']);
    await this.ready(previous.input, previous);
  }
  async connectorPreflight() {
    const binary = Bun.which('cloudflared', { PATH: this.env.PATH });
    if (!binary) throw new SetupError('Install cloudflared on this machine before creating a Tunnel. Then refresh the preview.');
    if (await readOptional(this.connectorUnit) || await readOptional(this.connectorToken)) throw new SetupError('A dedicated connector already exists. Remove the managed deployment before creating another one.');
    return binary;
  }
  async installConnector(token, receipt, persist) {
    const binary = await this.connectorPreflight();
    if (typeof token !== 'string' || token.length < 16 || token.length > 16384 || /[\r\n]/.test(token)) throw new SetupError('Cloudflare did not return a valid connector token.');
    const unit = `${MARKER}\n[Unit]\nDescription=Codex Remote Web Tunnel connector\nAfter=network-online.target\n[Service]\nType=simple\nExecStart=:${unitQuote(binary)} --no-autoupdate tunnel run --token-file ${unitQuote(this.connectorToken)}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n[Install]\nWantedBy=default.target\n`;
    receipt.connector = { unit }; await persist();
    await atomicPrivate(this.connectorToken, token + '\n');
    await atomicPrivate(this.connectorUnit, unit);
    await this.run(['systemctl', '--user', 'daemon-reload']);
    await this.run(['systemctl', '--user', 'enable', '--now', 'codex-remote-web-tunnel.service']);
  }
  async removeConnector(receipt) {
    if (!receipt.connector) return;
    const current = await readOptional(this.connectorUnit);
    if (current && current !== receipt.connector.unit) throw new SetupError('The dedicated connector was edited. Cleanup stopped to preserve the change.', 409);
    if (current) {
      await this.run(['systemctl', '--user', 'disable', '--now', 'codex-remote-web-tunnel.service']);
      await rm(this.connectorUnit, { force: true });
      await this.run(['systemctl', '--user', 'daemon-reload']);
    }
    await rm(this.connectorToken, { force: true });
  }
  async install(input, access, receipt, persist) {
    if (existsSync(join(this.root, 'scripts/build.ts'))) await this.run([process.execPath, 'run', 'build']);
    // Inherit workspace/feature settings without changing the user's Codex files.
    const values = { HOME: this.home, PATH: this.env.PATH, CODEX_HOME: this.env.CODEX_HOME || join(this.home, '.codex') };
    for (const [key, value] of Object.entries(this.env)) if (key === 'CODEX_AUTH_PATH' || key.startsWith('CODEX_WEBUI_')) {
      if (!['CODEX_WEBUI_PASSWORD', 'CODEX_WEBUI_ACCESS_TOKEN', 'CODEX_WEBUI_AUTH_STORE'].includes(key)) values[key] = value;
    }
    Object.assign(values, { HOST: '127.0.0.1', PORT: String(input.port), CODEX_WEBUI_AUTH_MODE: 'cloudflare-access', CODEX_WEBUI_PUBLIC_ORIGIN: `https://${input.hostname}`, CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN: access.teamDomain, CODEX_WEBUI_CF_ACCESS_AUD: access.aud, CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL: input.email, CODEX_WEBUI_SETUP_PROBE: crypto.randomUUID() + crypto.randomUUID(), CODEX_WEBUI_CWD: this.env.CODEX_WEBUI_CWD || this.root, CODEX_WEBUI_REVIEW_ROOT: this.env.CODEX_WEBUI_REVIEW_ROOT || this.env.CODEX_WEBUI_CWD || this.root });
    const environment = Object.entries(values).map(([key, value]) => `${key}=${quote(value)}`).join('\n') + '\n';
    // EnvironmentFile is a systemd path directive: quotes become part of the
    // path here, so keep the absolute path unquoted and escape percent signs.
    const environmentPath = this.envPath.replaceAll('%', '%%');
    const unit = `${MARKER}\n[Unit]\nDescription=Codex Remote Web\nAfter=network-online.target\nStartLimitIntervalSec=60\nStartLimitBurst=3\n[Service]\nType=simple\nWorkingDirectory=${this.root.replaceAll('%', '%%')}\nEnvironmentFile=${environmentPath}\nExecStart=:${unitQuote(process.execPath)} run ${unitQuote(join(this.root, 'dist/server.js'))}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=10\nKillMode=mixed\nUMask=0077\n[Install]\nWantedBy=default.target\n`;
    receipt.local = { environment, unit }; receipt.probe = values.CODEX_WEBUI_SETUP_PROBE; await persist();
    await atomicPrivate(this.envPath, environment); await atomicPrivate(this.unitPath, unit);
    await this.run(['systemctl', '--user', 'daemon-reload']);
    await this.run(['systemctl', '--user', 'enable', '--now', 'codex-remote-web.service']);
    await this.ready(input, receipt);
  }
  async assertOwned(receipt, alternatives = []) {
    const unit = await readOptional(this.unitPath), environment = await readOptional(this.envPath);
    if (unit !== receipt.local?.unit || ![receipt.local?.environment, ...alternatives].includes(environment)) throw new SetupError('Local service files changed. Automatic cleanup stopped to preserve your edits.', 409);
  }
  async changeIdentity(receipt, email, persist) {
    await this.assertOwned(receipt);
    const key = 'CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL';
    if (!receipt.local.environment.split('\n').some(line => line.startsWith(key + '='))) throw new SetupError('The managed service has no Access identity setting.', 409);
    receipt.local.environment = receipt.local.environment.split('\n').map(line => line.startsWith(key + '=') ? `${key}=${quote(email)}` : line).join('\n');
    receipt.input.email = email; await persist();
    await atomicPrivate(this.envPath, receipt.local.environment);
    await this.run(['systemctl', '--user', 'restart', 'codex-remote-web.service']);
    await this.ready(receipt.input, receipt);
  }
  async restoreIdentity(receipt, persist) {
    const previous = receipt.identityChange;
    await this.assertOwned(receipt, [previous.local.environment]);
    receipt.local = structuredClone(previous.local); receipt.input = structuredClone(previous.input);
    await persist(); await atomicPrivate(this.envPath, receipt.local.environment);
    await this.run(['systemctl', '--user', 'restart', 'codex-remote-web.service']);
    await this.ready(receipt.input, receipt);
  }
  async ready(input, receipt) {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await this.probe(`http://127.0.0.1:${input.port}/api/setup/ready`, { headers: { 'x-setup-probe': receipt.probe }, redirect: 'error', signal: AbortSignal.timeout(2000) });
        const data = await response.json();
        if (response.status === 200 && data.mode === 'cloudflare-access' && data.publicOrigin === `https://${input.hostname}` && data.audience === receipt.aud && data.allowedEmail === input.email) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new SetupError('The native service did not confirm Access protection. The public route was not enabled.', 500);
  }
  async rollback(receipt) {
    if (!receipt.local) return;
    const unit = await readOptional(this.unitPath), environment = await readOptional(this.envPath);
    if ((unit && unit !== receipt.local.unit) || (environment && environment !== receipt.local.environment)) throw new SetupError('Local service files changed. Automatic cleanup stopped to preserve your edits.', 409);
    if (unit) {
      await this.run(['systemctl', '--user', 'disable', '--now', 'codex-remote-web.service']);
      await rm(this.unitPath, { force: true });
      await this.run(['systemctl', '--user', 'daemon-reload']);
    }
    await rm(this.envPath, { force: true });
  }
}
