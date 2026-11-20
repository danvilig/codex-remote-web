import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { command, portableTarget } from './distribution.ts';
import { linuxDesktopPackage } from './desktop-package.ts';
import { installedSystemDesktopSize } from './system-desktop-size.ts';

const root = resolve(import.meta.dir, '..'), target = portableTarget();
const pkg = await Bun.file(join(root, 'package.json')).json();
if (process.env.TARGET_ARCH && process.env.TARGET_ARCH !== process.arch) throw new Error('Runner architecture does not match target');
if (process.env.TARGET_OS && process.env.TARGET_OS !== process.platform) throw new Error('Runner OS does not match target');
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${pkg.version}`) throw new Error('Release tag/version mismatch');
const output = join(root, '.artifacts/release'); await mkdir(output, { recursive: true });
const observed = { stream: true, timeoutMs: 6 * 60_000 };
if (process.platform === 'linux') {
  const built = JSON.parse((await command(['bun', 'scripts/release.ts', '--output-dir', output], root, observed)).split('\n').at(-1)!);
  const archive = join(output, `${pkg.name}-${pkg.version}-deployment-linux-${process.arch}.tar.gz`);
  await rename(built.archive, archive); await rm(built.archive + '.sha256');
  await writeFile(archive + '.sha256', `${createHash('sha256').update(await readFile(archive)).digest('hex')}  ${basename(archive)}\n`);
  process.env.CODEX_WEBUI_RELEASE_ARCHIVE = archive;
  await command(['bun', 'run', 'test:release'], root, observed);
}
const built = JSON.parse((await command(['bun', 'scripts/standalone.ts', '--output-dir', output], root, observed)).split('\n').at(-1)!);
process.env.CODEX_WEBUI_PORTABLE_ARCHIVE = built.archive;
await command(['bun', 'run', 'test:portable'], root, observed);
console.log(`PASS: native ${target.label}-${target.arch} archives`);

if (process.platform !== 'linux') {
  const installer = JSON.parse((await command(['bun','scripts/installer.ts'],root,{...observed,timeoutMs:18*60_000})).split('\n').at(-1)!);
  process.env.CODEX_WEBUI_INSTALLER = installer.installer;
  await command(['bun','tests/browser/installer.e2e.mjs'],root,observed);
} else {
  const temp = await mkdtemp(join(output, '.desktop-gateway-'));
  try {
    await command(['tar', '-xf', built.archive, '-C', temp], root);
    const desktop = await linuxDesktopPackage(join(temp, `${pkg.name}-${pkg.version}`), output);
    await command(['dpkg-deb', '--info', desktop.installer], root);
    // Exercise the exact DEB with the system WebKitGTK on the disposable runner.
    await command(['sudo', 'dpkg', '-i', desktop.installer], root, observed);
    const installed = '/opt/codex-remote-web-desktop';
    let size;
    try {
      size = await installedSystemDesktopSize(installed);
      process.env.CODEX_WEBUI_DESKTOP_EXECUTABLE = join(installed, 'codex-remote-web-desktop');
      await command(['xvfb-run', '-a', 'dbus-run-session', '--', 'node', 'tests/browser/system-desktop.e2e.mjs'], root, observed);
    } finally { await command(['sudo', 'dpkg', '-r', 'codex-remote-web-desktop'], root, observed); }
    if (await access(join(installed, 'codex-remote-web-desktop')).then(() => true, () => false)) throw new Error('Linux installed executable remained after uninstall');
    await writeFile(join(root, '.artifacts/linux-desktop-installation.json'), JSON.stringify({ format: 1, platform: 'linux', arch: process.arch, renderer: 'system-webkitgtk', sourceCommit: await command(['git', 'rev-parse', 'HEAD'], root), installer: basename(desktop.installer), sha256: desktop.sha256, installerBytes: (await stat(desktop.installer)).size, installed: size, nativeControls: true, gatewaySurvivedWindowExit: true, uninstall: true }, null, 2) + '\n');
  } finally { await rm(temp, { recursive: true, force: true }); }
}
