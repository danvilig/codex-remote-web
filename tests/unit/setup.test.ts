import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SetupService } from '../../src/server/setup/service.js';
import { CloudflareClient, setupInput } from '../../src/server/setup/cloudflare.js';
import { NativeDeployment } from '../../src/server/setup/deployment.js';
import { localSetupRequest, startSetupServer } from '../../src/server/setup/http.js';
import { INPUT, TOKEN, setupFixture } from '../helpers/setup-fixture.js';
async function fixture(fn) { const dir = await mkdtemp(join(tmpdir(), 'crw-setup-')); try { const f = setupFixture(dir), service = new SetupService(f); await service.connect(TOKEN); await fn({ ...f, service, dir }); } finally { await rm(dir, { recursive: true, force: true }); } }
async function apply(service) { const plan = await service.preview(INPUT); service.startApply(plan.id); await service.operation; }
test('setup validates input and Cloudflare errors never reveal management tokens', async () => {
  expect(() => setupInput({ ...INPUT, hostname: 'https://example.com' })).toThrow();
  expect(() => setupInput({ ...INPUT, port: 80 })).toThrow();
  expect(() => new CloudflareClient('short')).toThrow();
  const client = new CloudflareClient(TOKEN, async () => new Response(JSON.stringify({ success: false, errors: [{ message: TOKEN, code: 10000 }, {code: TOKEN}] }), { status: 403 }));
  await expect(client.list('/accounts')).rejects.toThrow('permissions');
  try { await client.list('/accounts'); } catch (error) { expect(error.message).not.toContain(TOKEN); expect(error.details).toEqual({ operation: 'List Cloudflare accounts', permission: 'Account → Account Settings → Read', httpStatus: 403, codes: [10000] }); expect(JSON.stringify(error.details)).not.toContain(TOKEN); }
});
test('setup management API paginates resources without accepting an arbitrary API host', async () => {
  const calls = [], client = new CloudflareClient(TOKEN, async url => { calls.push(String(url)); const page = new URL(url).searchParams.get('page'); return Response.json({ success: true, result: [{ id: page }], result_info: { total_pages: 2 } }); });
  expect(await client.list('/accounts')).toEqual([{ id: '1' }, { id: '2' }]);
  expect(calls.every(url => url.startsWith('https://api.cloudflare.com/client/v4/'))).toBe(true);
});
test('local setup rejects non-loopback Host, cross-origin, proxy and missing mutation headers', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:8899', origin: 'http://127.0.0.1:8899', 'content-type': 'application/json', 'x-setup-request': '1' } };
  expect(localSetupRequest(req, true)).toBe(true);
  for (const headers of [{ host: 'evil.example' }, { origin: 'https://evil.example' }, { 'cf-connecting-ip': '127.0.0.1' }, { 'x-forwarded-for': '127.0.0.1' }, { 'sec-fetch-site': 'cross-site' }, { 'x-setup-request': '' }]) expect(localSetupRequest({ ...req, headers: { ...req.headers, ...headers } }, true)).toBe(false);
  expect(localSetupRequest({ ...req, socket: { remoteAddress: '192.0.2.1' } }, true)).toBe(false);
});
test('preview is read-only; deployment preserves all other Tunnel routes and settings, is idempotent and stores no API token', async () => fixture(async ({ service, state, receipt, dir }) => {
  const original = structuredClone(state.config), preview = await service.preview(INPUT);
  expect(state.calls.every(call => call.method === 'GET')).toBe(true);
  service.startApply(preview.id);
  expect(() => service.startApply(preview.id)).toThrow();
  await service.operation;
  expect(service.status().phase).toBe('complete'); expect(service.status().verification).toBe('login-required');
  expect(state.config.ingress.filter(rule => rule.hostname !== INPUT.hostname)).toEqual(original.ingress);
  expect(state.config.originRequest).toEqual(original.originRequest); expect(state.config['warp-routing']).toEqual(original['warp-routing']);
  expect(state.config.ingress.find(rule => rule.hostname === INPUT.hostname).originRequest.access.required).toBe(true);
  const record = await receipt(); expect(record.input.email).toBe(INPUT.email);
  expect((await stat(join(dir, 'setup-state.json'))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(dir, 'setup-state.json'), 'utf8')).not.toContain(TOKEN);
  expect((await service.preview(INPUT)).installed).toBe(true);
  expect((await service.diagnose()).checks.every(check => check.ok)).toBe(true);
  state.config.ingress.unshift({ hostname: 'later.example.com', service: 'http://localhost:9000' });
  service.startRemove(); await service.operation;
  expect(service.status().phase).toBe('removed'); expect(state.config.ingress[0].hostname).toBe('later.example.com'); expect(state.apps).toHaveLength(0); expect(state.dns).toHaveLength(0); expect(state.installed).toBe(false);
}));
test('preview refuses existing resources, wildcard routes and unrelated zones', async () => fixture(async ({ service, state }) => {
  state.config.ingress.unshift({ hostname: '*.example.com', service: 'http://localhost:1' });
  await expect(service.preview(INPUT)).rejects.toThrow('already');
  state.config.ingress.shift(); state.dns.push({ name: INPUT.hostname }); await expect(service.preview(INPUT)).rejects.toThrow('already');
  state.dns = []; await expect(service.preview({ ...INPUT, hostname: 'other.invalid.com' })).rejects.toThrow('belong');
}));
test('changes since preview abort without creating cloud resources', async () => fixture(async ({ service, state }) => {
  const preview = await service.preview(INPUT); state.config.ingress.unshift({ hostname: 'new.example.com', service: 'http_status:404' });
  service.startApply(preview.id); await service.operation;
  expect(service.status().phase).toBe('failed'); expect(state.apps).toHaveLength(0); expect(state.calls.every(call => call.method === 'GET')).toBe(true);
}));
test('failed protected service never publishes a route and cleans up its Access app', async () => fixture(async ({ service, state }) => {
  state.installError = true; await apply(service);
  expect(service.status().phase).toBe('failed'); expect(state.apps).toHaveLength(0); expect(state.dns).toHaveLength(0);
  expect(state.calls.some(call => call.method === 'PUT')).toBe(false);
}));
test('a failed DNS request removes only this attempt and keeps concurrent unrelated edits', async () => fixture(async ({ service, state }) => {
  state.fail = (path, method) => { if (path.endsWith('/dns_records') && method === 'POST') { state.config.ingress.unshift({ hostname: 'concurrent.example.com', service: 'http://localhost:7070' }); return true; } return false; };
  await apply(service);
  expect(service.status().phase).toBe('failed'); expect(state.config.ingress[0].hostname).toBe('concurrent.example.com'); expect(state.config.ingress.some(rule => rule.hostname === INPUT.hostname)).toBe(false); expect(state.apps).toHaveLength(0); expect(state.installed).toBe(false);
}));
test('cleanup preserves manually edited managed routes and a new process can resume from its private receipt', async () => fixture(async f => {
  await apply(f.service); f.state.config.ingress.find(rule => rule.hostname === INPUT.hostname).service = 'http://localhost:9999';
  const recovered = new SetupService(f); await recovered.connect(TOKEN); recovered.startRemove(); await recovered.operation;
  expect(recovered.status().phase).toBe('failed'); expect(f.state.apps).toHaveLength(1); expect(f.state.dns).toHaveLength(1); expect(f.state.installed).toBe(true);
}));
test('native installer writes private environment and unit, strips legacy passwords, checks the exact protected deployment', async () => {
  const home = await mkdtemp(join(tmpdir(), 'crw-native-'));
  try {
    const root = join(home, 'release'); await mkdir(join(root,'dist'), { recursive: true }); await writeFile(join(root,'dist/server.js'), '');
    const calls = [], env = { HOME: home, PATH: '/usr/bin:/custom%bin', CODEX_HOME: '/existing/state', CODEX_WEBUI_CWD: '/existing/project', CODEX_WEBUI_PASSWORD: 'OLD_SECRET' };
    const deployment = new NativeDeployment({ env, root, run: async args => { calls.push(args); }, probe: async (url, options) => { expect(options.headers['x-setup-probe']).toBe(receipt.probe); return Response.json({ mode: 'cloudflare-access', publicOrigin: `https://${INPUT.hostname}`, audience: 'aud-fixture', allowedEmail: INPUT.email }); } });
    // Bind an ephemeral probe port so a real deployment on 8900 cannot affect this test.
    const receipt = { aud: 'aud-fixture' }; await deployment.preflight(0, false); await deployment.install(INPUT, { aud: receipt.aud, teamDomain: 'fixture.cloudflareaccess.com' }, receipt, async () => {});
    const text = await readFile(deployment.envPath, 'utf8'); expect(text).not.toContain('OLD_SECRET'); expect(text).toContain('/existing/state'); expect(text).toContain('/custom%bin'); expect((await stat(deployment.envPath)).mode & 0o777).toBe(0o600);
    expect(calls.some(args => args.includes('enable'))).toBe(true);
    expect(receipt.local.unit).toContain(`EnvironmentFile=${deployment.envPath}\n`);
    expect(receipt.local.unit).not.toContain(`EnvironmentFile="${deployment.envPath}"`);
    if (Bun.which('systemd-analyze')) {
      const proc = Bun.spawn(['systemd-analyze','--user','verify',deployment.unitPath], {stdout:'pipe',stderr:'pipe'});
      const [code, output] = await Promise.all([proc.exited,new Response(proc.stderr).text()]);
      expect(code, output).toBe(0);
    }
    await writeFile(deployment.unitPath, 'manual change'); await expect(deployment.rollback(receipt)).rejects.toThrow('changed');
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('setup sessions use single-use credentials, HttpOnly cookies and CSRF, and never return management tokens', async () => fixture(async f => {
  const { server, url } = await startSetupServer({ service: f.service });
  try {
    const origin = new URL(url).origin, key = new URLSearchParams(new URL(url).hash.slice(1)).get('setup');
    const request = (path, body, extra = {}) => fetch(origin + '/api/setup/' + path, { method: body ? 'POST' : 'GET', headers: { origin, 'content-type': 'application/json', 'x-setup-request': '1', ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await request('status')).status).toBe(401);
    const response = await request('session', { key }), data = await response.json(), cookie = response.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
    expect((await request('session', { key })).status).toBe(403);
    expect((await request('connect', { token: TOKEN }, { cookie })).status).toBe(403);
    const auth = { cookie, 'x-setup-csrf': data.csrf };
    expect((await request('connect', { token: TOKEN }, auth)).status).toBe(200);
    const status = await request('status', null, auth); expect(await status.text()).not.toContain(TOKEN);
    expect((await request('lock', {}, auth)).status).toBe(200); expect(f.service.client).toBe(null);
    expect((await request('status', null, auth)).status).toBe(401);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('idle session expiry releases the API client and rejects old cookies', async () => fixture(async f => {
  let time = 0;
  const { server, url } = await startSetupServer({ service: f.service, now: () => time });
  try {
    const origin = new URL(url).origin, key = new URLSearchParams(new URL(url).hash.slice(1)).get('setup');
    const post = body => fetch(origin + '/api/setup/session', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-setup-request': '1' }, body: JSON.stringify(body) });
    expect((await post({ key: 'é'.repeat(43) })).status).toBe(403);
    const response = await post({ key }), { csrf } = await response.json(), cookie = response.headers.get('set-cookie');
    // Attach a credential after establishing the session.
    await f.service.connect(TOKEN); time += 1800001;
    expect((await fetch(origin + '/api/setup/status', { headers: { cookie, 'x-setup-csrf': csrf } })).status).toBe(401);
    expect(f.service.client).toBe(null);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('connector matching uses active invocation UUIDs and never uses process tokens or IP guesses', async () => {
  const { localConnectorIds, connectorSummary } = await import('../../src/server/setup/connectors.js');
  const uuid = '5970860a-f843-4376-9b19-9659b659f394', calls = [];
  const ids = await localConnectorIds({ command: async (bin, args) => {
    calls.push({ bin, args });
    if (bin === 'systemctl') return { stdout: 'ActiveState=active\nInvocationID=0123456789abcdef0123456789abcdef\n' };
    return { stdout: `Generated Connector ID: ${uuid}\n` };
  } });
  expect(ids).toEqual([uuid]); expect(calls.every(call => !call.args.includes('--token') && !call.args.includes('--token-file'))).toBe(true);
  expect(connectorSummary([{ id: uuid, conns: [{}] }], ids).local).toBe(true);
  expect(connectorSummary([{ id: 'elsewhere', conns: [{origin_ip:'127.0.0.1'}] }], ids).local).toBe(false);
  expect(connectorSummary([{ id: uuid, conns: [{}] },{ id: 'elsewhere', conns: [{}] }], ids).multipleLocations).toBe(true);
  expect(await localConnectorIds({command:async()=>{throw new Error('denied');}})).toEqual([]);
});
test('discovery recommends matching connectors; unknown hosts require confirmation and mixed replicas are blocked', async () => fixture(async f => {
  expect((await f.service.discover(INPUT.accountId)).tunnels[0].local).toBe(true);
  f.service.connectorIds = async () => [];
  expect((await f.service.discover(INPUT.accountId)).tunnels[0].local).toBe(false);
  await expect(f.service.preview(INPUT)).rejects.toThrow('could not be matched');
  expect((await f.service.preview({...INPUT, confirmLocal:true})).id).toBeTruthy();
  const original = f.client.result;
  f.client.result = async (path,...args) => path.endsWith('/connections') ? [{id:'local-connector',conns:[{}]},{id:'other-connector',conns:[{}]}] : original(path,...args);
  f.service.connectorIds = async () => ['local-connector'];
  await expect(f.service.preview({...INPUT, confirmLocal:true})).rejects.toThrow('other machines');
}));
test('subdomain and @ use the selected zone, ignore client suffixes, preserve apex DNS and reject full-domain input', async () => fixture(async f => {
  const { hostnameFor } = await import('../../src/shared/remote-address.js');
  expect(hostnameFor('codex','example.com')).toBe('codex.example.com');
  expect(hostnameFor('dev.codex','example.com')).toBe('dev.codex.example.com');
  expect(hostnameFor('@','example.com')).toBe('example.com');
  for(const value of ['codex.example.com','https://evil.test','-bad','a..b','']) expect(()=>hostnameFor(value,'example.com')).toThrow();
  expect((await f.service.preview({...INPUT,hostname:'evil.invalid',subdomain:'codex'})).hostname).toBe(INPUT.hostname);
  expect((await f.service.preview({...INPUT,subdomain:'@'})).hostname).toBe('example.com');
  f.state.dns.push({name:'example.com',type:'A'});
  // Fixture DNS list filters this hostname; make it return the root record too.
  const original = f.client.list;
  f.client.list = path => path.includes('dns_records?') ? Promise.resolve(f.state.dns) : original(path);
  await expect(f.service.preview({...INPUT,subdomain:'@'})).rejects.toThrow('already');
}));
test('a new dedicated Tunnel is read-only in preview, connects locally, keeps connector token private and is fully removable', async () => fixture(async f => {
  const input={...INPUT,tunnelMode:'create',tunnelName:'Personal WebUI',subdomain:'codex'};
  const original=structuredClone(f.state.config), preview=await f.service.preview(input);
  expect(f.state.tunnels).toHaveLength(1); expect(f.state.connectorInstalled).toBe(false);
  f.service.startApply(preview.id); await f.service.operation;
  expect(f.service.status().phase).toBe('complete'); expect(f.state.tunnels).toHaveLength(2);
  expect(f.state.connectorInstalled).toBe(true); expect(f.state.config).toEqual(original);
  expect(f.state.dns[0].content).toBe('new-tunnel-12345.cfargotunnel.com');
  const receipt=await f.receipt(); expect(receipt.createdTunnel).toBe(true); expect(JSON.stringify(receipt)).not.toContain('fixture-connector-token-secret');
  expect((await f.service.preview(input)).installed).toBe(true);
  expect((await f.service.diagnose()).checks.every(check=>check.ok)).toBe(true);
  f.service.startRemove(); await f.service.operation;
  expect(f.service.status().phase).toBe('removed'); expect(f.state.tunnels).toHaveLength(1); expect(f.state.connectorInstalled).toBe(false); expect(f.state.config).toEqual(original);
}));
test('new-Tunnel connector failures clean up owned cloud resources without touching the original Tunnel', async () => fixture(async f => {
  f.deployment.installConnector=async()=>{throw new Error('fixture connector failure');};
  const plan=await f.service.preview({...INPUT,tunnelMode:'create'}); f.service.startApply(plan.id); await f.service.operation;
  expect(f.service.status().phase).toBe('failed'); expect(f.state.tunnels).toHaveLength(1); expect(f.state.apps).toHaveLength(0);
  expect(f.state.config.ingress[0].hostname).toBe('other.example.com');
}));
test('native dedicated connector uses a private token file and its own unit; cleanup preserves manual unit changes', async () => {
  const home=await mkdtemp(join(tmpdir(),'crw-connector-'));
  try {
    // Provide an inert executable in an isolated PATH; no connector is actually run.
    const bin=join(home,'bin');await mkdir(bin);await writeFile(join(bin,'cloudflared'),'#!/bin/sh\nexit 0\n',{mode:0o700});
    const calls=[], deployment=new NativeDeployment({env:{HOME:home,PATH:bin},run:async args=>{calls.push(args);}});
    const receipt={}; await deployment.installConnector('private-connector-token-fixture',receipt,async()=>{});
    expect((await stat(deployment.connectorToken)).mode & 0o777).toBe(0o600);
    expect(receipt.connector.unit).toContain('codex-remote-web/tunnel-token');
    expect(JSON.stringify(receipt)).not.toContain('private-connector-token-fixture');
    expect(calls.some(args=>args.includes('codex-remote-web-tunnel.service'))).toBe(true);
    if(Bun.which('systemd-analyze')){const proc=Bun.spawn(['systemd-analyze','--user','verify',deployment.connectorUnit],{stdout:'pipe',stderr:'pipe'});const [code,error]=await Promise.all([proc.exited,new Response(proc.stderr).text()]);expect(code,error).toBe(0);}
    await writeFile(deployment.connectorUnit,'manual edit');await expect(deployment.removeConnector(receipt)).rejects.toThrow('edited');
    await writeFile(deployment.connectorUnit,receipt.connector.unit);await deployment.removeConnector(receipt);
    expect(await readFile(deployment.connectorToken).catch(()=>null)).toBe(null);
  } finally {await rm(home,{recursive:true,force:true});}
});

test('cleanup leaves a dedicated connector serving user-added routes running', async () => fixture(async f => {
  const plan=await f.service.preview({...INPUT,tunnelMode:'create'});f.service.startApply(plan.id);await f.service.operation;
  expect(f.service.status().phase).toBe('complete');
  f.state.extraConfigs['new-tunnel-12345'].ingress.unshift({hostname:'added.example.com',service:'http://localhost:7000'});
  f.service.startRemove();await f.service.operation;
  expect(f.service.status().phase).toBe('failed');expect(f.state.connectorInstalled).toBe(true);
  expect(f.state.tunnels).toHaveLength(2);
}));

test('validated management tokens persist privately and restore in a fresh process without entering the token again', async () => fixture(async f => {
  const path = join(f.dir, 'management-token.json');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(f.dir)).mode & 0o777).toBe(0o700);
  f.service.disconnect(); const fresh = new SetupService(f); await fresh.resume();
  expect(fresh.status().connected).toBe(true); expect(fresh.status().savedCredential).toBe(true);
  expect(JSON.stringify(fresh.status())).not.toContain(TOKEN);
  await fresh.forgetCredential(); expect(await readFile(path).catch(()=>null)).toBeNull();
  const another = new SetupService(f); await another.resume(); expect(another.status().connected).toBe(false);
}));

test('saved credentials reject exposed files and symlinks, and failed replacement preserves the previous token', async () => fixture(async f => {
  const { chmod, symlink } = await import('node:fs/promises');
  const path=join(f.dir,'management-token.json');
  await expect(f.service.connect('invalid-token-value')).rejects.toThrow();
  expect(JSON.parse(await readFile(path,'utf8')).token).toBe(TOKEN);
  await chmod(path,0o644); const exposed=new SetupService(f); await exposed.resume();
  expect(exposed.status().connected).toBe(false); expect(exposed.status().credentialError).toContain('securely');
  await rm(path); const target=join(f.dir,'unrelated-file'); await writeFile(target,'private'); await symlink(target,path);
  const linked=new SetupService(f); await linked.resume(); expect(linked.status().connected).toBe(false);
  await linked.forgetCredential(); expect(await readFile(target,'utf8')).toBe('private');
}));

test('identity change previews without mutations, updates both native and Access identity, and remains removable', async () => fixture(async f => {
  await apply(f.service); const mutations=f.state.calls.filter(call=>call.method!=='GET').length;
  const preview=await f.service.previewIdentity({email:'new-owner@example.com'});
  expect(preview.previousEmail).toBe(INPUT.email); expect(f.state.calls.filter(call=>call.method!=='GET')).toHaveLength(mutations);
  f.service.startApply(preview.id); await f.service.operation;
  expect(f.service.status().phase).toBe('complete'); expect((await f.receipt()).input.email).toBe('new-owner@example.com');
  expect(f.state.apps[0].policies[0].include).toEqual([{email:{email:'new-owner@example.com'}}]);
  expect((await f.service.previewIdentity({email:'new-owner@example.com'})).unchanged).toBe(true);
  expect((await f.service.diagnose()).checks.every(check=>check.ok)).toBe(true);
  f.service.startRemove(); await f.service.operation; expect(f.service.status().phase).toBe('removed');
}));

test('identity updates recover an uncertain policy response and can resume recovery after a process restart', async () => fixture(async f => {
  await apply(f.service); const original=f.client.result; let uncertain=true, offline=false;
  f.client.result=async(path,...args)=>{
    if(offline)throw new Error('offline');
    const value=await original(path,...args);
    if(uncertain && args[0]==='PUT' && path.includes('/policies/')){uncertain=false;offline=true;throw new Error('response lost')}
    return value;
  };
  const preview=await f.service.previewIdentity({email:'new-owner@example.com'});f.service.startApply(preview.id);await f.service.operation;
  expect(f.service.status().phase).toBe('failed');expect((await f.receipt()).phase).toBe('change-recovery-required');
  expect((await f.receipt()).identityChange).toBeTruthy();
  offline=false;const recovered=new SetupService(f);await recovered.resume();recovered.startIdentityRecovery();await recovered.operation;
  expect(recovered.status().phase).toBe('complete');expect((await f.receipt()).input.email).toBe(INPUT.email);
  expect((await f.receipt()).identityChange).toBeUndefined();expect(f.state.apps[0].policies[0].include).toEqual([{email:{email:INPUT.email}}]);
}));

test('identity change refuses concurrent edits and never falls back to deleting the deployment', async () => fixture(async f => {
  await apply(f.service);const preview=await f.service.previewIdentity({email:'next@example.com'});
  f.state.apps[0].policies[0].name='Manually edited';const mutations=f.state.calls.filter(call=>call.method!=='GET').length;
  f.service.startApply(preview.id);await f.service.operation;
  expect(f.service.status().phase).toBe('failed');expect(f.state.calls.filter(call=>call.method!=='GET')).toHaveLength(mutations);
  expect(f.state.apps).toHaveLength(1);expect(f.state.dns).toHaveLength(1);
}));

test('native identity update preserves other environment settings and refuses manual edits', async () => {
  const home=await mkdtemp(join(tmpdir(),'crw-identity-'));
  try {
    const root=join(home,'release');await mkdir(join(root,'dist'),{recursive:true});await writeFile(join(root,'dist/server.js'),'');
    const calls=[], receipt={aud:'fixture-aud',input:structuredClone(INPUT)};
    const deployment=new NativeDeployment({env:{HOME:home,PATH:'/usr/bin',CODEX_WEBUI_ENABLE_TERMINAL:'true'},root,run:async args=>{calls.push(args);},probe:async()=>Response.json({mode:'cloudflare-access',publicOrigin:`https://${INPUT.hostname}`,audience:receipt.aud,allowedEmail:receipt.input.email})});
    await deployment.install(INPUT,{aud:receipt.aud,teamDomain:'fixture.cloudflareaccess.com'},receipt,async()=>{});
    const before=structuredClone(receipt.local);receipt.identityChange={local:before,input:structuredClone(INPUT)};
    await deployment.changeIdentity(receipt,'next@example.com',async()=>{});
    const environment=await readFile(deployment.envPath,'utf8');expect(environment).toContain('CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL="next@example.com"');expect(environment).toContain('CODEX_WEBUI_ENABLE_TERMINAL="true"');
    expect(receipt.local.unit).toBe(before.unit);expect(calls.some(args=>args.includes('restart'))).toBe(true);
    await deployment.restoreIdentity(receipt,async()=>{});expect(await readFile(deployment.envPath,'utf8')).toBe(before.environment);
    await writeFile(deployment.envPath,'manual edit');await expect(deployment.changeIdentity(receipt,'another@example.com',async()=>{})).rejects.toThrow('changed');
    expect(await readFile(deployment.envPath,'utf8')).toBe('manual edit');
  }finally{await rm(home,{recursive:true,force:true})}
});

function addMigrationChoices(state) {
  state.zones.push({id:'zone-other123',name:'example.net',account:{id:INPUT.accountId}});
  state.tunnels.push({id:'tunnel-other123',name:'Second local Tunnel',status:'healthy',remote_config:true});
  state.extraConfigs['tunnel-other123']={ingress:[{hostname:'keep.example.net',service:'http://localhost:9000'},{service:'http_status:404'}], 'warp-routing':{enabled:false}};
}
async function migrate(f,input) { const plan=await f.service.previewConfiguration(input);f.service.startApply(plan.id);await f.service.operation;return plan; }
for (const [name,update] of Object.entries({
  email:{email:'new@example.com'},port:{port:8911},tunnel:{tunnelId:'tunnel-other123'},hostname:{hostname:'new.example.com'},
  apex:{hostname:'example.com'},zone:{zoneId:'zone-other123',hostname:'example.net'},
  combined:{zoneId:'zone-other123',hostname:'remote.example.net',tunnelId:'tunnel-other123',port:8912,email:'new@example.net'}
})) test(`configuration migration: ${name} previews without writes and leaves a removable protected deployment`, async()=>fixture(async f=>{
  await apply(f.service);addMigrationChoices(f.state);const previous=await f.receipt(),writes=f.state.calls.filter(call=>call.method!=='GET').length;
  const input={...INPUT,...update}, plan=await f.service.previewConfiguration(input);
  expect(f.state.calls.filter(call=>call.method!=='GET').length).toBe(writes);expect(plan.differences.length).toBeGreaterThan(0);
  f.service.startApply(plan.id);await f.service.operation;
  expect(f.service.status().error).toBeNull();expect(f.service.status().phase).toBe('complete');
  const r=await f.receipt();expect(r.input).toEqual(input);expect(r.configurationChange).toBeUndefined();
  expect(f.state.apps.length).toBe(1);expect(f.state.apps[0].domain).toBe(input.hostname);
  expect(f.state.apps[0].policies[0].include).toEqual([{email:{email:input.email}}]);
  expect(f.state.dns.length).toBe(1);expect(f.state.dns[0].name).toBe(input.hostname);expect(f.state.dns[0].content).toBe(`${input.tunnelId}.cfargotunnel.com`);
  expect((await f.service.diagnose()).checks.every(check=>check.ok)).toBe(true);
  expect((await f.service.previewConfiguration(input)).unchanged).toBe(true);
  if(input.hostname!==INPUT.hostname)expect(r.appId).not.toBe(previous.appId);else expect(r.appId).toBe(previous.appId);
  expect(f.state.config.ingress.some(rule=>rule.hostname==='other.example.com')).toBe(true);
  expect(f.state.extraConfigs['tunnel-other123'].ingress.some(rule=>rule.hostname==='keep.example.net')).toBe(true);
  f.service.startRemove();await f.service.operation;expect(f.service.status().phase).toBe('removed');expect(f.state.apps.length).toBe(0);expect(f.state.dns.length).toBe(0);
  expect(f.state.tunnels.length).toBe(2);
}));

test('configuration preview rejects collisions, account migration, creation and occupied ports; apply rejects drift',async()=>fixture(async f=>{
  await apply(f.service);addMigrationChoices(f.state);
  await expect(f.service.previewConfiguration({...INPUT,accountId:'account-other123'})).rejects.toThrow('current Cloudflare account');
  await expect(f.service.previewConfiguration({...INPUT,tunnelMode:'create'})).rejects.toThrow('existing Tunnel');
  await expect(f.service.previewConfiguration({...INPUT,hostname:'other.example.com'})).rejects.toThrow('existing Tunnel route');
  f.deployment.availablePort=async()=>{throw new Error('Occupied port');};
  await expect(f.service.previewConfiguration({...INPUT,port:8910})).rejects.toThrow('Occupied port');
  f.deployment.availablePort=async()=>{};
  const plan=await f.service.previewConfiguration({...INPUT,hostname:'new.example.com'}),writes=f.state.calls.filter(call=>call.method!=='GET').length;
  f.state.config.ingress.unshift({hostname:'concurrent.example.com',service:'http://localhost:8081'});
  f.service.startApply(plan.id);await f.service.operation;expect(f.service.status().phase).toBe('failed');
  expect(f.state.calls.filter(call=>call.method!=='GET').length).toBe(writes);expect((await f.receipt()).phase).toBe('complete');
}));

test('switching away from a created Tunnel preserves its connector provenance for later cleanup',async()=>fixture(async f=>{
  let plan=await f.service.preview({...INPUT,tunnelMode:'create',tunnelName:'Dedicated'});f.service.startApply(plan.id);await f.service.operation;
  const old=await f.receipt();expect(f.state.connectorInstalled).toBe(true);
  await migrate(f,{...INPUT,hostname:'move.example.com'});expect(f.service.status().phase).toBe('complete');
  const moved=await f.receipt();expect(moved.createdTunnelId).toBe(old.input.tunnelId);expect(f.state.connectorInstalled).toBe(true);
  f.service.startRemove();await f.service.operation;expect(f.service.status().phase).toBe('removed');
  expect(f.state.connectorInstalled).toBe(false);expect(f.state.tunnels.map(t=>t.id)).toEqual([INPUT.tunnelId]);
}));

for(const point of ['app','policy','native','route','dns','dns-patch']) test(`configuration failure after ${point} mutation restores old configuration and preserves unrelated resources`,async()=>fixture(async f=>{
  await apply(f.service);addMigrationChoices(f.state);const old=await f.receipt(),config=structuredClone(f.state.config),original=f.client.result;
  let fired=false;
  const failAt=(path,method)=>point==='app'?path.endsWith('/access/apps')&&method==='POST':point==='policy'?path.includes('/policies/')&&method==='PUT':point==='route'?path.endsWith('/configurations')&&method==='PUT':point==='dns'?path.endsWith('/dns_records')&&method==='POST':point==='dns-patch'?path.includes('/dns_records/')&&method==='PATCH':false;
  f.client.result=async(path,method='GET',body)=>{const result=await original(path,method,body);if(!fired&&failAt(path,method)){fired=true;f.state.config.ingress.push({hostname:'concurrent.example.com',service:'http://localhost:1234'});throw new Error('Lost mutation response');}return result;};
  if(point==='native') {f.state.installError=true;fired=true;}
  const target=point==='policy'?{...INPUT,email:'new@example.com'}:point==='dns-patch'?{...INPUT,tunnelId:'tunnel-other123'}:{...INPUT,hostname:'new.example.com',port:8911};
  await migrate(f,target);expect(fired).toBe(true);expect(f.service.status().phase).toBe('failed');
  const r=await f.receipt();expect(r.phase).toBe('complete');expect(r.input).toEqual(old.input);expect(r.configurationChange).toBeUndefined();
  expect(f.state.apps.length).toBe(1);expect(f.state.apps[0].id).toBe(old.appId);expect(f.state.apps[0].policies[0].include).toEqual([{email:{email:INPUT.email}}]);
  expect(f.state.dns.length).toBe(1);expect(f.state.dns[0].content).toBe(`${INPUT.tunnelId}.cfargotunnel.com`);
  expect(f.state.config.ingress.filter(rule=>rule.hostname!=='concurrent.example.com')).toEqual(config.ingress);
  if(point!=='native')expect(f.state.config.ingress.some(rule=>rule.hostname==='concurrent.example.com')).toBe(true);
}));

test('configuration recovery survives process restart and refuses edits to owned resources',async()=>fixture(async f=>{
  await apply(f.service);const original=f.client.result;let offline=false;
  f.client.result=async(path,method='GET',body)=>{if(offline)throw new Error('offline');const result=await original(path,method,body);if(path.endsWith('/dns_records')&&method==='POST'){offline=true;throw new Error('Lost response');}return result;};
  await migrate(f,{...INPUT,hostname:'new.example.com'});expect((await f.receipt()).phase).toBe('change-recovery-required');
  const restarted=new SetupService(f);await restarted.resume();offline=false;
  f.state.config.ingress.find(rule=>rule.hostname==='new.example.com').service='http://localhost:9999';
  restarted.startIdentityRecovery();await restarted.operation;expect((await f.receipt()).configurationChange).toBeTruthy();expect(restarted.status().phase).toBe('failed');
  const r=await f.receipt();f.state.config.ingress=f.state.config.ingress.map(rule=>rule.hostname==='new.example.com'?r.configurationChange.candidate.route:rule);
  restarted.startIdentityRecovery();await restarted.operation;expect(restarted.status().phase).toBe('complete');expect((await f.receipt()).input).toEqual(INPUT);expect(f.state.apps.length).toBe(1);expect(f.state.dns.length).toBe(1);
}));

test('committed migration recovers forward after interrupted cleanup without reverting or repeating creates',async()=>fixture(async f=>{
  await apply(f.service);const original=f.client.result;let offline=false;
  f.client.result=async(path,method='GET',body)=>{if(offline)throw new Error('offline');const result=await original(path,method,body);if(path.includes('/dns_records/')&&method==='DELETE'){offline=true;throw new Error('Lost cleanup response');}return result;};
  await migrate(f,{...INPUT,hostname:'new.example.com'});const interrupted=await f.receipt();expect(interrupted.configurationChange.committed).toBe(true);
  const creates=f.state.calls.filter(call=>call.method==='POST').length, restarted=new SetupService(f);offline=false;await restarted.resume();restarted.startIdentityRecovery();await restarted.operation;
  expect(restarted.status().phase).toBe('complete');expect((await f.receipt()).input.hostname).toBe('new.example.com');expect(f.state.apps.length).toBe(1);expect(f.state.dns.length).toBe(1);
  expect(f.state.calls.filter(call=>call.method==='POST').length).toBe(creates);
}));

test('native configuration changes preserve unrelated environment/unit/probe and recover after a restart failure',async()=>{
  const home=await mkdtemp(join(tmpdir(),'crw-configuration-'));
  try {
    const root=join(home,'release');await mkdir(join(root,'dist'),{recursive:true});await writeFile(join(root,'dist/server.js'),'');
    let failRestart=false;const calls=[],ports=[];
    const deployment=new NativeDeployment({env:{HOME:home,PATH:'/usr/bin',CODEX_WEBUI_ENABLE_TERMINAL:'true'},root,run:async args=>{calls.push(args);if(failRestart&&args.includes('restart'))throw new Error('restart failed');},probe:async url=>{
      ports.push(new URL(url).port);const env=await readFile(deployment.envPath,'utf8');
      const value=key=>JSON.parse(env.split('\n').find(line=>line.startsWith(key+'=')).slice(key.length+1));
      return Response.json({mode:value('CODEX_WEBUI_AUTH_MODE'),publicOrigin:value('CODEX_WEBUI_PUBLIC_ORIGIN'),audience:value('CODEX_WEBUI_CF_ACCESS_AUD'),allowedEmail:value('CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL')});
    }});
    const previous={aud:'old-aud',teamDomain:'fixture.cloudflareaccess.com',input:structuredClone(INPUT)};
    await deployment.install(INPUT,{aud:previous.aud,teamDomain:previous.teamDomain},previous,async()=>{});
    const next={...structuredClone(previous),aud:'next-aud',input:{...INPUT,hostname:'next.example.com',port:8912,email:'next@example.com'}};
    let persisted=false;
    await deployment.reconfigure(previous,next,async()=>{persisted=true;expect(next.local.environment).toContain('PORT="8912"');expect(await readFile(deployment.envPath,'utf8')).toBe(previous.local.environment);});
    expect(persisted).toBe(true);expect(next.local.unit).toBe(previous.local.unit);expect(next.probe).toBe(previous.probe);
    const environment=await readFile(deployment.envPath,'utf8');expect(environment).toContain('CODEX_WEBUI_ENABLE_TERMINAL="true"');expect(environment).toContain('CODEX_WEBUI_PUBLIC_ORIGIN="https://next.example.com"');expect(environment).toContain('CODEX_WEBUI_CF_ACCESS_AUD="next-aud"');
    expect(ports.at(-1)).toBe('8912');expect(calls.some(args=>args.includes('restart'))).toBe(true);
    await deployment.restoreConfiguration(previous,next,async()=>{});expect(await readFile(deployment.envPath,'utf8')).toBe(previous.local.environment);expect(ports.at(-1)).toBe(String(INPUT.port));
    failRestart=true;await expect(deployment.reconfigure(previous,next,async()=>{})).rejects.toThrow('restart failed');failRestart=false;
    await deployment.restoreConfiguration(previous,next,async()=>{});expect(await readFile(deployment.envPath,'utf8')).toBe(previous.local.environment);
    await writeFile(deployment.envPath,'manual edit');await expect(deployment.restoreConfiguration(previous,next,async()=>{})).rejects.toThrow('changed');expect(await readFile(deployment.envPath,'utf8')).toBe('manual edit');
    const {createServer}=await import('node:net');const occupied=createServer();await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));
    try{await expect(deployment.availablePort(occupied.address().port)).rejects.toThrow('in use');}finally{await new Promise(resolve=>occupied.close(resolve));}
  } finally {await rm(home,{recursive:true,force:true});}
});
