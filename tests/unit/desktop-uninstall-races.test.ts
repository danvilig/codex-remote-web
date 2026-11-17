import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, readlink, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { sessionDefinition, configureSession } from '../../desktop/session.js';
import { uninstallBackground } from '../../desktop/uninstall.js';
import { readPrivate, writePrivate } from '../../src/server/desktop/private-store.js';
import { startDesktopAgent } from '../../src/server/desktop/agent.js';
import { desktopConfig } from '../../src/shared/desktop-config.js';

const unix = process.platform === 'win32' ? test.skip : test;
async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), 'desktop-uninstall-races-')), directory = join(home, 'desktop');
  const options = { home, directory, platform: 'linux', executable: '/fixture/A', env: { XDG_RUNTIME_DIR: join(home, 'no-runtime') }, run: async () => { throw new Error('No real systemctl'); } };
  const A = sessionDefinition(options), B = sessionDefinition({ ...options, executable: '/fixture/B' });
  const wants = join(dirname(A.path), 'graphical-session.target.wants'), link = join(wants, 'codex-remote-web-desktop.service');
  let handle;
  const server = createServer(async (req, res) => { try { await handle(req, res); } catch (error) { res.destroy(error); } });
  try {
    await mkdir(wants, { recursive: true }); await writeFile(A.path, A.content); await symlink('../codex-remote-web-desktop.service', link);
    await writePrivate(join(directory, 'session.json'), A);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const descriptor = { version: 1, port: server.address().port, token: 'a'.repeat(43), installation: options.executable };
    await writePrivate(join(directory, 'agent.json'), descriptor);
    await run({ options, A, B, link, descriptor, handle: callback => { handle = callback; } });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}
const reply = (res, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(status === 200 ? {} : { error: 'fixture refusal' })); };
const action = async req => { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text).action; };

unix('uninstall preserves a replacement registration installed while stop is pending', async () => fixture(async f => {
  const actions = [];
  f.handle(async (req, res) => {
    actions.push(await action(req));
    await writeFile(f.B.path, f.B.content); await writePrivate(join(f.options.directory, 'session.json'), f.B);
    await writePrivate(join(f.options.directory, 'agent.json'), { ...f.descriptor, installation: '/fixture/B' });
    reply(res);
  });
  await uninstallBackground(f.options, '/fixture/A');
  expect(actions).toEqual(['stop']);
  expect(await readPrivate(join(f.options.directory, 'session.json'))).toEqual(f.B);
  expect(await Bun.file(f.B.path).text()).toBe(f.B.content); expect(await readlink(f.link)).toBe('../codex-remote-web-desktop.service');
}));

unix('uninstall preserves startup on live stop/shutdown refusals, timeout and unsafe state', async () => fixture(async f => {
  for (const [failingAction, status] of [['stop', 409], ['stop', 500], ['shutdown', 409]]) {
    f.handle(async (req, res) => reply(res, await action(req) === failingAction ? status : 200));
    await expect(uninstallBackground(f.options, '/fixture/A')).rejects.toMatchObject({ status });
    expect(await readPrivate(join(f.options.directory, 'session.json'))).toEqual(f.A);
    expect(await Bun.file(f.A.path).text()).toBe(f.A.content);
  }
  f.handle(async req => { await action(req); });
  await expect(uninstallBackground({ ...f.options, timeoutMs: 40 }, '/fixture/A')).rejects.toThrow();
  expect(await readPrivate(join(f.options.directory, 'session.json'))).toEqual(f.A);
  for (const descriptor of [null, false, 0, '', [], { ...f.descriptor, token: 'invalid' }]) {
    await writePrivate(join(f.options.directory, 'agent.json'), descriptor);
    await expect(uninstallBackground(f.options, '/fixture/A')).rejects.toMatchObject({ code: 'AGENT_STATE_INVALID' });
    expect(await readPrivate(join(f.options.directory, 'session.json'))).toEqual(f.A);
  }
  for (const registration of [null, false, 0, '', [], {}]) {
    await writePrivate(join(f.options.directory, 'session.json'), registration);
    await expect(configureSession(false, f.options)).rejects.toMatchObject({ code: 'SESSION_STATE_INVALID' });
    expect(await Bun.file(f.A.path).text()).toBe(f.A.content);
  }
}));

unix('a real busy desktop agent keeps uninstall retryable without losing startup', async () => fixture(async f => {
  let busy = false;
  const setup = { get busy() { return busy; }, status: () => ({}), receipt: async () => null, disconnect() {} };
  // Probe a fresh disposable gateway port independently of the control endpoint.
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const agent = await startDesktopAgent({ home: f.options.home, directory: f.options.directory, env: { ...process.env, CODEX_WEBUI_DESKTOP_INSTALLATION: '/fixture/A' }, command: [Bun.which('node'), resolve(import.meta.dir, '../fixtures/desktop-gateway.mjs')], serviceFactory: () => setup });
  try {
    await agent.dispatch('config', desktopConfig({ cwd: f.options.home, codex: process.execPath, port, autostart: true }, f.options.home));
    await agent.dispatch('start'); busy = true;
    await expect(uninstallBackground(f.options, '/fixture/A')).rejects.toMatchObject({ status: 409 });
    expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(200);
    expect(await readPrivate(join(f.options.directory, 'session.json'))).toEqual(f.A);
    busy = false;
    await uninstallBackground(f.options, '/fixture/A');
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
    expect(await readPrivate(join(f.options.directory, 'session.json'))).toBeNull();
    expect((await readPrivate(join(f.options.directory, 'config.json'))).enabled).toBe(false);
  } finally { busy = false; await agent.close(); }
}));

unix('session mutations serialize across processes and rollback cannot overwrite a newer registration', async () => fixture(async f => {
  const { acquirePrivateLock } = await import('../../src/server/services/private-lock.js');
  const release = await acquirePrivateLock(join(f.options.directory, 'session-lock'));
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../../src/server/cli.ts'), 'session-configure'], { env: { ...process.env, HOME: f.options.home }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  try {
    child.stdin.write(JSON.stringify({ enabled: false, options: { directory: f.options.directory, executable: '/fixture/A', expectedInstallation: '/fixture/A' } })); child.stdin.end();
    await Bun.sleep(80);
    if (child.exitCode !== null) throw new Error('Helper exited: ' + await new Response(child.stdout).text() + await new Response(child.stderr).text());
    expect(child.exitCode).toBeNull(); expect(await readPrivate(join(f.options.directory, 'session.json'))).toEqual(f.A);
    // A competing registration commits before the lock is granted to uninstall.
    await writeFile(f.B.path, f.B.content); await writePrivate(join(f.options.directory, 'session.json'), f.B);
  } finally { await release(); }
  const result = await new Response(child.stdout).json();
  expect(await child.exited).toBe(0); expect(result.snapshot.current).toEqual(f.B);
  expect(await readPrivate(join(f.options.directory, 'session.json'))).toEqual(f.B);
  await expect(configureSession(false, { ...f.options, expectedRegistration: f.A })).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  const restore = await configureSession(true, { ...f.options, executable: '/fixture/B' });
  await writePrivate(join(f.options.directory, 'session.json'), f.A); await writeFile(f.A.path, f.A.content);
  await expect(restore()).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  expect(await readPrivate(join(f.options.directory, 'session.json'))).toEqual(f.A);
}));

unix('rollback generations reject enabled, disabled and identical-save ABA sequences', async () => fixture(async f => {
  const manager = async () => {};
  const options = { ...f.options, run: manager };
  // Enabled A -> disabled -> enabled A has identical JSON but a newer intent.
  await configureSession(false, options);
  const firstEnable = await configureSession(true, options);
  await configureSession(false, options); await configureSession(true, options);
  await expect(firstEnable()).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  expect(await readPrivate(join(f.options.directory, 'session.json'))).toEqual(f.A);
  // A disabled tombstone must also retain a newer disabled intent.
  const firstDisable = await configureSession(false, options);
  await configureSession(true, options); await configureSession(false, options);
  await expect(firstDisable()).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  expect(await readPrivate(join(f.options.directory, 'session.json'))).toBeNull();
  // Reasserting the same setting succeeds but supersedes earlier rollback.
  const enable = await configureSession(true, options);
  await configureSession(true, options);
  await expect(enable()).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  expect(await readPrivate(join(f.options.directory, 'session.json'))).toEqual(f.A);
}));
