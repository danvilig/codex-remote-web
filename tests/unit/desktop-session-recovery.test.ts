import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, readlink, chmod, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionDefinition, sessionOwnedBy, configureSession } from '../../desktop/session.js';
import { readPrivate, writePrivate } from '../../src/server/desktop/private-store.js';

const unix = process.platform === 'win32' ? test.skip : test;
test('uninstall identifies complete legacy Unix templates and rejects altered launchers', () => {
  const executable = '/fixture/Restart=on-failure/App With "quotes"/app', options = { home: '/fixture/home', args: ['/fixture/entry.js'] };
  for (const platform of ['linux', 'darwin', 'win32']) {
    const definition = sessionDefinition({ ...options, platform, executable, env: { DISPLAY: ':99', XAUTHORITY: '/fixture/a"b\\c' } });
    const { executable: _executable, args: _args, ...legacy } = definition;
    if (platform === 'win32') legacy.executable = executable;
    expect(sessionOwnedBy(definition, executable, { ...options, platform })).toBe(true);
    expect(sessionOwnedBy(legacy, executable, { ...options, platform })).toBe(true);
    expect(sessionOwnedBy(legacy, '/fixture/other-app', { ...options, platform })).toBe(false);
    expect(sessionOwnedBy(legacy, executable, { ...options, args: [], platform })).toBe(false);
    if (platform === 'win32') continue;
    expect(sessionOwnedBy({ ...legacy, path: '/fixture/foreign' }, executable, { ...options, platform })).toBe(false);
    expect(sessionOwnedBy({ ...legacy, content: legacy.content + '\nforeign' }, executable, { ...options, platform })).toBe(false);
    if (platform === 'linux') {
      for (const extra of ['ExecStart="/fixture/evil"', '[Service]', 'Environment="LD_PRELOAD=/fixture/evil"', 'Environment="DISPLAY=:2"']) {
        expect(sessionOwnedBy({ ...legacy, content: legacy.content.replace('[Install]', extra + '\n[Install]') }, executable, { ...options, platform })).toBe(false);
      }
    }
  }
});

async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), 'desktop-recovery-')), directory = join(home, 'desktop');
  const options = { home, directory, platform: 'linux', executable: '/fixture/app', env: { XDG_RUNTIME_DIR: join(home, 'no-runtime') }, run: async () => { throw new Error('No user bus'); } };
  const definition = sessionDefinition(options), wants = join(dirname(definition.path), 'graphical-session.target.wants'), link = join(wants, 'codex-remote-web-desktop.service');
  try {
    await mkdir(wants, { recursive: true }); await writeFile(definition.path, definition.content); await symlink('../codex-remote-web-desktop.service', link);
    await writePrivate(join(directory, 'session.json'), definition);
    await configureSession(true, options); // establish the stable lock before permission-failure tests
    await run({ options, definition, wants, link });
  } finally {
    await chmod(directory, 0o700); await chmod(wants, 0o700); await chmod(dirname(definition.path), 0o700);
    await rm(home, { recursive: true, force: true });
  }
}

unix('offline unregister preserves startup when the state record cannot be removed', async () => fixture(async ({ options, definition, link }) => {
  await chmod(options.directory, 0o500);
  await expect(configureSession(false, options)).rejects.toThrow();
  expect(await Bun.file(definition.path).text()).toBe(definition.content);
  expect(await readlink(link)).toBe('../codex-remote-web-desktop.service');
  expect(await readPrivate(join(options.directory, 'session.json'))).toEqual(definition);
  // Restore write access for the SQLite lock, then verify the unchanged save.
  await chmod(options.directory, 0o700); await configureSession(true, options);
}));

unix('offline unregister restores the record and link after a later deletion fails', async () => fixture(async ({ options, definition, link }) => {
  await chmod(dirname(definition.path), 0o500); // link is removable, unit is not
  await expect(configureSession(false, options)).rejects.toMatchObject({ code: 'EACCES' });
  expect(await Bun.file(definition.path).text()).toBe(definition.content);
  expect(await readlink(link)).toBe('../codex-remote-web-desktop.service');
  expect(await readPrivate(join(options.directory, 'session.json'))).toEqual(definition);
}));

unix('unchanged enable reconciles a missing unit or link instead of reporting false success', async () => fixture(async ({ options, definition, link }) => {
  const calls = [];
  const online = { ...options, run: async (_cmd, args) => {
    calls.push(args);
    if (args.includes('enable')) await symlink('../codex-remote-web-desktop.service', link);
  } };
  for (const removeUnit of [false, true]) {
    await rm(link); if (removeUnit) await rm(definition.path);
    await configureSession(true, online);
    expect(await Bun.file(definition.path).text()).toBe(definition.content);
    expect(await readlink(link)).toBe('../codex-remote-web-desktop.service');
  }
  expect(calls.filter(args => args.includes('enable')).length).toBe(2);
  await writeFile(definition.path, 'foreign unit');
  await expect(configureSession(true, online)).rejects.toThrow('changed');
  expect(await Bun.file(definition.path).text()).toBe('foreign unit');
}));

test('uninstall rechecks installation ownership after a live descriptor is replaced', async () => {
  const { createServer } = await import('node:http');
  const { uninstallBackground } = await import('../../desktop/uninstall.js');
  const { agentRequest } = await import('../../desktop/client.js');
  const directory = await mkdtemp(join(tmpdir(), 'desktop-uninstall-swap-')), requests = [];
  let descriptor;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text).action);
    await writePrivate(join(directory, 'agent.json'), { ...descriptor, installation: '/fixture/B' });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    descriptor = { version: 1, port: server.address().port, token: 'a'.repeat(43), installation: '/fixture/A' };
    await writePrivate(join(directory, 'agent.json'), descriptor);
    await expect(agentRequest(directory, 'stop', undefined, { expectedInstallation: '/fixture/B' })).rejects.toThrow('another installation');
    expect(requests).toEqual([]);
    await uninstallBackground({ directory, executable: '/fixture/A' }, '/fixture/A');
    expect(requests).toEqual(['stop']); // Shutdown must not reach the new B agent.
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, process.platform === 'win32' ? 60000 : 5000);
