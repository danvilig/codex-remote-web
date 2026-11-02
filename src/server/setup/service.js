import { SetupCredentials } from './credentials.js';
import { localConnectorIds, connectorSummary } from './connectors.js';
import { hostnameFor } from '../../shared/remote-address.js';
import { randomUUID } from 'node:crypto';
import { digest, previewConfiguration, changeConfiguration, restoreConfiguration } from './configuration.js';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CloudflareClient, SetupError, resourceId, setupInput, matchesHost } from './cloudflare.js';
import { NativeDeployment, atomicPrivate, readOptional } from './deployment.js';
export class SetupService {
  constructor({ deployment = new NativeDeployment(), clientFactory = token => new CloudflareClient(token), publicProbe = fetch, connectorIds = localConnectorIds, credentials } = {}) {
    this.deployment = deployment; this.clientFactory = clientFactory; this.publicProbe = publicProbe; this.connectorIds = connectorIds;
    this.credentials = credentials || new SetupCredentials(deployment.directory);
    this.savedCredential = false; this.restoreAttempted = false; this.credentialError = null;
    this.client = null; this.plan = null; this.accounts = []; this.busy = false;
    this.progress = { phase: 'idle', steps: [], error: null };
  }
  async receipt() { const data = await readOptional(this.deployment.receiptPath); return data ? JSON.parse(data) : null; }
  async save(receipt) { await atomicPrivate(this.deployment.receiptPath, JSON.stringify(receipt, null, 2) + '\n'); }
  lock() { if (this.busy) throw new SetupError('A setup operation is already running.', 409); }
  requireClient() { if (!this.client) throw new SetupError('Connect your Cloudflare account again.', 401); return this.client; }
  async connect(token) {
    this.lock(); const client = this.clientFactory(token);
    const accounts = await client.list('/accounts');
    await this.credentials.save(token);
    this.savedCredential = true; this.restoreAttempted = true; this.credentialError = null;
    this.client = client; this.plan = null;
    this.accounts = accounts.map(({ id, name }) => ({ id, name }));
    return this.accounts;
  }
  disconnect() { this.lock(); this.client = null; this.plan = null; this.accounts = []; this.restoreAttempted = false; this.credentialError = null; }
  async resume() {
    if (this.client || this.busy || this.restoreAttempted) return;
    this.restoreAttempted = true;
    try {
      const token = await this.credentials.read(); this.savedCredential = !!token;
      if (!token) return;
      const client = this.clientFactory(token), accounts = await client.list('/accounts');
      this.accounts = accounts.map(({ id, name }) => ({ id, name })); this.client = client; this.credentialError = null;
    } catch (error) {
      this.savedCredential = true;
      this.credentialError = error instanceof SetupError ? error.message : 'The saved management token could not connect. Retry or replace it.';
    }
  }
  async forgetCredential() { this.disconnect(); await this.credentials.forget(); this.savedCredential = false; }

  async discover(accountId) {
    this.lock(); const client = this.requireClient(), id = resourceId(accountId);
    const [zones, tunnels, org] = await Promise.all([
      client.list(`/zones?account.id=${id}`), client.list(`/accounts/${id}/cfd_tunnel?is_deleted=false`), client.result(`/accounts/${id}/access/organizations`),
    ]);
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(org.auth_domain || '')) throw new SetupError('Complete Zero Trust onboarding and configure a login method in Cloudflare first.');
    const localIds = await this.connectorIds();
    const choices = tunnels.filter(item => item.remote_config && !item.deleted_at);
    const annotated = [];
    // Bound discovery concurrency and avoid an account-wide request burst.
    for (let offset = 0; offset < choices.length; offset += 4) annotated.push(...await Promise.all(choices.slice(offset, offset + 4).map(async ({ id: tunnelId, name, status }) => {
      try { return { id: tunnelId, name, status, ...connectorSummary(await client.result(`/accounts/${id}/cfd_tunnel/${tunnelId}/connections`), localIds), identityAvailable: true }; }
      catch { return { id: tunnelId, name, status, local: false, identityAvailable: false }; }
    })));
    let createAvailable = true;
    try { await this.deployment.connectorPreflight(); } catch { createAvailable = false; }
    return { zones: zones.map(({ id, name }) => ({ id, name })), tunnels: annotated, createAvailable, teamDomain: org.auth_domain };
  }
  async snapshot(input) {
    const client = this.requireClient(), base = `/accounts/${input.accountId}`;
    const create = input.tunnelMode === 'create';
    const [zone, tunnel, config, apps, dns, org, connections] = await Promise.all([
      client.result(`/zones/${input.zoneId}`), create ? null : client.result(`${base}/cfd_tunnel/${input.tunnelId}`), create ? { config: { ingress: [{ service: 'http_status:404' }] } } : client.result(`${base}/cfd_tunnel/${input.tunnelId}/configurations`),
      client.list(`${base}/access/apps`), client.list(`/zones/${input.zoneId}/dns_records?name=${encodeURIComponent(input.hostname)}`), client.result(`${base}/access/organizations`), create ? [] : client.result(`${base}/cfd_tunnel/${input.tunnelId}/connections`),
    ]);
    if (zone.account?.id !== input.accountId || !(input.hostname === zone.name || input.hostname.endsWith(`.${zone.name}`))) throw new SetupError('The hostname must belong to the selected account and zone.');
    if (!create && (!tunnel.remote_config || tunnel.deleted_at || tunnel.status !== 'healthy')) throw new SetupError('Select a healthy, remotely managed Tunnel.');
    if (!Array.isArray(config.config?.ingress) || !config.config.ingress.length) throw new SetupError('The Tunnel has no usable ingress configuration.');
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(org.auth_domain || '')) throw new SetupError('Cloudflare Team Domain is not configured.');
    const relevantApps = apps.filter(app => matchesHost(app.domain, input.hostname) || (app.destinations || []).some(item => matchesHost(item.uri, input.hostname)));
    const identity = create ? null : connectorSummary(connections, await this.connectorIds());
    if (identity?.multipleLocations) throw new SetupError('This Tunnel has connectors on other machines too. Create a dedicated local Tunnel for this loopback service.');
    if (!create && !identity.local && !input.confirmLocal) throw new SetupError('The Tunnel could not be matched to this machine. Confirm its connector runs here, or create a dedicated Tunnel.');
    return { config: config.config, apps: relevantApps, dns, teamDomain: org.auth_domain, identity };
  }
  async preview(raw) {
    this.lock();
    if ('subdomain' in raw) {
      const zone = await this.requireClient().result(`/zones/${resourceId(raw.zoneId)}`);
      try { raw = { ...raw, hostname: hostnameFor(raw.subdomain, zone.name) }; } catch (error) { throw new SetupError(error.message); }
    }
    const input = setupInput(raw), receipt = await this.receipt();
    if (receipt && receipt.phase !== 'removed') {
      if (receipt.phase === 'complete' && digest(receipt.sourceInput || receipt.input) === digest(input)) {
        this.plan = null; return { installed: true, hostname: input.hostname, changes: [], message: 'This workspace is already configured. Run diagnostics or remove the managed deployment.' };
      }
      throw new SetupError('A managed deployment already exists. Run diagnostics or remove it before changing the installation.', 409);
    }
    await this.deployment.preflight(input.port, false);
    if (input.tunnelMode === 'create') await this.deployment.connectorPreflight();
    const snapshot = await this.snapshot(input);
    if (snapshot.apps.length || snapshot.dns.length || snapshot.config.ingress.some(rule => matchesHost(rule.hostname, input.hostname))) throw new SetupError('This hostname already has an Access app, DNS record or Tunnel rule. Choose an unused subdomain to preserve existing resources.', 409);
    if (snapshot.config.ingress.at(-1)?.hostname || snapshot.config.ingress.at(-1)?.path) throw new SetupError('The Tunnel must end with a catch-all ingress rule.');
    const id = randomUUID();
    this.plan = { id, input, snapshot, expiresAt: Date.now() + 600000 };
    return { id, hostname: input.hostname, expiresAt: this.plan.expiresAt, changes: [
      ...(input.tunnelMode === 'create' ? ['Create a dedicated Tunnel and install a local connector without changing existing connectors.'] : []),
      'Create an Access application allowing only the selected email.',
      'Install and start a protected user service on the selected loopback port.',
      'Add one protected route while preserving the existing Tunnel configuration.',
      'Create a proxied DNS record and check the public login boundary.',
    ], service: `127.0.0.1:${input.port}`, teamDomain: snapshot.teamDomain };
  }
  status() { return { ...this.progress, connected: !!this.client, accounts: this.accounts, savedCredential: this.savedCredential, credentialError: this.credentialError }; }
  step(name) { this.progress.steps.push(name); }
  async withDiskLock(fn) {
    const path = join(this.deployment.directory, 'setup.lock');
    await mkdir(this.deployment.directory, { recursive: true, mode: 0o700 });
    try { await writeFile(path, String(process.pid), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { await rm(path); return this.withDiskLock(fn); } }
      throw new SetupError('Another configuration process is using this installation.', 409);
    }
    try { return await fn(); } finally { await rm(path, { force: true }); }
  }
  startApply(id) {
    this.lock(); this.requireClient();
    if (!this.plan || this.plan.id !== id || this.plan.expiresAt <= Date.now()) throw new SetupError('The preview expired. Review the changes again.', 409);
    const plan = this.plan; this.plan = null; this.busy = true;
    this.progress = { phase: 'running', steps: [], error: null };
    this.operation = this.withDiskLock(() => plan.kind === 'configuration' ? changeConfiguration(this, plan) : plan.kind === 'identity' ? this.changeIdentity(plan) : this.apply(plan)).catch(error => { this.progress.phase = 'failed'; this.progress.error = error instanceof SetupError ? error.message : 'Setup could not finish. Run diagnostics before retrying.'; }).finally(() => { this.busy = false; });
  }
  async apply(plan) {
    const client = this.requireClient(), input = structuredClone(plan.input), base = `/accounts/${input.accountId}`;
    const snapshot = await this.snapshot(input);
    if (digest(snapshot) !== digest(plan.snapshot)) throw new SetupError('Cloudflare configuration changed since the preview. Refresh the preview.', 409);
    await this.deployment.preflight(input.port, false);
    const receipt = { version: 1, input, sourceInput: structuredClone(plan.input), phase: 'applying', appName: `Codex Remote Web ${randomUUID()}`, route: null, appId: null, dnsId: null, local: null };
    const persist = () => this.save(receipt);
    await persist();
    try {
      if (input.tunnelMode === 'create') {
        receipt.createdTunnel = true; receipt.createdTunnelName = `${input.tunnelName} (${randomUUID()})`; await persist();
        const tunnel = await client.result(`${base}/cfd_tunnel`, 'POST', { name: receipt.createdTunnelName, config_src: 'cloudflare' });
        input.tunnelId = resourceId(tunnel.id); receipt.createdTunnelId = input.tunnelId; await persist();
        await client.result(`${base}/cfd_tunnel/${input.tunnelId}/configurations`, 'PUT', { config: snapshot.config });
        snapshot.config = (await client.result(`${base}/cfd_tunnel/${input.tunnelId}/configurations`)).config;
        receipt.initialTunnelConfig = snapshot.config; await persist();
        const token = typeof tunnel.token === 'string' ? tunnel.token : await client.result(`${base}/cfd_tunnel/${input.tunnelId}/token`);
        await this.deployment.installConnector(token, receipt, persist);
        await this.waitConnector(input);
        this.step('Dedicated Tunnel connected to this machine');
      }
      const app = await client.result(`${base}/access/apps`, 'POST', { name: receipt.appName, type: 'self_hosted', domain: input.hostname, session_duration: '1h', app_launcher_visible: false, policies: [{ name: 'Workspace owner', decision: 'allow', precedence: 1, include: [{ email: { email: input.email } }] }] });
      receipt.appId = app.id; receipt.aud = app.aud; receipt.teamDomain = snapshot.teamDomain; await persist();
      if (!app.id || typeof app.aud !== 'string' || !app.aud) throw new SetupError('Cloudflare did not return the Access audience.');
      const policies = await client.list(`${base}/access/apps/${app.id}/policies`);
      if (policies.length !== 1 || policies[0].decision !== 'allow' || digest(policies[0].include) !== digest([{ email: { email: input.email } }]) || policies[0].exclude?.length || policies[0].require?.length) throw new SetupError('The Access policy does not match the selected single identity.');
      receipt.policy = policies[0]; await persist();
      this.step('Access application created');
      await this.deployment.install(input, { teamDomain: snapshot.teamDomain, aud: app.aud }, receipt, persist);
      this.step('Protected native service is ready');
      if (receipt.createdTunnel) await this.waitConnector(input);
      else { const identity = connectorSummary(await client.result(`${base}/cfd_tunnel/${input.tunnelId}/connections`), await this.connectorIds()); if (identity.multipleLocations || (!identity.local && !input.confirmLocal)) throw new SetupError('Tunnel connector identity changed. No route was published.', 409); }
      const latest = await client.result(`${base}/cfd_tunnel/${input.tunnelId}/configurations`);
      if (digest(latest.config) !== digest(snapshot.config)) throw new SetupError('The Tunnel changed during setup. No route was added.', 409);
      const apps = await client.list(`${base}/access/apps`);
      if (apps.some(candidate => candidate.id !== receipt.appId && (matchesHost(candidate.domain, input.hostname) || (candidate.destinations || []).some(item => matchesHost(item.uri, input.hostname))))) throw new SetupError('Another Access application was added during setup. No route was published.', 409);
      receipt.route = { hostname: input.hostname, service: `http://127.0.0.1:${input.port}`, originRequest: { httpHostHeader: input.hostname, access: { required: true, teamName: snapshot.teamDomain.split('.')[0], audTag: [app.aud] } } };
      receipt.routeIntent = true; await persist();
      const config = structuredClone(latest.config); config.ingress.unshift(receipt.route);
      await client.result(`${base}/cfd_tunnel/${input.tunnelId}/configurations`, 'PUT', { config });
      const applied = await client.result(`${base}/cfd_tunnel/${input.tunnelId}/configurations`);
      if (!applied.config.ingress.some(rule => digest(rule) === digest(receipt.route))) throw new SetupError('The protected Tunnel route could not be verified.');
      this.step('Protected Tunnel route added');
      // Record intent before the mutation; rollback also discovers a timed-out DNS creation.
      receipt.dnsIntent = true; await persist();
      const dns = await client.result(`/zones/${input.zoneId}/dns_records`, 'POST', { type: 'CNAME', name: input.hostname, content: `${input.tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1, comment: receipt.appName });
      receipt.dnsId = dns.id; await persist(); this.step('DNS record created');
      receipt.phase = 'complete'; await persist();
      this.progress.phase = 'complete'; this.progress.hostname = input.hostname;
      this.progress.verification = await this.publicCheck(input.hostname, snapshot.teamDomain);
    } catch (error) {
      try { await this.cleanup(receipt); receipt.phase = 'removed'; await persist(); this.step('Changes from this attempt were removed'); }
      catch { receipt.phase = 'cleanup-required'; await persist(); this.step('Some changes need cleanup. Use Remove managed deployment after reconnecting.'); }
      throw error;
    }
  }
  async managedIdentity(receipt) {
    const client = this.requireClient(), base = `/accounts/${receipt.input.accountId}/access/apps/${receipt.appId}`;
    const [app, policies] = await Promise.all([client.result(base), client.list(`${base}/policies`)]);
    if (app.name !== receipt.appName || app.domain !== receipt.input.hostname || app.aud !== receipt.aud || policies.length !== 1 || !policies[0].id) throw new SetupError('The managed Access application changed. No update was applied.', 409);
    return { path: `${base}/policies/${resourceId(policies[0].id)}`, policy: policies[0] };
  }
  async previewConfiguration(raw) {
    // Preserve the previous email-only request shape for existing local clients.
    if (raw && Object.keys(raw).length === 1 && Object.hasOwn(raw, 'email')) return this.previewIdentity(raw);
    return previewConfiguration(this, raw);
  }
  async previewIdentity(raw) {
    this.lock();
    if (!raw || Object.keys(raw).some(key => key !== 'email')) throw new SetupError('Only the allowed email can be changed here.');
    const receipt = await this.receipt();
    if (!receipt || receipt.phase !== 'complete' || receipt.identityChange) throw new SetupError('Complete or recover the managed deployment before changing its identity.', 409);
    const email = setupInput({ ...receipt.input, email: raw.email }).email;
    if (email === receipt.input.email) return { unchanged: true };
    await this.deployment.assertOwned(receipt);
    const current = await this.managedIdentity(receipt);
    if (digest(current.policy) !== digest(receipt.policy)) throw new SetupError('The Access policy was edited. No update was applied.', 409);
    const id = randomUUID();
    this.plan = { id, kind: 'identity', email, receiptDigest: digest(receipt), expiresAt: Date.now() + 600000 };
    return { id, hostname: receipt.input.hostname, previousEmail: receipt.input.email, email, changes: ['Update the single allowed email in Cloudflare Access.', 'Restart the protected service with the new identity. Existing connections and web terminals will disconnect.'] };
  }
  async changeIdentity(plan) {
    const receipt = await this.receipt();
    if (!receipt || digest(receipt) !== plan.receiptDigest) throw new SetupError('The deployment changed. Preview the change again.', 409);
    await this.deployment.assertOwned(receipt);
    const current = await this.managedIdentity(receipt);
    if (digest(current.policy) !== digest(receipt.policy)) throw new SetupError('The Access policy was edited. No update was applied.', 409);
    receipt.identityChange = { input: structuredClone(receipt.input), local: structuredClone(receipt.local), policy: structuredClone(receipt.policy), nextPolicy: { ...structuredClone(receipt.policy), include: [{ email: { email: plan.email } }] }, path: current.path };
    const change = structuredClone(receipt.identityChange);
    receipt.phase = 'updating'; const persist = () => this.save(receipt); await persist();
    try {
      await this.deployment.changeIdentity(receipt, plan.email, persist);
      this.step('Protected service identity updated');
      const before = await this.managedIdentity(receipt);
      if (digest(before.policy) !== digest(receipt.policy)) throw new SetupError('The Access policy changed during the update.', 409);
      await this.requireClient().result(current.path, 'PUT', this.policyPayload(receipt.identityChange.nextPolicy));
      const after = await this.managedIdentity(receipt);
      if (!this.sameIdentityPolicy(after.policy, receipt.identityChange.nextPolicy)) throw new SetupError('The updated Access policy could not be verified.', 409);
      receipt.policy = after.policy; receipt.sourceInput = { ...(receipt.sourceInput || receipt.input), email: plan.email };
      delete receipt.identityChange; receipt.phase = 'complete'; await persist();
      this.step('Cloudflare Access identity updated'); this.progress.phase = 'complete'; this.progress.hostname = receipt.input.hostname; this.progress.verification = 'pending';
    } catch (error) {
      receipt.identityChange ||= change;
      try { await this.restoreIdentity(receipt); this.step('Previous identity restored'); }
      catch { receipt.phase = 'change-recovery-required'; await persist(); }
      throw error;
    }
  }
  policyPayload(policy) {
    const keys = ['name','decision','include','exclude','require','precedence','session_duration','approval_groups','approval_required','isolation_required','purpose_justification_prompt','purpose_justification_required'];
    return Object.fromEntries(keys.filter(key => Object.hasOwn(policy, key)).map(key => [key, policy[key]]));
  }
  sameIdentityPolicy(current, expected) {
    // Provider timestamps may change on PUT; compare every policy field except metadata.
    const normalized = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['created_at', 'updated_at'].includes(key)));
    return digest(normalized(current)) === digest(normalized(expected));
  }
  async restoreIdentity(receipt) {
    const change = receipt.identityChange;
    if (!change) throw new SetupError('No identity change needs recovery.', 409);
    const current = await this.managedIdentity(receipt);
    if (!this.sameIdentityPolicy(current.policy, change.policy) && !this.sameIdentityPolicy(current.policy, change.nextPolicy)) throw new SetupError('The Access policy was edited. Recovery stopped to preserve it.', 409);
    await this.deployment.assertOwned(receipt, [change.local.environment]);
    if (!this.sameIdentityPolicy(current.policy, change.policy)) {
      await this.requireClient().result(current.path, 'PUT', this.policyPayload(change.policy));
      if (!this.sameIdentityPolicy((await this.managedIdentity(receipt)).policy, change.policy)) throw new SetupError('The previous Access policy could not be verified.', 409);
    }
    await this.deployment.restoreIdentity(receipt, () => this.save(receipt));
    receipt.policy = structuredClone(change.policy); delete receipt.identityChange; receipt.phase = 'complete'; await this.save(receipt);
  }
  startIdentityRecovery() {
    this.lock(); this.requireClient(); this.busy = true; this.progress = { phase: 'running', steps: [], error: null };
    this.operation = this.withDiskLock(async () => { const receipt = await this.receipt(); if (receipt?.configurationChange) await restoreConfiguration(this, receipt); else await this.restoreIdentity(receipt); this.progress.phase = 'complete'; this.progress.hostname = receipt.input.hostname; this.step('Configuration recovery completed'); }).catch(error => { this.progress.phase = 'failed'; this.progress.error = error instanceof SetupError ? error.message : 'Configuration recovery could not finish. Retry after checking the connection.'; }).finally(() => { this.busy = false; });
  }
  async waitConnector(input) {
    const client = this.requireClient(), path = `/accounts/${input.accountId}/cfd_tunnel/${input.tunnelId}`;
    for (let attempt = 0; attempt < 40; attempt++) {
      const tunnel = await client.result(path);
      const identity = connectorSummary(await client.result(`${path}/connections`), await this.connectorIds());
      if (tunnel.status === 'healthy' && identity.local && !identity.connectedElsewhere) return;
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new SetupError('The dedicated connector did not confirm a local connection. Check cloudflared and its user service.');
  }
  async publicCheck(hostname, teamDomain) {
    try {
      const response = await this.publicProbe(`https://${hostname}/`, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'cache-control': 'no-cache' } });
      const redirect = response.headers.get('location');
      const target = redirect ? new URL(redirect, `https://${hostname}`) : null;
      const protectedLogin = response.status >= 300 && response.status < 400 && target?.protocol === 'https:' && (target.hostname === teamDomain || target.hostname === hostname) && target.pathname.startsWith('/cdn-cgi/access/');
      return protectedLogin ? 'login-required' : 'pending';
    } catch { return 'pending'; }
  }
  async cleanup(receipt) {
    const client = this.requireClient(), { input } = receipt, base = `/accounts/${input.accountId}`;
    if (receipt.routeIntent) {
      const current = await client.result(`${base}/cfd_tunnel/${input.tunnelId}/configurations`);
      const matches = current.config.ingress.filter(rule => rule.hostname === input.hostname);
      if (matches.some(rule => digest(rule) !== digest(receipt.route))) throw new SetupError('The managed Tunnel route was edited. Cleanup stopped to preserve the change.', 409);
      if (matches.length) { const config = structuredClone(current.config); config.ingress = config.ingress.filter(rule => rule.hostname !== input.hostname); await client.result(`${base}/cfd_tunnel/${input.tunnelId}/configurations`, 'PUT', { config }); }
    }
    if (receipt.dnsIntent) {
      const records = await client.list(`/zones/${input.zoneId}/dns_records?name=${encodeURIComponent(input.hostname)}`);
      for (const record of records) {
        if (record.id !== receipt.dnsId && record.comment !== receipt.appName) throw new SetupError('DNS was edited. Cleanup stopped to preserve the change.', 409);
        if (record.type !== 'CNAME' || record.content !== `${input.tunnelId}.cfargotunnel.com`) throw new SetupError('DNS was edited. Cleanup stopped to preserve the change.', 409);
        await client.result(`/zones/${input.zoneId}/dns_records/${record.id}`, 'DELETE');
      }
    }
    if (receipt.appId) {
      // Look up first so cleanup is retryable after a partial removal.
      const apps = await client.list(`${base}/access/apps`);
      const app = apps.find(app => app.id === receipt.appId);
      if (app && (app.name !== receipt.appName || app.domain !== input.hostname || app.aud !== receipt.aud)) throw new SetupError('The Access app was edited. Cleanup stopped to preserve the change.', 409);
      if (app && receipt.policy) { const policies = await client.list(`${base}/access/apps/${app.id}/policies`); if (policies.length !== 1 || digest(policies[0]) !== digest(receipt.policy)) throw new SetupError('The Access policy was edited. Cleanup stopped to preserve the change.', 409); }
      if (app) await client.result(`${base}/access/apps/${app.id}`, 'DELETE');
    } else {
      const apps = await client.list(`${base}/access/apps`);
      for (const app of apps.filter(app => app.name === receipt.appName && app.domain === input.hostname)) await client.result(`${base}/access/apps/${app.id}`, 'DELETE');
    }
    await this.deployment.rollback(receipt);
    if (receipt.createdTunnel) {
      const tunnels = await client.list(`${base}/cfd_tunnel?is_deleted=false`);
      const owned = tunnels.find(tunnel => tunnel.id === (receipt.createdTunnelId || input.tunnelId) || tunnel.name === receipt.createdTunnelName);
      if (owned) {
        if (owned.name !== receipt.createdTunnelName) throw new SetupError('The dedicated Tunnel was edited. Cleanup stopped to preserve it.', 409);
        // Preserve resources if the user added any rules to our dedicated Tunnel.
        if (receipt.initialTunnelConfig) {
          const current = await client.result(`${base}/cfd_tunnel/${owned.id}/configurations`);
          if (digest(current.config) !== digest(receipt.initialTunnelConfig)) throw new SetupError('The dedicated Tunnel now contains other configuration. It was preserved.', 409);
        } else {
          try { const current = await client.result(`${base}/cfd_tunnel/${owned.id}/configurations`); if (current.config?.ingress?.some(rule => rule.hostname || rule.path || rule.service !== 'http_status:404')) throw new SetupError('The dedicated Tunnel now contains other routes. It was preserved.', 409); }
          catch (error) { if (error instanceof SetupError) throw error; }
        }
        await this.deployment.removeConnector(receipt);
        await client.result(`${base}/cfd_tunnel/${owned.id}`, 'DELETE');
      } else await this.deployment.removeConnector(receipt);
    }
  }
  startRemove() {
    this.lock(); this.requireClient(); this.busy = true;
    this.progress = { phase: 'running', steps: [], error: null };
    this.operation = this.withDiskLock(async () => {
      const receipt = await this.receipt();
      if (!receipt || receipt.phase === 'removed') throw new SetupError('No managed deployment was found.');
      if (receipt.identityChange || receipt.configurationChange) throw new SetupError('Recover the pending configuration change before removing this deployment.', 409);
      await this.cleanup(receipt); receipt.phase = 'removed'; await this.save(receipt);
      this.progress.phase = 'removed'; this.step('Managed resources and service removed');
    }).catch(error => { this.progress.phase = 'failed'; this.progress.error = error instanceof SetupError ? error.message : 'Cleanup could not finish. Reconnect and run diagnostics.'; }).finally(() => { this.busy = false; });
  }
  async diagnose() {
    this.lock(); const receipt = await this.receipt();
    if (!receipt || receipt.phase === 'removed') return { installed: false, checks: [] };
    const checks = [], client = this.requireClient();
    const check = async (label, fn) => { try { await fn(); checks.push({ label, ok: true }); } catch { checks.push({ label, ok: false }); } };
    await check('Native service requires Access', () => this.deployment.ready(receipt.input, receipt));
    await check('Cloudflare resources match this deployment', async () => {
      const state = await this.snapshot({ ...receipt.input, tunnelMode: undefined, confirmLocal: true });
      if (!state.apps.some(app => app.id === receipt.appId && app.aud === receipt.aud) || !state.dns.some(record => record.id === receipt.dnsId && record.proxied && record.content === `${receipt.input.tunnelId}.cfargotunnel.com`) || !state.config.ingress.some(rule => digest(rule) === digest(receipt.route))) throw new Error();
      const app = await client.result(`/accounts/${receipt.input.accountId}/access/apps/${receipt.appId}`);
      const policies = await client.list(`/accounts/${receipt.input.accountId}/access/apps/${receipt.appId}/policies`);
      if (app.domain !== receipt.input.hostname || policies.length !== 1 || policies[0].decision !== 'allow' || JSON.stringify(policies[0].include) !== JSON.stringify([{ email: { email: receipt.input.email } }])) throw new Error();
    });
    const verification = await this.publicCheck(receipt.input.hostname, receipt.teamDomain);
    checks.push({ label: 'Public address redirects to Access login', ok: verification === 'login-required' });
    return { installed: true, hostname: receipt.input.hostname, phase: receipt.phase, checks };
  }
}
