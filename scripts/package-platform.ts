import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { command, portableTarget } from './distribution.ts';

const root = resolve(import.meta.dir, '..'), target = portableTarget();
const pkg = await Bun.file(join(root, 'package.json')).json();
if (process.env.TARGET_ARCH && process.env.TARGET_ARCH !== process.arch) throw new Error('Runner architecture does not match target');
if (process.env.TARGET_OS && process.env.TARGET_OS !== process.platform) throw new Error('Runner OS does not match target');
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${pkg.version}`) throw new Error('Release tag/version mismatch');
const output = join(root, '.artifacts/release'); await mkdir(output, { recursive: true });
if (process.platform === 'linux') {
  const built = JSON.parse((await command(['bun', 'scripts/release.ts', '--output-dir', output], root)).split('\n').at(-1)!);
  const archive = join(output, `${pkg.name}-${pkg.version}-deployment-linux-${process.arch}.tar.gz`);
  await rename(built.archive, archive); await rm(built.archive + '.sha256');
  await writeFile(archive + '.sha256', `${createHash('sha256').update(await readFile(archive)).digest('hex')}  ${basename(archive)}\n`);
  process.env.CODEX_WEBUI_RELEASE_ARCHIVE = archive;
  console.log(await command(['bun', 'run', 'test:release'], root));
}
const built = JSON.parse((await command(['bun', 'scripts/standalone.ts', '--output-dir', output], root)).split('\n').at(-1)!);
process.env.CODEX_WEBUI_PORTABLE_ARCHIVE = built.archive;
console.log(await command(['bun', 'run', 'test:portable'], root));
console.log(`PASS: native ${target.label}-${target.arch} archives`);

if (process.platform !== 'linux') {
  const installer = JSON.parse((await command(['bun','scripts/installer.ts'],root)).split('\n').at(-1)!);
  process.env.CODEX_WEBUI_INSTALLER = installer.installer;
  console.log(await command(['bun','tests/browser/installer.e2e.mjs'],root));
}
