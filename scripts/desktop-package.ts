import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { command } from './distribution.ts';
import { signMacApp } from './macos-sign.ts';
import { nativeMacDesktop } from './macos-desktop.ts';
import { buildSystemDesktop } from './system-desktop.ts';
import { systemDesktopBudget, systemDesktopSize } from './system-desktop-size.ts';

const root = resolve(import.meta.dir, '..');
async function distributionPermissions(path: string) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  await chmod(path, metadata.isDirectory() || (metadata.mode & 0o111) ? 0o755 : 0o644);
  if (metadata.isDirectory()) for (const name of await readdir(path)) await distributionPermissions(join(path, name));
}
export async function desktopPackage(gateway: string, output: string) {
  const pkg = await Bun.file(join(root, 'package.json')).json();
  if (process.platform === 'darwin') {
    const destination = await nativeMacDesktop(gateway, output, root, pkg);
    await distributionPermissions(destination);
    const application = join(destination, 'Codex Remote Web.app');
    await signMacApp(application);
    return destination;
  }
  const destination = join(output, `Codex Remote Web-${process.platform}-${process.arch}`);
  const payload = join(destination, 'resources/gateway');
  await mkdir(destination);
  await buildSystemDesktop(root, destination);
  await mkdir(dirname(payload), { recursive: true });
  await cp(gateway, payload, { recursive: true, errorOnExist: true, force: false });
  if (process.platform !== 'win32') await distributionPermissions(destination);
  await systemDesktopSize(destination);
  return destination;
}
export async function linuxDesktopPackage(gateway: string, output: string) {
  const app = await desktopPackage(gateway, output);
  const pkg = await Bun.file(join(root, 'package.json')).json(), arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  const temp = await mkdtemp(join(output, '.deb-'));
  try {
    const prefix = '/opt/codex-remote-web-desktop';
    await mkdir(join(temp, 'DEBIAN')); await mkdir(join(temp, 'opt')); await cp(app, join(temp, prefix), { recursive: true, verbatimSymlinks: true });
    await writeFile(join(temp, 'DEBIAN/control'), `Package: codex-remote-web-desktop\nVersion: ${pkg.version.replace('-', '~')}\nArchitecture: ${arch}\nMaintainer: Codex Remote Web contributors\nDepends: libgtk-3-0t64, libwebkit2gtk-4.1-0, libayatana-appindicator3-1\nDescription: Codex Remote Web desktop gateway and settings\n`);
    await writeFile(join(temp, 'DEBIAN/prerm'), linuxDesktopPrerm(prefix), { mode: 0o755 });
    const desktop = join(temp, 'usr/share/applications'); await mkdir(desktop, { recursive: true });
    await writeFile(join(desktop, 'codex-remote-web.desktop'), `[Desktop Entry]\nType=Application\nName=Codex Remote Web\nComment=Manage your background gateway\nExec=${prefix}/codex-remote-web-desktop\nTerminal=false\nCategories=Development;Network;\n`);
    const archive = join(output, `${pkg.name}-${pkg.version}-desktop-linux-${process.arch}.deb`);
    await distributionPermissions(temp);
    await command(['dpkg-deb', '--threads-max=2', '--root-owner-group', '--build', temp, archive], root);
    if ((await stat(archive)).size >= systemDesktopBudget.installerBytes) throw new Error('Linux desktop installer exceeds the size budget');
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex'); await writeFile(archive + '.sha256', `${sha256}  ${basename(archive)}\n`);
    return { installer: archive, app, sha256 };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export function linuxDesktopPrerm(prefix = '/opt/codex-remote-web-desktop') {
  return `#!/bin/sh\nset -eu\n# Only remove registrations that point at this exact installation. Run each\n# cleanup as its owner; never read their credentials or delete user data.\ngetent passwd | while IFS=: read -r account password uid gid gecos userdir usershell; do\n if [ "$uid" -ge 1000 ] && [ "$uid" -lt 65534 ] && { [ -f "$userdir/.config/codex-remote-web/desktop/session.json" ] || [ -f "$userdir/.config/codex-remote-web/desktop/agent.json" ]; }; then\n  runuser -u "$account" -- env XDG_RUNTIME_DIR="/run/user/$uid" "${prefix}/resources/gateway/codex-remote-web" uninstall-desktop "${prefix}/codex-remote-web-desktop"\n fi\ndone\n`;
}
