import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, lstat, rm } from 'node:fs/promises';
import { join, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { sessionDefinition } from '../../desktop/session.js';
import { linuxDesktopPrerm } from '../../scripts/desktop-package.ts';
import { startDesktopAgent } from '../../src/server/desktop/agent.js';
import { desktopConfig, desktopDirectory } from '../../src/shared/desktop-config.js';
import { readPrivate, writePrivate } from '../../src/server/desktop/private-store.js';

(process.platform === 'linux' ? test : test.skip)('generated DEB uninstall stops an autostart-disabled gateway and preserves a different installation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-prerm-')), directory = desktopDirectory(home);
  const prefix = join(home, 'installation'), installation = join(prefix, 'codex-remote-web-desktop');
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const agent = await startDesktopAgent({ home, directory, env: { ...process.env, CODEX_WEBUI_DESKTOP_INSTALLATION: installation }, command: [Bun.which('node'), resolve(import.meta.dir, '../fixtures/desktop-gateway.mjs')] });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  try {
    await agent.dispatch('config', desktopConfig({ cwd: home, codex: process.execPath, port, autostart: false }, home)); await agent.dispatch('start');
    expect(await readPrivate(join(directory, 'session.json'))).toBeNull();
    const bin = join(home, 'bin'), gateway = join(prefix, 'resources/gateway'); await mkdir(bin); await mkdir(gateway, { recursive: true });
    await writeFile(join(bin, 'getent'), `#!/bin/sh\nprintf '%s\\n' ${quote(`fixture:x:61234:61234::${home}:/bin/sh`)}\n`, { mode: 0o755 });
    // Emulate only the owner switch; every command runs against disposable HOME.
    await writeFile(join(bin, 'runuser'), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
    await writeFile(join(gateway, 'codex-remote-web'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(import.meta.dir, '../../src/server/cli.ts'))} "$@"\n`, { mode: 0o755 });
    const prerm = join(home, 'prerm');
    async function uninstall(executablePrefix) {
      await writeFile(prerm, linuxDesktopPrerm(executablePrefix));
      const p = Bun.spawn(['/bin/sh', prerm, 'remove'], { env: { ...process.env, HOME: home, PATH: bin + delimiter + process.env.PATH }, stdout: 'pipe', stderr: 'pipe' });
      const stderr = await new Response(p.stderr).text(); expect({ exit: await p.exited, stderr }).toEqual({ exit: 0, stderr: '' });
    }
    // Same executable invoked from a distinct install path must not stop ours.
    const other = join(home, 'other'); await mkdir(join(other, 'resources'), { recursive: true });
    const { symlink } = await import('node:fs/promises'); await symlink(gateway, join(other, 'resources/gateway'));
    await uninstall(other); expect((await fetch(`http://127.0.0.1:${port}`)).ok).toBe(true);
    await uninstall(prefix);
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
    for (let i = 0; i < 100 && await readPrivate(join(directory, 'agent.json')); i++) await Bun.sleep(25);
    expect(await readPrivate(join(directory, 'agent.json'))).toBeNull();
    await uninstall(prefix);
  } finally { await agent.close(); await rm(home, { recursive: true, force: true }); }
}, 30000);

(process.platform === 'linux' ? test : test.skip)('generated DEB uninstall removes new and legacy registrations and isolates mixed installations', async () => {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const mode of ['offline-new', 'offline-legacy', 'online-new', 'online-legacy', 'mixed', 'foreign-registration', 'modified']) {
    const home = await mkdtemp(join(tmpdir(), 'desktop-prerm-registration-')), directory = desktopDirectory(home);
    const prefix = join(home, 'install'), installation = join(prefix, 'codex-remote-web-desktop'), bin = join(home, 'bin');
    const definition = sessionDefinition({ home, platform: 'linux', executable: mode === 'foreign-registration' ? '/fixture/other' : installation, env: { DISPLAY: ':99' } });
    const wants = join(home, '.config/systemd/user/graphical-session.target.wants'), link = join(wants, 'codex-remote-web-desktop.service');
    const online = !mode.startsWith('offline');
    if (mode.endsWith('legacy')) { delete definition.executable; delete definition.args; }
    if (mode === 'modified') definition.content += 'ExecStart="/fixture/foreign"\n';
    const requests: string[] = [];
    const server = httpServer(async (req, res) => {
      let text = ''; for await (const chunk of req) text += chunk;
      requests.push(JSON.parse(text).action); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
    try {
      await mkdir(wants, { recursive: true }); await writeFile(definition.path, definition.content);
      await symlink('../codex-remote-web-desktop.service', link);
      await writePrivate(join(directory, 'session.json'), definition);
      await writePrivate(join(directory, 'config.json'), { userData: 'preserved' });
      if (online) {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        await writePrivate(join(directory, 'agent.json'), { version: 1, port: server.address().port, token: 'a'.repeat(43), installation: mode === 'mixed' ? '/fixture/other' : installation });
      }
      await mkdir(bin); await mkdir(join(prefix, 'resources/gateway'), { recursive: true });
      // A synthetic account with no real user bus. The owner switch is the only
      // emulated step; prerm and the CLI execute their real cleanup code.
      await writeFile(join(bin, 'getent'), `#!/bin/sh\nprintf '%s\\n' ${quote(`fixture:x:61234:61234::${home}:/bin/sh`)}\n`, { mode: 0o755 });
      await writeFile(join(bin, 'runuser'), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
      await writeFile(join(bin, 'systemctl'), '#!/bin/sh\necho UNEXPECTED_SYSTEMCTL >&2\nexit 99\n', { mode: 0o755 });
      await writeFile(join(prefix, 'resources/gateway/codex-remote-web'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(import.meta.dir, '../../src/server/cli.ts'))} "$@"\n`, { mode: 0o755 });
      const prerm = join(home, 'prerm'); await writeFile(prerm, linuxDesktopPrerm(prefix));
      const child = Bun.spawn(['/bin/sh', prerm, 'remove'], { env: { ...process.env, HOME: home, PATH: bin + delimiter + process.env.PATH }, stdout: 'pipe', stderr: 'pipe' });
      const stderr = await new Response(child.stderr).text();
      expect({ exit: await child.exited, stderr }).toEqual({ exit: 0, stderr: '' });
      const exists = async path => !!await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      const preserved = mode === 'foreign-registration' || mode === 'modified';
      expect(await exists(definition.path)).toBe(preserved); expect(await exists(link)).toBe(preserved);
      expect(await exists(join(directory, 'session.json'))).toBe(preserved);
      expect(await readPrivate(join(directory, 'config.json'))).toEqual({ userData: 'preserved' });
      expect(requests).toEqual(online && mode !== 'mixed' ? ['stop', 'shutdown'] : []);
    } finally {
      if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      await rm(home, { recursive: true, force: true });
    }
  }
}, 30000);
