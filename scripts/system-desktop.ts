import { copyFile, cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { command } from './distribution.ts';
import { trayPng } from './desktop.ts';

export const systemRustVersion = '1.95.0';
export const systemDesktopExecutable = (platform = process.platform) => platform === 'win32' ? 'Codex Remote Web.exe' : 'codex-remote-web-desktop';

export async function buildSystemDesktop(root: string, destination: string) {
  const project = join(root, 'desktop/system'), cargoTarget = join(root, '.artifacts/system-desktop-target');
  const toolchain = `+${systemRustVersion}`;
  const runtime = await command(['rustc', toolchain, '-vV'], project);
  const target = /^host: ([-\w]+)$/m.exec(runtime)?.[1];
  const windows = process.platform === 'win32';
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (target !== `${architecture}-${windows ? 'pc-windows-msvc' : 'unknown-linux-gnu'}`) throw new Error(`Unexpected system desktop target: ${target}`);
  await command(['cargo', toolchain, 'build', '--locked', '--release', '--target', target, '--target-dir', cargoTarget], project, { stream: true, timeoutMs: 15 * 60_000 });
  await cp(join(cargoTarget, target, 'release', `codex-remote-web-desktop${windows ? '.exe' : ''}`), join(destination, systemDesktopExecutable()));

  const assets = join(destination, 'resources/desktop');
  await mkdir(assets, { recursive: true });
  const result = await Bun.build({ entrypoints: [join(root, 'desktop/renderer.js')], outdir: assets, naming: 'renderer.js', target: 'browser', format: 'esm', packages: 'bundle' });
  if (!result.success) throw new Error(result.logs.join('\n'));
  for (const name of ['index.html', 'desktop.css']) await copyFile(join(root, 'desktop', name), join(assets, name));
  for (const name of ['style.css', 'workspace.css', 'remote-access.css']) await copyFile(join(root, 'public', name), join(assets, name));
  await writeFile(join(assets, 'tray.png'), trayPng());

  // Preserve dependency notices from the exact locked Cargo sources.
  const metadata = JSON.parse(await command(['cargo', toolchain, 'metadata', '--locked', '--format-version', '1', '--filter-platform', target], project, { timeoutMs: 120_000 }));
  const licenses = join(destination, 'resources/desktop-licenses');
  await mkdir(licenses);
  const inventory = [];
  for (const entry of metadata.packages.filter(pkg => pkg.source).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
    const from = dirname(entry.manifest_path), to = join(licenses, entry.name, entry.version), files = [];
    for (const file of await readdir(from, { withFileTypes: true })) {
      if (!file.isFile() || !/^(?:licen[cs]e|copying|notice|copyright)(?:[-._]|$)/i.test(file.name)) continue;
      await mkdir(to, { recursive: true });
      await copyFile(join(from, file.name), join(to, file.name)); files.push(file.name);
    }
    if (entry.license_file && !files.includes(entry.license_file)) {
      await mkdir(to, { recursive: true });
      await copyFile(join(from, entry.license_file), join(to, 'declared-license.txt')); files.push('declared-license.txt');
    }
    inventory.push({ name: entry.name, version: entry.version, license: entry.license, source: `https://crates.io/crates/${entry.name}/${entry.version}`, files: files.sort() });
  }
  await writeFile(join(licenses, 'dependencies.json'), JSON.stringify(inventory, null, 2) + '\n');
}
