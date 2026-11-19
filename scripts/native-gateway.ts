import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const executable = 'codex-remote-web';

// Assemble the Go payload from the verified portable assets without copying
// the portable executable, worker scripts, JavaScript runtimes or Node addons.
export async function stageNativeGateway(source: string, destination: string, root: string, version: string, os: 'darwin' | 'linux', arch: 'arm64' | 'amd64') {
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
  for (const file of ['public', 'third-party', 'docs', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'README-zh.md', 'CHANGELOG.md', 'SECURITY.md', 'package.json']) {
    await cp(join(source, file), join(destination, file), { recursive: true });
  }
  for (const file of ['node_modules/katex/dist/katex.min.css', 'node_modules/@xterm/xterm/css/xterm.css']) {
    await mkdir(join(destination, file, '..'), { recursive: true });
    await cp(join(source, file), join(destination, file));
  }
  const fonts = 'node_modules/katex/dist/fonts';
  await mkdir(join(destination, fonts), { recursive: true });
  for (const font of await readdir(join(source, fonts))) {
    if (font.endsWith('.woff2')) await cp(join(source, fonts, font), join(destination, fonts, font));
  }
  const licenses = join(destination, 'native-licenses');
  await cp(join(module, 'licenses'), licenses, { recursive: true });
  await cp(join(goRoot, 'LICENSE'), join(licenses, 'GO-LICENSE'));
  await cp(join(goRoot, 'PATENTS'), join(licenses, 'GO-PATENTS'));
  const metadata = JSON.parse(await readFile(join(source, 'release.json'), 'utf8'));
  if (metadata.source === 'public-snapshot') await cp(join(source, 'SOURCE_PROVENANCE.json'), join(destination, 'SOURCE_PROVENANCE.json'));
  await writeFile(join(destination, 'release.json'), JSON.stringify({ ...metadata, desktopRuntime: 'native-go', runtimeIncluded: false, goVersion }, null, 2) + '\n');
  return binary;
}
