import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { desktopConfig } from '../../src/shared/desktop-config.js';
import { startDesktopAgent } from '../../src/server/desktop/agent.js';
import { readPrivate, writePrivate } from '../../src/server/desktop/private-store.js';
import { agentRequest } from '../../desktop/client.js';
import { sessionDefinition, configureSession } from '../../desktop/session.js';
import { privateQuickAuthenticator } from '../../src/server/setup/quick-origin.js';
import { QuickTunnel } from '../../src/server/setup/quick.js';
import { SetupService } from '../../src/server/setup/service.js';
import { setupFixture, INPUT, TOKEN } from '../helpers/setup-fixture.js';

async function port() { return new Promise<number>(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const value = (server.address() as any).port; server.close(() => resolve(value)); }); }); }
async function fixture(fn, cloud = false) {
  const home = await mkdtemp(join(tmpdir(), 'desktop-test-')); const directory = join(home, 'desktop');
  const remote = setupFixture(directory);
  const options = { home, directory, startupMs: 2000, command: [Bun.which('node')!, resolve(import.meta.dir, '../fixtures/desktop-gateway.mjs')], serviceFactory: cloud ? deployment => {
    const ready = deployment.ready.bind(deployment);
    deployment.ready = async (...args) => { await ready(...args); remote.state.installed = true; };
    return new SetupService({ ...remote, deployment });
  } : undefined };
  const agent = await startDesktopAgent(options);
  try { await fn({ home, directory, agent, options, remote, config: desktopConfig({ cwd: home, codex: process.execPath, port: await port(), autostart: false }, home) }); }
  finally { await agent.close(); await rm(home, { recursive: true, force: true }); }
}
test('desktop configuration rejects invalid paths, unknown switches and malformed ports', () => {
  for (const value of [{ port: 80 }, { port: '8899' }, { cwd: '../escape' }, { codex: '/tmp/a\narg' }, { terminal: 'true' }, { shell: 'bad' }]) expect(() => desktopConfig(value)).toThrow();
});
test('private control refuses unauthenticated, browser-origin and forwarded requests, and agent ownership survives crashes', async () => fixture(async f => {
  const descriptor = await readPrivate(join(f.directory, 'agent.json'));
  const url = `http://127.0.0.1:${descriptor.port}/v1/control`;
  for (const headers of [{}, { authorization: `Bearer ${descriptor.token}`, origin: 'http://evil.test' }, { authorization: `Bearer ${descriptor.token}`, 'x-forwarded-for': '127.0.0.1' }]) {
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"action":"status"}' })).status).toBe(403);
  }
  expect((await agentRequest(f.directory, 'status')).config.initialized).toBe(false);
  await expect(startDesktopAgent(f.options)).rejects.toMatchObject({ code: 'PRIVATE_LOCK_BUSY' });
  const inode = (await stat(join(f.directory, 'agent-lock.sqlite'))).ino;
  await f.agent.close(); const second = await startDesktopAgent(f.options);
  try { expect((await stat(join(f.directory, 'agent-lock.sqlite'))).ino).toBe(inode); } finally { await second.close(); }
}));
test('actual background process stays available across clients, restarts and stops without erasing configuration', async () => fixture(async f => {
  await agentRequest(f.directory, 'validateConfig', f.config);
  expect((await agentRequest(f.directory, 'status')).config.initialized).toBe(false);
  expect(await readPrivate(join(f.directory, 'config.json'))).toBeNull();
  await agentRequest(f.directory, 'config', f.config); await agentRequest(f.directory, 'start');
  const first = await agentRequest(f.directory, 'status');
  expect(first.local.phase).toBe('running'); expect((await (await fetch(first.url)).json()).pid).toBe(first.local.pid);
  await expect(agentRequest(f.directory, 'config', f.config)).rejects.toThrow('Stop the gateway');
  const anotherClient = await agentRequest(f.directory, 'status'); expect(anotherClient.local.pid).toBe(first.local.pid);
  await agentRequest(f.directory, 'start'); expect((await agentRequest(f.directory, 'status')).local.pid).toBe(first.local.pid);
  await agentRequest(f.directory, 'restart'); expect((await agentRequest(f.directory, 'status')).local.pid).not.toBe(first.local.pid);
  await agentRequest(f.directory, 'stop'); expect((await agentRequest(f.directory, 'status')).local.phase).toBe('stopped');
  expect((await readPrivate(join(f.directory, 'config.json'))).enabled).toBe(false);
  await expect(fetch(first.url)).rejects.toThrow();
}));
test('desktop Cloudflare deployment uses existing transaction and recovery checks and keeps secrets out of status', async () => fixture(async f => {
  await f.agent.dispatch('config', f.config);
  await f.agent.dispatch('start');
  const input = { ...INPUT, port: await port() };
  await f.agent.dispatch('setup', { path: 'connect', body: { token: TOKEN } });
  const preview = await f.agent.dispatch('setup', { path: 'preview', body: input });
  await f.agent.dispatch('setup', { path: 'apply', body: { id: preview.id } });
  for (let i = 0; (await f.agent.dispatch('status')).setup.busy; i++) { if (i > 200) throw new Error('Deployment timed out'); await Bun.sleep(20); }
  const state = await f.agent.dispatch('status'); expect(state.setup.phase, JSON.stringify(state.setup)).toBe('complete'); expect(state.protected.phase).toBe('running');
  await f.agent.dispatch('start'); expect((await f.agent.dispatch('status')).protected.pid).toBe(state.protected.pid);
  expect(f.remote.state.dns).toHaveLength(1); expect(JSON.stringify(state)).not.toContain(TOKEN); expect(JSON.stringify(state)).not.toContain('CODEX_WEBUI_SETUP_PROBE');
  const receipt = await readPrivate(join(f.directory, 'setup-state.json'));
  const changed = { ...(await readPrivate(join(f.directory, 'protected-gateway.json'))), owner: 'someone-else' };
  await writePrivate(join(f.directory, 'protected-gateway.json'), changed);
  await f.agent.dispatch('setup', { path: 'remove', body: {} });
  for (let i = 0; (await f.agent.dispatch('status')).setup.busy; i++) { if (i > 200) throw new Error('Cleanup timed out'); await Bun.sleep(10); }
  expect((await f.agent.dispatch('status')).setup.phase).toBe('failed');
  expect((await readPrivate(join(f.directory, 'protected-gateway.json'))).owner).toBe('someone-else');
  expect(receipt.local.owner).not.toBe('someone-else');
}, true));
test('desktop writes reject linked state without changing the target', async () => {
  if (process.platform === 'win32') return; // Native NTFS privacy has a separate gate.
  const directory = await mkdtemp(join(tmpdir(), 'desktop-private-'));
  try { await writePrivate(join(directory, 'original'), { safe: true }); await symlink(join(directory, 'original'), join(directory, 'link')); await expect(writePrivate(join(directory, 'link'), { safe: false })).rejects.toThrow(); expect(await readPrivate(join(directory, 'original'))).toEqual({ safe: true }); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test('shutdown waits for an accepted startup and closes its child before releasing agent ownership', async () => fixture(async f => {
  await f.agent.dispatch('config', f.config);
  const starting = f.agent.dispatch('start');
  const closing = f.agent.close();
  await expect(f.agent.dispatch('stop')).rejects.toThrow('shutting down');
  await Promise.all([starting, closing]);
  expect((await f.agent.dispatch('status')).local.pid).toBeNull();
  expect((await readPrivate(join(f.directory, 'config.json'))).enabled).toBe(true);
  expect(await readPrivate(join(f.directory, 'agent.json'))).toBeNull();
}));
test('session definitions preserve paths and scope background lifetime to the logged-in user', () => {
  const settings = { home: '/fixture/user', executable: '/fixture/Application With Spaces/app', args: ['/fixture/a&b/main.mjs'] };
  expect(sessionDefinition({ ...settings, platform: 'darwin' }).content).toContain('a&amp;b');
  expect(sessionDefinition({ ...settings, platform: 'linux', env: {} }).content).toContain('PartOf=graphical-session.target');
  const windows = sessionDefinition({ ...settings, platform: 'win32' }); expect(windows.arguments).toContain('--background-agent'); expect(windows.executable).toBe(settings.executable);
  expect(() => sessionDefinition({ ...settings, executable: 'bad\ncommand', platform: 'linux' })).toThrow();
});
test('login registration rolls back failed saves and preserves modified startup files', async () => {
  if (process.platform === 'win32') return;
  const home = await mkdtemp(join(tmpdir(), 'desktop-session-'));
  const options = { home, directory: join(home, 'desktop'), platform: 'linux', executable: '/fixture/application', env: {}, run: async () => ({ stdout: '' }) };
  const definition = sessionDefinition(options);
  try {
    let failed = false;
    await expect(configureSession(true, { ...options, run: async (_command, args) => { if (args.includes('enable') && !failed) { failed = true; throw new Error('registration failed'); } return { stdout: '' }; } })).rejects.toThrow('registration failed');
    expect(await Bun.file(definition.path).exists()).toBe(false);
    expect(await readPrivate(join(options.directory, 'session.json'))).toBeNull();
    const restore = await configureSession(true, options);
    expect(await Bun.file(definition.path).exists()).toBe(true);
    await restore(); expect(await Bun.file(definition.path).exists()).toBe(false);
    await configureSession(true, options);
    await Bun.write(definition.path, 'foreign startup');
    await expect(configureSession(false, options)).rejects.toThrow('changed');
    expect(await Bun.file(definition.path).text()).toBe('foreign startup');
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('Windows temporary origin capability protects HTTP and WebSocket and still enforces the public Origin', async () => {
  const config = { publicOrigin: 'https://fixture.trycloudflare.com', allowedEmail: 'owner@example.com' }, privateHost = 'a'.repeat(48) + '.localhost';
  const auth = privateQuickAuthenticator(config, privateHost);
  for (const upgrade of [undefined, 'websocket']) {
    const req = { headers: { host: privateHost, origin: config.publicOrigin, upgrade }, socket: { remoteAddress: '127.0.0.1' }, url: '/ws', method: 'GET' };
    expect((await auth(req)).ok).toBe(true); expect(req.headers.host).toBe(privateHost);
    expect((await auth({ ...req, headers: { ...req.headers, host: '127.0.0.1' } })).ok).toBe(false);
    expect((await auth({ ...req, headers: { ...req.headers, origin: 'https://evil.test' } })).ok).toBe(false);
    expect((await auth({ ...req, socket: { remoteAddress: '192.0.2.1' } })).ok).toBe(false);
  }
});
test('Windows Quick Tunnel writes only a private HTTP origin capability and waits for protected readiness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-quick-')); let originOptions, connector;
  const quick = new QuickTunnel({ directory, platform: 'win32', preflight: async () => '/fixture/cloudflared', validate: async () => {}, workspace: async options => { originOptions = options; return { port: 12345, activate() {}, close: async () => {} }; }, connector: options => { connector = options; let finish; return { closed: new Promise(resolve => { finish = resolve; }), stop() { finish(); } }; } });
  try {
    quick.start('owner@example.com');
    for (let i = 0; !connector; i++) { if (i > 100) throw new Error('Quick Tunnel did not start'); await Bun.sleep(10); }
    const config = JSON.parse(await readFile(join(connector.directory, 'config.yml'), 'utf8'));
    expect(config.ingress[0]).toEqual({ service: 'http://127.0.0.1:12345', originRequest: { httpHostHeader: originOptions.privateHost } });
    expect(quick.status().publicOrigin).toBeNull(); expect(JSON.stringify(quick.status())).not.toContain(originOptions.privateHost);
    connector.onMessage({ type: 'ready', publicOrigin: 'https://fixture.trycloudflare.com' }); await quick.runtime.starting; expect(quick.status().phase).toBe('ready');
  } finally { await quick.stop(); await rm(directory, { recursive: true, force: true }); }
});
