import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { command, portableTarget } from './distribution.ts';
import { linuxDesktopPackage } from './desktop-package.ts';

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
  const installer = JSON.parse((await command(['bun','scripts/installer.ts'],root,observed)).split('\n').at(-1)!);
  process.env.CODEX_WEBUI_INSTALLER = installer.installer;
  await command(['bun','tests/browser/installer.e2e.mjs'],root,observed);
} else {
  const temp = await mkdtemp(join(output, '.desktop-gateway-'));
  try {
    await command(['tar', '-xf', built.archive, '-C', temp], root);
    const desktop = await linuxDesktopPackage(join(temp, `${pkg.name}-${pkg.version}`), output);
    await command(['dpkg-deb', '--info', desktop.installer], root);
    // Native CI uses a disposable runner. Installing this exact deb also gives
    // Chromium its root-owned sandbox helper on Ubuntu's restricted userns.
    await command(['sudo', 'dpkg', '-i', desktop.installer], root, observed);
    try {
      process.env.CODEX_WEBUI_DESKTOP_EXECUTABLE = '/opt/codex-remote-web-desktop/codex-remote-web-desktop';
      await command(['xvfb-run', '-a', 'bun', 'tests/browser/desktop-native.e2e.mjs'], root, observed);
    } finally { await command(['sudo', 'dpkg', '-r', 'codex-remote-web-desktop'], root, observed); }
  } finally { await rm(temp, { recursive: true, force: true }); }
}
