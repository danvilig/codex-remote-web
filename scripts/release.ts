import { cp, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, basename } from 'node:path';
import { pack, portableTarget } from './distribution.ts';
import { documentationImages } from './documentation-assets.ts';
import { buildNativeGateway, stageBrowserVendor, stageDependencyNotices } from './native-gateway.ts';

const root = resolve(import.meta.dir, '..');
const run = async (args: string[], cwd = root) => { const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' }); const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code) throw new Error(`${args[0]} failed: ${error}`); return output.trim(); };
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version');
let provenance = null;
try { provenance = JSON.parse(await readFile(join(root, 'SOURCE_PROVENANCE.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const dirty = Boolean(await run(['git', 'status', '--porcelain']));
if (dirty && !process.argv.includes('--allow-dirty')) throw new Error('Release requires a clean checkout; --allow-dirty is for fixture validation only');
const target = portableTarget();
const portable = process.argv.includes('--native-portable');
await run(['bun', 'scripts/build.ts', '--frontend-only']);
const outputIndex = process.argv.indexOf('--output-dir');
if (outputIndex !== -1 && !process.argv[outputIndex + 1]) throw new Error('--output-dir requires a directory');
const outputDir = resolve(root, outputIndex === -1 ? '.artifacts/releases' : process.argv[outputIndex + 1]); await mkdir(outputDir, { recursive: true });
const name = `${pkg.name}-${pkg.version}`;
const archivePath = join(outputDir, portable ? `${name}-${target.label}-${target.arch}.${target.extension}` : `${name}.tar.gz`);
for (const path of [archivePath, `${archivePath}.sha256`]) {
  try { await access(path); throw new Error('Refusing to overwrite an existing candidate; select a new --output-dir'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const temp = await mkdtemp(join(outputDir, '.stage-'));
const stage = join(temp, name);
const files = [
  ...documentationImages,
  'public/setup.html', 'public/setup.bundle.js', 'public/remote-access.css', '.env.example', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'README-zh.md', 'CHANGELOG.md', 'SECURITY.md',
  'public/index.html', 'public/app.bundle.js', 'public/style.css', 'public/workspace.css', 'public/favicon.svg', 'public/auth-bootstrap.js', 'public/access-session.js', 'public/i18n.js', 'public/codex-brand.js',
  'DEVELOPMENT.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'docs/ARCHITECTURE.md', 'docs/ROADMAP.md', 'docs/CONFIGURATION.md', 'docs/RELEASING.md', 'docs/deployment/CLOUDFLARE.md', 'docs/deployment/SETUP.md', 'docs/deployment/PLATFORMS.md', 'ops/systemd/codex-remote-web.service.example', 'ops/systemd/environment.example', 'ops/cloudflare/ingress.yml.example',
  'docs/licenses/BUN.md', 'AGENTS.md', 'docs/GIT_WORKFLOW.md',
  ...new Set(['docs/releases/0.2.0-beta.1.md', `docs/releases/${pkg.version}.md`]), ...(await Bun.file(join(root, `docs/releases/${pkg.version}-acceptance.md`)).exists() ? [`docs/releases/${pkg.version}-acceptance.md`] : []), ...(provenance ? ['SOURCE_PROVENANCE.json'] : []),
];
try {
  for (const file of files) { const target = join(stage, file); await mkdir(resolve(target, '..'), { recursive: true }); await cp(join(root, file), target); }
  const dependencies = await stageDependencyNotices(root, stage);
  const commit = await run(['git', 'rev-parse', 'HEAD']);
  const runtime = {
    desktopRuntime: 'native-go', runtimeIncluded: false, entrypoint: target.executable,
    platform: target.platform, arch: target.arch, distribution: portable ? 'portable' : 'deployment',
    goVersion: await buildNativeGateway(stage, root, pkg.version, target.platform === 'win32' ? 'windows' : target.platform, target.arch === 'arm64' ? 'arm64' : 'amd64', target.executable),
  };
  await stageBrowserVendor(root, stage);
  await writeFile(join(stage, 'release.json'), JSON.stringify({ name: pkg.name, version: pkg.version, commit, developmentCommit: provenance?.developmentCommit || commit, source: provenance ? 'public-snapshot' : 'development', referenceProject: provenance?.referenceProject || provenance?.upstream || null, dirty, codexTested: '0.164.0', ...runtime }, null, 2) + '\n');
  await pack(stage, archivePath);
  const digest = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  await writeFile(`${archivePath}.sha256`, `${digest}  ${basename(archivePath)}\n`);
  console.log(JSON.stringify({ archive: archivePath, sha256: digest, dependencies, dirty, ...runtime }));
} finally { await rm(temp, { recursive: true, force: true }); }
