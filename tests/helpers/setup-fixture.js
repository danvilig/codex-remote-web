import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
export const INPUT = { accountId: 'account123', zoneId: 'zone12345', tunnelId: 'tunnel-12345', hostname: 'codex.example.com', email: 'owner@example.com', port: 8900 };
export const TOKEN = 'fixture-management-token-secret';
export function setupFixture(directory) {
  const state = { accounts: [{ id: INPUT.accountId, name: 'Personal account' }], zones: [{ id: INPUT.zoneId, name: 'example.com', account: { id: INPUT.accountId } }], tunnels: [{ id: INPUT.tunnelId, name: 'Existing Tunnel', status: 'healthy', remote_config: true }], extraConfigs: {}, connectorInstalled: false, org: { auth_domain: 'fixture.cloudflareaccess.com' }, config: { ingress: [{ hostname: 'other.example.com', service: 'http://localhost:8080', originRequest: { connectTimeout: 20 } }, { service: 'http_status:404' }], originRequest: { connectTimeout: 30 }, 'warp-routing': { enabled: true } }, apps: [], dns: [], calls: [], serial: 0, fail: null, installed: false, installError: false, beforeDns: null };
  const copy = value => structuredClone(value);
  const client = {
    async result(path, method = 'GET', body) {
      state.calls.push({ path, method, body: copy(body) });
      if (state.fail?.(path, method)) throw new Error('Fixture operation failed');
      if (path.startsWith('/zones/') && !path.includes('/dns_records')) return copy(state.zones.find(zone => path === `/zones/${zone.id}`));
      if (path.endsWith('/organizations')) return copy(state.org);
      if (path.endsWith('/cfd_tunnel') && method === 'POST') { const tunnel = { id: 'new-tunnel-12345', name: body.name, status: 'healthy', remote_config: true }; state.tunnels.push(tunnel); return copy(tunnel); }
      const tunnelId = path.match(/\/cfd_tunnel\/([^/]+)/)?.[1];
      if (path.endsWith('/connections')) return [{ id: 'local-connector', conns: [{ client_id: 'local-connector' }] }];
      if (path.endsWith('/token')) return 'fixture-connector-token-secret';
      if (tunnelId && path.endsWith(`/cfd_tunnel/${tunnelId}`)) { const tunnel = state.tunnels.find(item => item.id === tunnelId); if (method === 'DELETE') state.tunnels = state.tunnels.filter(item => item.id !== tunnelId); return copy(tunnel); }
      if (path.endsWith('/configurations')) { if (method === 'PUT') {
        if (!state.installed && body.config.ingress.some(rule => rule.hostname === INPUT.hostname)) throw new Error('Route published before protected service');
        if(tunnelId === INPUT.tunnelId) state.config = copy(body.config); else state.extraConfigs[tunnelId] = copy(body.config);
      } return { config: copy(tunnelId === INPUT.tunnelId ? state.config : state.extraConfigs[tunnelId]) }; }
      if (path.endsWith('/access/apps') && method === 'POST') { const app = { ...copy(body), policies: body.policies.map(policy => ({...copy(policy),id:'policy12345'})), id: state.serial ? `app12345-${state.serial}` : 'app12345', aud: `aud-fixture-${state.serial++}` }; state.apps.push(app); return copy(app); }
      if (path.endsWith('/dns_records') && method === 'POST') { state.beforeDns?.(); const dns = { ...copy(body), id: `dns12345-${state.serial++}`, zone_id: path.split('/')[2] }; state.dns.push(dns); return copy(dns); }
      const policyMatch = path.match(/\/access\/apps\/([^/]+)\/policies\/([^/]+)$/);
      if (policyMatch && method === 'PUT') { const app = state.apps.find(app => app.id === policyMatch[1]); app.policies = [{...copy(body),id:policyMatch[2]}]; return copy(app.policies[0]); }
      const appId = path.match(/\/access\/apps\/([^/]+)$/)?.[1];
      if (appId) { const app = state.apps.find(app => app.id === appId); if (method === 'DELETE') state.apps = state.apps.filter(app => app.id !== appId); return copy(app); }
      const dnsId = path.match(/\/dns_records\/([^/]+)$/)?.[1];
      if (dnsId && method === 'PATCH') { const record = state.dns.find(item => item.id === dnsId); Object.assign(record, copy(body)); return copy(record); }
      if (dnsId && method === 'DELETE') { state.dns = state.dns.filter(dns => dns.id !== dnsId); return {}; }
      throw new Error(`Unhandled fixture path ${method} ${path}`);
    },
    async list(path) {
      if (path === '/accounts') return copy(state.accounts);
      if (path.startsWith('/zones?')) return copy(state.zones);
      if (path.includes('/cfd_tunnel?')) return copy(state.tunnels);
      if (path.endsWith('/access/apps')) return copy(state.apps);
      if (path.includes('/dns_records?')) return copy(state.dns.filter(record => record.name === new URL('https://fixture'+path).searchParams.get('name') && (!record.zone_id || record.zone_id === path.split('/')[2])));
      if (path.endsWith('/policies')) return copy(state.apps.find(app => path.match(/\/access\/apps\/([^/]+)\/policies$/)?.[1] === app.id)?.policies || []);
      throw new Error(`Unhandled fixture list ${path}`);
    },
  };
  const deployment = {
    directory, receiptPath: join(directory, 'setup-state.json'),
    async preflight() { await mkdir(directory, { recursive: true }); },
    async install(input, access, receipt, persist) { if (state.installError) throw new Error('Fixture service failure'); receipt.local = { fixture: true }; await persist(); state.installed = true; },
    async assertOwned() {},
    async availablePort() {},
    async reconfigure(previous,next,persist) { next.local=copy(previous.local); await persist(); if(state.installError)throw new Error('Fixture update failure'); state.activeInput=copy(next.input); },
    async restoreConfiguration(previous,next,persist) { state.activeInput=copy(previous.input); await persist(); },
    async changeIdentity(receipt, email, persist) { if (state.installError) throw new Error('Fixture update failure'); receipt.input.email=email; await persist(); },
    async restoreIdentity(receipt,persist) { receipt.input=copy(receipt.identityChange.input); receipt.local=copy(receipt.identityChange.local); await persist(); },
    async ready() { if (!state.installed) throw new Error('Service not installed'); },
    async rollback() { state.installed = false; },
    async connectorPreflight() { return '/fixture/cloudflared'; },
    async installConnector(token, receipt, persist) { if(token !== 'fixture-connector-token-secret')throw new Error('Wrong connector token'); receipt.connector = { unit: 'fixture-unit' }; await persist(); state.connectorInstalled = true; },
    async removeConnector() { state.connectorInstalled = false; },
  };
  const clientFactory = token => { if (token !== TOKEN) throw new Error('Invalid fixture token'); return client; };
  const publicProbe = async () => new Response('', { status: 302, headers: { location: 'https://fixture.cloudflareaccess.com/cdn-cgi/access/login/codex.example.com' } });
  return { state, client, deployment, clientFactory, publicProbe, connectorIds: async () => ['local-connector'], receipt: async () => JSON.parse(await readFile(deployment.receiptPath, 'utf8')) };
}
