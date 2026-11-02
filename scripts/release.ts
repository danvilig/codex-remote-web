import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, basename } from 'node:path';
import { documentationImages } from './documentation-assets.ts';

const root = new URL('..', import.meta.url).pathname;
const run = async (args: string[], cwd = root) => { const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' }); const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code) throw new Error(`${args[0]} failed: ${error}`); return output.trim(); };
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version');
let provenance = null;
try { provenance = JSON.parse(await readFile(join(root, 'SOURCE_PROVENANCE.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const dirty = Boolean(await run(['git', 'status', '--porcelain']));
if (dirty && !process.argv.includes('--allow-dirty')) throw new Error('Release requires a clean checkout; --allow-dirty is for fixture validation only');
await run(['bun', 'run', 'build']);
const outputIndex = process.argv.indexOf('--output-dir');
if (outputIndex !== -1 && !process.argv[outputIndex + 1]) throw new Error('--output-dir requires a directory');
const outputDir = resolve(root, outputIndex === -1 ? '.artifacts/releases' : process.argv[outputIndex + 1]); await mkdir(outputDir, { recursive: true });
const archivePath = join(outputDir, `${pkg.name}-${pkg.version}.tar.gz`);
for (const path of [archivePath, `${archivePath}.sha256`]) {
  try { await access(path); throw new Error('Refusing to overwrite an existing candidate; select a new --output-dir'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const temp = await mkdtemp(join(outputDir, '.stage-'));
const name = `${pkg.name}-${pkg.version}`, stage = join(temp, name);
const files = [
  ...documentationImages,
  'dist/setup.js', 'public/setup.html', 'public/setup.bundle.js', 'public/remote-access.css', 'dist/server.js', 'dist/terminal-worker.js', 'dist/quick-worker.js', 'bun.lock', '.env.example', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'README-zh.md', 'CHANGELOG.md', 'SECURITY.md',
  'public/index.html', 'public/app.bundle.js', 'public/style.css', 'public/workspace.css', 'public/favicon.svg', 'public/auth-bootstrap.js', 'public/access-session.js', 'public/i18n.js', 'public/codex-brand.js',
  'DEVELOPMENT.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'docs/ARCHITECTURE.md', 'docs/ROADMAP.md', 'docs/CONFIGURATION.md', 'docs/RELEASING.md', 'docs/deployment/CLOUDFLARE.md', 'docs/deployment/SETUP.md', 'ops/systemd/codex-remote-web.service.example', 'ops/systemd/environment.example', 'ops/cloudflare/ingress.yml.example',
  'docs/licenses/BUN.md', 'AGENTS.md', 'docs/GIT_WORKFLOW.md',
  `docs/releases/${pkg.version}.md`, ...(await Bun.file(join(root, `docs/releases/${pkg.version}-acceptance.md`)).exists() ? [`docs/releases/${pkg.version}-acceptance.md`] : []), ...(provenance ? ['SOURCE_PROVENANCE.json'] : []),
];
try {
  for (const file of files) { const target = join(stage, file); await mkdir(resolve(target, '..'), { recursive: true }); await cp(join(root, file), target); }
  // Dependency declarations stay identical to the frozen lockfile; install with --production.
  await writeFile(join(stage, 'package.json'), JSON.stringify({ ...pkg, scripts: { start: 'bun run dist/server.js', 'start:production': 'bun run dist/server.js', 'setup:cloudflare': 'bun run dist/setup.js' } }, null, 2) + '\n');
  const seen = new Set<string>(), inventory: any[] = [];
  async function dependency(name: string, parent = root) {
    let directory = resolve(parent, 'node_modules', name);
    try { await readFile(join(directory, 'package.json')); } catch { directory = resolve(root, 'node_modules', name); }
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const id = `${metadata.name}@${metadata.version}`; if (seen.has(id)) return; seen.add(id);
    const notices: string[] = [];
    for (const file of await readdir(directory)) {
      if (!/^(licen[cs]e|copying|notice)([._-]|$)/i.test(file)) continue;
      const target = `third-party/licenses/${metadata.name}/${metadata.version}/${file}`;
      await mkdir(resolve(stage, target, '..'), { recursive: true }); await cp(join(directory, file), join(stage, target)); notices.push(target);
    }
    inventory.push({ name: metadata.name, version: metadata.version, license: metadata.license || 'See package notices', notices });
    for (const child of Object.keys(metadata.dependencies || {})) await dependency(child, directory);
    for (const child of Object.keys(metadata.optionalDependencies || {})) { try { await dependency(child, directory); } catch { /* Not installed on this platform. */ } }
  }
  for (const name of Object.keys(pkg.dependencies)) await dependency(name);
  inventory.sort((a,b) => a.name.localeCompare(b.name));
  await mkdir(join(stage, 'third-party'), { recursive: true });
  await writeFile(join(stage, 'third-party/dependencies.json'), JSON.stringify(inventory, null, 2) + '\n');
  const commit = await run(['git', 'rev-parse', 'HEAD']);
  await writeFile(join(stage, 'release.json'), JSON.stringify({ name: pkg.name, version: pkg.version, commit, developmentCommit: provenance?.developmentCommit || commit, source: provenance ? 'public-snapshot' : 'development', referenceProject: provenance?.referenceProject || provenance?.upstream || null, dirty, bun: '1.4.4', node: '24.22.2', codexTested: '0.164.0' }, null, 2) + '\n');
  const archive = join(outputDir, `${name}.tar.gz`);
  await run(['tar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', temp, name]);
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
  console.log(JSON.stringify({ archive, sha256: digest, dependencies: inventory.length, dirty }));
} finally { await rm(temp, { recursive: true, force: true }); }
