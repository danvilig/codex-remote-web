// Build on the target OS and architecture after rebuilding node-pty with the
// pinned Node version. No user config, credentials or developer cache is copied.
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { portableTarget, pack, copyPtyNative } from './distribution.ts';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dir, '..');
async function run(args: string[], cwd = root) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`${args[0]} failed: ${stderr.slice(-4000)}`);
  return stdout.trim();
}
const pkg = await Bun.file(join(root, 'package.json')).json();
const target = portableTarget();
const node = await realpath(Bun.which('node') || 'node');
if (await run([node, '-p', 'process.versions.node']) !== pkg.engines.node || await run([node, '-p', 'process.arch']) !== process.arch || Bun.version !== pkg.engines.bun) throw new Error('Portable build requires the pinned Bun and Node versions on the target architecture');
const index = process.argv.indexOf('--output-dir');
if (index !== -1 && !process.argv[index + 1]) throw new Error('--output-dir requires a path');
const output = resolve(root, index === -1 ? '.artifacts/portable' : process.argv[index + 1]);
await mkdir(output, { recursive: true });
const name = `${pkg.name}-${pkg.version}`, filename = `${name}-${target.label}-${process.arch}.${target.extension}`, archive = join(output, filename);
for (const path of [archive, archive + '.sha256']) {
  try { await access(path); throw new Error('Refusing to overwrite an existing package'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const temp = await mkdtemp(join(output, '.portable-'));
try {
  const base = JSON.parse((await run(['bun', 'scripts/release.ts', '--output-dir', join(temp, 'deployment'), ...(process.argv.includes('--allow-dirty') ? ['--allow-dirty'] : [])])).split('\n').at(-1)!);
  await run(['tar', '-xf', base.archive, '-C', temp]);
  const stage = join(temp, name);
  // Ship an uncompiled bundle too, so users can rebuild/relink with a modified
  // Bun runtime. Static web assets stay next to the executable, never in HOME.
  const result = await Bun.build({ entrypoints: [join(root, 'src/server/cli.ts')], outdir: join(stage, 'dist'), naming: 'portable.js', target: 'bun', packages: 'bundle', define: { CODEX_REMOTE_WEB_COMPILED: 'true' } });
  if (!result.success) throw new Error(result.logs.join('\n'));
  await run(['bun', 'build', '--compile', `--target=${target.bun}`, '--no-compile-autoload-bunfig', '--outfile', join(stage, target.executable), join(stage, 'dist/portable.js')]);
  await chmod(join(stage, target.executable), 0o755);
  await mkdir(join(stage, 'runtime'));
  await cp(node, join(stage, 'runtime', target.node)); await chmod(join(stage, 'runtime', target.node), 0o755);
  const licenses = [join(dirname(node), 'LICENSE'), join(dirname(node), '../LICENSE')];
  const license = await (async () => { for (const path of licenses) { try { await access(path); return path; } catch {} } throw new Error('Node distribution LICENSE is required'); })();
  await cp(license, join(stage, 'runtime/NODE-LICENSE'));
  await cp(join(root, 'docs/licenses/BUN.md'), join(stage, 'runtime/BUN-LICENSE.md'));
  await writeFile(join(stage, 'runtime/RUNTIMES.json'), JSON.stringify([
    { name: 'Bun', version: Bun.version, source: `https://github.com/oven-sh/bun/tree/bun-v${Bun.version}`, license: 'BUN-LICENSE.md', bundledIn: `../${target.executable}` },
    { name: 'Node.js', version: pkg.engines.node, source: `https://github.com/nodejs/node/tree/v${pkg.engines.node}`, license: 'NODE-LICENSE', bundledIn: target.node },
  ], null, 2) + '\n');
  await writeFile(join(stage, 'runtime/REBUILD.md'), `# Rebuilding and relinking\n\nThe executable embeds Bun ${Bun.version}, including its linked JavaScriptCore/WebKit libraries. See BUN-LICENSE.md and its upstream source links for the exact runtime's build/relink instructions and licenses. Node.js source and distribution notices are listed in RUNTIMES.json and NODE-LICENSE.\n\nAll application code needed for relinking is provided in ../dist/portable.js. From the installation root, use your modified Bun build to run:\n\n\`\`\`sh\nbun build --compile dist/portable.js --outfile codex-remote-web-rebuilt\n\`\`\`\n\nKeep the output next to public/, runtime/ and dist/. Stop the old gateway before replacing its executable. You may replace runtime/${target.node} with a compatible Node ${pkg.engines.node} build; rebuild node-pty against that runtime when its native ABI changes. Full project source and native dependencies are available from the tagged public repository and their recorded upstream sources.\n`);
  // Only runtime files and the native artifact for this build, not sources,
  // package manager caches, other architectures or node-pty's test fixtures.
  const pty = join(stage, 'node_modules/node-pty');
  await mkdir(pty, { recursive: true });
  for (const file of ['package.json', 'LICENSE']) {
    await mkdir(dirname(join(pty, file)), { recursive: true });
    await cp(join(root, 'node_modules/node-pty', file), join(pty, file));
  }
  await copyPtyNative(join(root, 'node_modules/node-pty'), pty);
  await cp(join(root, 'node_modules/node-pty/lib'), join(pty, 'lib'), { recursive: true, filter: path => !/\.(?:map|ts)$|\.test\.js$/.test(path) });
  await cp(join(root, 'node_modules/katex/dist'), join(stage, 'node_modules/katex/dist'), { recursive: true });
  await cp(join(root, 'node_modules/@xterm/xterm/css'), join(stage, 'node_modules/@xterm/xterm/css'), { recursive: true });
  const metadataPath = join(stage, 'release.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  Object.assign(metadata, { distribution: 'portable', platform: process.platform, arch: process.arch, runtimeIncluded: true, entrypoint: target.executable });
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  await pack(stage, archive);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(archive + '.sha256', `${sha256}  ${basename(archive)}\n`);
  console.log(JSON.stringify({ archive, sha256, arch: process.arch, distribution: 'portable', dirty: metadata.dirty }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
