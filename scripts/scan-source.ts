// Local, read-only checks for the independent public snapshot. Findings report
// paths and rule names only; never echo suspected credentials or file contents.
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { documentationImages } from './documentation-assets.ts';

const flag = process.argv.indexOf('--directory');
if (flag !== -1 && !process.argv[flag + 1]) throw new Error('--directory requires a path');
const root = resolve(flag === -1 ? new URL('..', import.meta.url).pathname : process.argv[flag + 1]);
async function git(args: string[]) {
  const child = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error('Source scan Git operation failed: ' + error.slice(0, 300));
  return output.trim();
}
const provenance = JSON.parse(await readFile(join(root, 'SOURCE_PROVENANCE.json'), 'utf8'));
if (provenance.format !== 1 || !/^[a-f0-9]{40}$/.test(provenance.developmentCommit || '')) throw new Error('Missing source provenance');
if (await git(['status', '--porcelain'])) throw new Error('Source scan requires a clean snapshot');
const published = process.argv.includes('--published');
const remotes = await git(['remote']);
const commits = Number(await git(['rev-list', '--count', '--all']));
if (published) {
  const origin = provenance.publicRepository;
  if (!origin || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(origin.url || '') || !/^[a-f0-9]{40}$/.test(origin.initialCommit || '')) throw new Error('Missing public repository provenance');
  if (await git(['rev-parse', '--is-shallow-repository']) !== 'false') throw new Error('Published history scan requires a full checkout');
  if (await git(['rev-list', '--max-parents=0', '--all']) !== origin.initialCommit) throw new Error('Published history must start at the recorded public initial commit');
  if (remotes !== 'origin') throw new Error('Published checkout must have only its origin remote');
  for (const line of (await git(['remote', '-v'])).split('\n')) {
    const [name, url] = line.split(/\s+/);
    if (name !== 'origin' || url !== origin.url) throw new Error('Unexpected published repository remote');
  }
} else {
  if (remotes) throw new Error('Snapshot must not have a remote');
  if (commits !== 1) throw new Error('Snapshot must contain exactly one reachable commit');
}
const unreachable = await git(['fsck', '--full', '--no-reflogs', '--unreachable']);
if (unreachable) throw new Error('Snapshot has unreachable objects; investigate before publication');

const findings: { file: string, rule: string }[] = [];
const forbiddenPath = /(?:^|\/)(?:node_modules|\.artifacts|\.codex|\.aws|history|coverage|dist|screenshots|remote-web-attachments|remote-web-setup)(?:\/|$)|(?:^|\/)(?:auth\.json|management-token\.json|\.env(?:\.[^/]+)?|[^/]+\.(?:png|jpe?g|webp|gif|log|pem|key))$/i;
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['provider-token', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b/],
  ['credential-assignment', /(?:api[_-]?key|api[_-]?token|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*["'](?:[A-Za-z0-9+/_=-]{36,})["']/i],
  ['private-machine-path', new RegExp('/' + 'home/' + 'ubuntu' + '(?:/|\\b)')],
  ['private-deployment-host', new RegExp('orax' + '\\.' + 'sieh' + '\\.' + 'de5' + '\\.' + 'net', 'i')],
  ['extracted-resource-signature', new RegExp('M11' + '\\.' + '9434 0' + '\\.' + '430908')],
] as const;
let blobs = 0;
const objects = await git(['rev-list', '--objects', '--all']);
for (const entry of objects.split('\n').filter(Boolean)) {
  const space = entry.indexOf(' '), oid = space === -1 ? entry : entry.slice(0, space), path = space === -1 ? '(commit)' : entry.slice(space + 1);
  const type = await git(['cat-file', '-t', oid]);
  if (type !== 'blob' && type !== 'commit') continue;
  if (type === 'blob') {
    blobs++;
    if (path !== '.env.example' && !documentationImages.has(path) && forbiddenPath.test(path)) findings.push({ file: path, rule: 'forbidden-path' });
    const size = Number(await git(['cat-file', '-s', oid]));
    if (size > 8 * 1024 * 1024) { findings.push({ file: path, rule: 'oversized-source-blob' }); continue; }
  }
  const data = await git(['cat-file', type, oid]);
  for (const [name, pattern] of rules) if (pattern.test(data)) findings.push({ file: path, rule: name });
}
const tree = await git(['ls-tree', '-rz', '--full-tree', 'HEAD']);
for (const entry of tree.split('\0').filter(Boolean)) if (!/^100(?:644|755) blob /.test(entry)) findings.push({ file: entry.slice(entry.indexOf('\t') + 1), rule: 'nonregular-source-entry' });
if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2)); process.exitCode = 1;
} else console.log(JSON.stringify({ ok: true, commit: await git(['rev-parse', 'HEAD']), developmentCommit: provenance.developmentCommit, commits, blobs, remotes: remotes ? remotes.split('\n').length : 0, unreachableObjects: 0, mode: published ? 'published' : 'snapshot', scope: 'all reachable history and tracked source', limitations: 'Pattern scan is not proof that all sensitive data is absent. Manually review source and public commit identity.' }));
