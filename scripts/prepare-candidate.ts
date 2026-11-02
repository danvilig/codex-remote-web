// Prepare reviewable local artifacts only. Never push, tag, create a repository
// remotely, upload a Release, restart a service or mutate Cloudflare resources.
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(new URL('..', import.meta.url).pathname);
async function run(args: string[], cwd = root) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`${args[0]} failed: ${error.slice(-3000)}`);
  return out.trim();
}
if (await run(['git', 'status', '--porcelain'])) throw new Error('Candidate preparation requires a clean development commit');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid candidate version');
const inputCommit = await run(['git', 'rev-parse', 'HEAD']);
const parent = join(root, '.artifacts', 'candidates'); await mkdir(parent, { recursive: true });
const output = join(parent, `${pkg.version}-${inputCommit.slice(0, 7)}`);
// Both candidate directory and export are immutable once created. A failed run
// leaves evidence for inspection; a new clean commit is required to retry.
await mkdir(output);
const exported = JSON.parse((await run(['bun', 'scripts/prepare-source.ts'])).split('\n').at(-1)!);
// In an already-public checkout, HEAD is a snapshot commit rather than the
// original development commit. Preserve that provenance and record both IDs.
const developmentCommit = exported.developmentCommit;
const snapshot = exported.directory;
const scan = JSON.parse((await run(['bun', 'scripts/scan-source.ts', '--directory', snapshot])).split('\n').at(-1)!);
await writeFile(join(output, 'source-scan.json'), JSON.stringify(scan, null, 2) + '\n');
await run(['bun', 'install', '--frozen-lockfile'], snapshot);
const production = JSON.parse((await run(['bun', 'scripts/release.ts', '--output-dir', output], snapshot)).split('\n').at(-1)!);
const sourceName = `${pkg.name}-${pkg.version}-source.tar.gz`, sourceArchive = join(output, sourceName);
await run(['git', '-c', 'core.hooksPath=/dev/null', 'archive', '--format=tar.gz', `--prefix=${pkg.name}-${pkg.version}-source/`, `--output=${sourceArchive}`, 'HEAD'], snapshot);
const inventory = await run(['tar', '-xOf', production.archive, `${pkg.name}-${pkg.version}/third-party/dependencies.json`]);
await writeFile(join(output, 'dependencies.json'), inventory + '\n');
const notes = `${pkg.version}.md`;
await copyFile(join(snapshot, 'docs', 'releases', notes), join(output, 'RELEASE_NOTES.md'));
const metadata = JSON.parse(await run(['tar', '-xOf', production.archive, `${pkg.name}-${pkg.version}/release.json`]));
if (metadata.dirty || metadata.source !== 'public-snapshot' || metadata.commit !== exported.commit || metadata.developmentCommit !== developmentCommit) throw new Error('Candidate provenance mismatch');
const files = [sourceName, basename(production.archive), 'dependencies.json', 'source-scan.json', 'RELEASE_NOTES.md'];
const sums: {name:string, sha256:string}[] = [];
for (const name of files) {
  const sha256 = createHash('sha256').update(await readFile(join(output, name))).digest('hex');
  sums.push({name,sha256});
  if (name === sourceName) await writeFile(join(output, `${name}.sha256`), `${sha256}  ${name}\n`, { flag: 'wx' });
}
// release.ts already wrote the production .sha256; verify it, never overwrite.
const productionSum = sums.find(item => item.name === basename(production.archive));
const productionChecksum = await readFile(production.archive + '.sha256', 'utf8');
if (!productionChecksum.startsWith(productionSum!.sha256)) throw new Error('Production checksum mismatch');
const manifest = { format: 1, name: pkg.name, version: pkg.version, snapshotCommit: exported.commit, inputCommit, developmentCommit, source: 'public-snapshot', dirty: false, publication: 'local-artifact-only', sourceScan: scan, files: sums, acceptance: `docs/releases/${pkg.version}-acceptance.md`, limitations: 'Artifact generation does not substitute for full release verification, actual iPhone/public network acceptance or public GitHub Actions verification.' };
await writeFile(join(output, 'candidate.json'), JSON.stringify(manifest, null, 2) + '\n');
sums.push({ name: 'candidate.json', sha256: createHash('sha256').update(await readFile(join(output, 'candidate.json'))).digest('hex') });
await writeFile(join(output, 'SHA256SUMS'), sums.map(item => `${item.sha256}  ${item.name}`).join('\n') + '\n');
console.log(JSON.stringify({ directory: output, snapshot: exported.directory, snapshotCommit: exported.commit, inputCommit, developmentCommit, files: sums.length }));
