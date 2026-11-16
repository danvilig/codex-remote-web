import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { NativeDeployment } from '../setup/deployment.js';
import { SetupError } from '../setup/cloudflare.js';
import { readPrivate, writePrivate } from './private-store.js';

// Reuse the Cloudflare transaction/recovery state machine; only process
// ownership differs from the headless systemd deployment adapter.
export class DesktopDeployment extends NativeDeployment {
  constructor({ directory, gateway, connector, environment, ...options }) {
    super(options); this.directory = directory; this.gateway = gateway; this.connector = connector; this.environment = environment;
    this.receiptPath = join(directory, 'setup-state.json'); this.envPath = join(directory, 'protected-gateway.json');
    this.connectorToken = join(directory, 'tunnel-token.json');
  }
  async preflight(port, owned) {
    if (!owned && await readPrivate(this.envPath)) throw new SetupError('A desktop deployment already exists. Recover or remove it first.', 409);
    if (!owned) await this.availablePort(port);
  }
  async connectorPreflight() {
    const env = this.environment();
    const binary = env.CODEX_WEBUI_CLOUDFLARED || Bun.which('cloudflared', { PATH: env.PATH });
    if (!binary) throw new SetupError('Install cloudflared on this machine before creating a Tunnel. Then refresh the preview.');
    if (await readPrivate(this.connectorToken)) throw new SetupError('A dedicated connector already exists. Remove the managed deployment before creating another one.');
    return binary;
  }
  async installConnector(token, receipt, persist) {
    const binary = await this.connectorPreflight();
    if (typeof token !== 'string' || token.length < 16 || token.length > 16384 || /[\r\n]/.test(token)) throw new SetupError('Invalid connector token');
    receipt.connector = { owner: randomUUID(), binary }; await persist();
    await writePrivate(this.connectorToken, { owner: receipt.connector.owner, token });
    await this.connector.start(binary, this.connectorToken, receipt.connector.owner);
  }
  async removeConnector(receipt) {
    if (!receipt.connector) return;
    const saved = await readPrivate(this.connectorToken);
    if (saved && saved.owner !== receipt.connector.owner) throw new SetupError('Connector ownership changed. Cleanup stopped.', 409);
    await this.connector.stop(); await rm(this.connectorToken, { force: true });
  }
  async install(input, access, receipt, persist) {
    const environment = { ...this.environment(), PORT: String(input.port), HOST: '127.0.0.1', CODEX_WEBUI_AUTH_MODE: 'cloudflare-access', CODEX_WEBUI_PUBLIC_ORIGIN: `https://${input.hostname}`, CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN: access.teamDomain, CODEX_WEBUI_CF_ACCESS_AUD: access.aud, CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL: input.email, CODEX_WEBUI_SETUP_PROBE: randomUUID() + randomUUID() };
    for (const key of ['CODEX_WEBUI_PASSWORD', 'CODEX_WEBUI_ACCESS_TOKEN', 'CODEX_WEBUI_AUTH_STORE']) delete environment[key];
    receipt.local = { owner: randomUUID(), environment: JSON.stringify(environment) }; receipt.probe = environment.CODEX_WEBUI_SETUP_PROBE;
    await persist(); await writePrivate(this.envPath, receipt.local); await this.activate(receipt); await this.ready(input, receipt);
  }
  async assertOwned(receipt, alternatives = []) {
    const current = await readPrivate(this.envPath);
    if (!current || current.owner !== receipt.local?.owner || ![receipt.local?.environment, ...alternatives].includes(current.environment)) throw new SetupError('Desktop deployment configuration changed. Cleanup stopped.', 409);
  }
  async activate(receipt) {
    const env = JSON.parse(receipt.local.environment);
    const current = this.environment();
    for (const key of ['CODEX_WEBUI_CWD', 'CODEX_WEBUI_REVIEW_ROOT', 'CODEX_WEBUI_ENABLE_TERMINAL', 'CODEX_WEBUI_CODEX', 'CODEX_WEBUI_CLOUDFLARED', 'CODEX_WEBUI_NODE', 'PATH']) {
      if (current[key] !== undefined) env[key] = current[key]; else delete env[key];
    }
    await this.gateway.stop(); await this.gateway.start({ env, cwd: env.CODEX_WEBUI_CWD });
  }
  async reconfigure(previous, next, persist) {
    await this.assertOwned(previous);
    const env = { ...JSON.parse(previous.local.environment), PORT: String(next.input.port), CODEX_WEBUI_PUBLIC_ORIGIN: `https://${next.input.hostname}`, CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN: next.teamDomain, CODEX_WEBUI_CF_ACCESS_AUD: next.aud, CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL: next.input.email };
    next.local = { ...previous.local, environment: JSON.stringify(env) }; await persist();
    await writePrivate(this.envPath, next.local); await this.activate(next); await this.ready(next.input, next);
  }
  async restoreConfiguration(previous, next) {
    await this.assertOwned(next, [previous.local.environment]); await writePrivate(this.envPath, previous.local); await this.activate(previous); await this.ready(previous.input, previous);
  }
  async changeIdentity(receipt, email, persist) {
    await this.assertOwned(receipt);
    receipt.local.environment = JSON.stringify({ ...JSON.parse(receipt.local.environment), CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL: email }); receipt.input.email = email;
    await persist(); await writePrivate(this.envPath, receipt.local); await this.activate(receipt); await this.ready(receipt.input, receipt);
  }
  async restoreIdentity(receipt, persist) {
    const old = receipt.identityChange; await this.assertOwned(receipt, [old.local.environment]);
    receipt.local = structuredClone(old.local); receipt.input = structuredClone(old.input); await persist();
    await writePrivate(this.envPath, receipt.local); await this.activate(receipt); await this.ready(receipt.input, receipt);
  }
  async rollback(receipt) {
    if (!receipt.local) return;
    if (await readPrivate(this.envPath)) await this.assertOwned(receipt);
    await this.gateway.stop(); await rm(this.envPath, { force: true });
  }
}
