import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function buildNativeGateway(destination: string, root: string, version: string, os: string, arch: string, executable: string) {
  const module = join(root, 'native-gateway');
  const goVersion = /^go (\S+)$/m.exec(await readFile(join(module, 'go.mod'), 'utf8'))?.[1];
  if (!goVersion || !/^\d+\.\d+\.\d+$/.test(goVersion)) throw new Error('Native gateway requires a pinned Go toolchain');
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error('Invalid native gateway version');
  await mkdir(destination, { recursive: true });
  const env = { ...process.env, GOTOOLCHAIN: 'local', GOFLAGS: '', GOENV: 'off', GOWORK: 'off', CGO_ENABLED: '0', GOOS: os, GOARCH: arch };
  const tool = Bun.spawn(['go', 'env', 'GOVERSION', 'GOROOT'], { cwd: module, env, stdout: 'pipe', stderr: 'inherit' });
  const [details, status] = await Promise.all([new Response(tool.stdout).text(), tool.exited]);
  const [installed, goRoot] = details.trim().split(/\r?\n/);
  if (status !== 0 || installed !== `go${goVersion}` || !goRoot) throw new Error(`Build requires Go ${goVersion} (found ${installed || 'none'})`);
  const binary = join(destination, executable);
  const build = Bun.spawn(['go', 'build', '-mod=readonly', '-buildvcs=false', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', binary, '.'], { cwd: module, env, stdout: 'inherit', stderr: 'inherit' });
  if (await build.exited !== 0) throw new Error('Native Go gateway build failed');
  const licenses = join(destination, 'native-licenses');
  await cp(join(module, 'licenses'), licenses, { recursive: true });
  await cp(join(goRoot, 'LICENSE'), join(licenses, 'GO-LICENSE'));
  await cp(join(goRoot, 'PATENTS'), join(licenses, 'GO-PATENTS'));
  return goVersion;
}

export async function stageBrowserVendor(source: string, destination: string) {
  for (const file of ['node_modules/katex/dist/katex.min.css', 'node_modules/@xterm/xterm/css/xterm.css']) {
    await mkdir(join(destination, file, '..'), { recursive: true });
    await cp(join(source, file), join(destination, file));
  }
  const fonts = 'node_modules/katex/dist/fonts';
  await mkdir(join(destination, fonts), { recursive: true });
  for (const font of await readdir(join(source, fonts))) {
    if (font.endsWith('.woff2')) await cp(join(source, fonts, font), join(destination, fonts, font));
  }
}

export async function stageDependencyNotices(source: string, destination: string) {
  const pkg = await Bun.file(join(source, 'package.json')).json();
  const seen = new Set<string>();
  const inventory: { name: string; version: string; license: string; notices: string[] }[] = [];
  async function dependency(name: string, parent = source) {
    let directory = join(parent, 'node_modules', name);
    if (!(await Bun.file(join(directory, 'package.json')).exists())) directory = join(source, 'node_modules', name);
    const metadata = await Bun.file(join(directory, 'package.json')).json();
    const id = `${metadata.name}@${metadata.version}`;
    if (seen.has(id)) return;
    seen.add(id);
    const notices: string[] = [];
    for (const file of await readdir(directory)) {
      if (!/^(licen[cs]e|copying|notice)([._-]|$)/i.test(file)) continue;
      const path = `third-party/licenses/${metadata.name}/${metadata.version}/${file}`;
      await mkdir(dirname(join(destination, path)), { recursive: true });
      await cp(join(directory, file), join(destination, path)); notices.push(path);
    }
    inventory.push({ name: metadata.name, version: metadata.version, license: metadata.license || 'See package notices', notices });
    for (const child of Object.keys(metadata.dependencies || {})) await dependency(child, directory);
    for (const child of Object.keys(metadata.optionalDependencies || {})) {
      if (await Bun.file(join(directory, 'node_modules', child, 'package.json')).exists() || await Bun.file(join(source, 'node_modules', child, 'package.json')).exists()) await dependency(child, directory);
    }
  }
  for (const name of Object.keys(pkg.dependencies)) await dependency(name);
  inventory.sort((a, b) => a.name.localeCompare(b.name));
  await mkdir(join(destination, 'third-party'), { recursive: true });
  await writeFile(join(destination, 'third-party/dependencies.json'), JSON.stringify(inventory, null, 2) + '\n');
  return inventory.length;
}
