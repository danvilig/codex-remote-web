import { packager } from '@electron/packager';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildDesktop } from './desktop.ts';
import { command } from './distribution.ts';
import { signMacApp } from './macos-sign.ts';
import { macIcon } from './macos-dmg.ts';
import { macosMinimumVersion } from './macos-validation.ts';

const root = resolve(import.meta.dir, '..');
async function distributionPermissions(path: string) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  await chmod(path, metadata.isDirectory() || (metadata.mode & 0o111) ? 0o755 : 0o644);
  if (metadata.isDirectory()) for (const name of await readdir(path)) await distributionPermissions(join(path, name));
}
export async function desktopPackage(gateway: string, output: string) {
  const pkg = await Bun.file(join(root, 'package.json')).json();
  const temp = await mkdtemp(join(output, '.desktop-'));
  try {
    const source = await buildDesktop(join(temp, 'app'));
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: pkg.name, productName: 'Codex Remote Web', author: 'Codex Remote Web contributors', version: pkg.version, main: 'main.cjs', type: 'module', license: 'MIT' }));
    const payload = join(temp, 'payload/gateway'); await mkdir(dirname(payload), { recursive: true }); await cp(gateway, payload, { recursive: true });
    const icon = process.platform === 'darwin' ? await macIcon(root, temp) : undefined;
    const [app] = await packager({ icon, dir: source, out: join(temp, 'packed'), name: 'Codex Remote Web', executableName: process.platform === 'linux' ? 'codex-remote-web-desktop' : 'Codex Remote Web', platform: process.platform, arch: process.arch, electronVersion: pkg.devDependencies.electron, appBundleId: 'io.github.danvilig.codex-remote-web', appVersion: pkg.version, buildVersion: pkg.version.split('-')[0], extraResource: [payload], asar: false, prune: false, download: { cacheRoot: process.env.electron_config_cache || join(root, '.artifacts/electron-cache') }, extendInfo: { LSMinimumSystemVersion: macosMinimumVersion } });
    // Framework symlinks must remain relative when the app is relocated and
    // this temporary build tree is removed.
    const destination = join(output, basename(app)); await cp(app, destination, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    if (process.platform !== 'win32') await distributionPermissions(destination);
    if (process.platform === 'darwin') await signMacApp(join(destination, 'Codex Remote Web.app'));
    return destination;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
export async function linuxDesktopPackage(gateway: string, output: string) {
  const app = await desktopPackage(gateway, output);
  const pkg = await Bun.file(join(root, 'package.json')).json(), arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  const temp = await mkdtemp(join(output, '.deb-'));
  try {
    const prefix = '/opt/codex-remote-web-desktop';
    await mkdir(join(temp, 'DEBIAN')); await mkdir(join(temp, 'opt')); await cp(app, join(temp, prefix), { recursive: true, verbatimSymlinks: true });
    // Installed by dpkg as root: preserve Chromium's supported setuid sandbox
    // helper rather than requiring --no-sandbox or global userns changes.
    await writeFile(join(temp, 'DEBIAN/control'), `Package: codex-remote-web-desktop\nVersion: ${pkg.version.replace('-', '~')}\nArchitecture: ${arch}\nMaintainer: Codex Remote Web contributors\nDepends: libgtk-3-0, libnss3, libxss1, libasound2t64, libgbm1\nDescription: Codex Remote Web desktop gateway and settings\n`);
    await writeFile(join(temp, 'DEBIAN/prerm'), linuxDesktopPrerm(prefix), { mode: 0o755 });
    const desktop = join(temp, 'usr/share/applications'); await mkdir(desktop, { recursive: true });
    await writeFile(join(desktop, 'codex-remote-web.desktop'), `[Desktop Entry]\nType=Application\nName=Codex Remote Web\nComment=Manage your background gateway\nExec=${prefix}/codex-remote-web-desktop\nTerminal=false\nCategories=Development;Network;\n`);
    const archive = join(output, `${pkg.name}-${pkg.version}-desktop-linux-${process.arch}.deb`);
    await distributionPermissions(temp);
    await chmod(join(temp, prefix, 'chrome-sandbox'), 0o4755);
    await command(['dpkg-deb', '--threads-max=2', '--root-owner-group', '--build', temp, archive], root);
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex'); await writeFile(archive + '.sha256', `${sha256}  ${basename(archive)}\n`);
    return { installer: archive, app, sha256 };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export function linuxDesktopPrerm(prefix = '/opt/codex-remote-web-desktop') {
  return `#!/bin/sh\nset -eu\n# Only remove registrations that point at this exact installation. Run each\n# cleanup as its owner; never read their credentials or delete user data.\ngetent passwd | while IFS=: read -r account password uid gid gecos userdir usershell; do\n if [ "$uid" -ge 1000 ] && [ "$uid" -lt 65534 ] && { [ -f "$userdir/.config/codex-remote-web/desktop/session.json" ] || [ -f "$userdir/.config/codex-remote-web/desktop/agent.json" ]; }; then\n  runuser -u "$account" -- env XDG_RUNTIME_DIR="/run/user/$uid" "${prefix}/resources/gateway/codex-remote-web" uninstall-desktop "${prefix}/codex-remote-web-desktop"\n fi\ndone\n`;
}
