import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, fsyncSync, lstatSync, mkdirSync, realpathSync, readdirSync, linkSync, rmdirSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, lstat, readdir, open } from 'node:fs/promises';
import { join, dirname, relative, resolve, isAbsolute, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveBrowsePath } from '../files/folders.js';
import { listWorktrees } from './storage.js';
import { scheduleOwnerAlive } from './schedule-store.js';
import { acquirePrivateLock } from './private-lock.js';

const exec = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const inside = (path, root) => path === root || path.startsWith(root + sep);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const MAX_TEXT = 256 * 1024, DAY = 86400000;

// Every mutation has a narrow target. No native sessions, credentials, general
// project files, arbitrary Git branches or server configuration can be removed.
export function createDeveloperTools(options) {
  const root = join(options.privateRoot, 'remote-web-developer-tools');
  const previews = new Map();
  let mutation = false;
  const git = async (cwd, args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, timeout: 15000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  function directory(path, create = false, privateMode = false) {
    if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (privateMode && (stat.uid !== process.getuid?.() || stat.mode & 0o077))) throw fail('TOOLS_UNSAFE_PATH', 403);
    return realpathSync(path);
  }
  function initialize() { directory(root, true, true); }
  function project(cwd) {
    if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) throw fail('TOOLS_INVALID_PROJECT');
    const path = directory(resolveBrowsePath(cwd, options.browseRoots, options.home));
    const privateRoot = realpathSync(options.privateRoot);
    if (inside(path, privateRoot)) throw fail('TOOLS_INVALID_PROJECT', 403);
    return path;
  }
  function preview(kind, data) {
    for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key);
    if (previews.size >= 100) previews.delete(previews.keys().next().value);
    const previewToken = randomUUID(); previews.set(previewToken, { kind, data, expires: Date.now() + 5 * 60000 });
    return previewToken;
  }
  function consume(kind, token) {
    const value = previews.get(token); previews.delete(token);
    if (!value || value.kind !== kind || value.expires < Date.now()) throw fail('TOOLS_PREVIEW_EXPIRED', 409);
    return value.data;
  }
  function agentsRead(cwd) {
    const selected = project(cwd), path = join(selected, 'AGENTS.md'), inherited = [];
    const roots = options.browseRoots.map(value => { try { return realpathSync(value); } catch { return resolve(value); } });
    const candidates = [join(options.privateRoot, 'AGENTS.md'), join(options.privateRoot, 'AGENTS.override.md'), join(selected, 'AGENTS.override.md')];
    for (let parent = dirname(selected); parent !== dirname(parent) && roots.some(root => inside(parent, root)); parent = dirname(parent)) {
      candidates.push(join(parent, 'AGENTS.md'), join(parent, 'AGENTS.override.md'));
    }
    for (const candidate of [...new Set(candidates)]) {
      let fd;
      try {
        fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = fstatSync(fd);
        if (stat.isFile() && stat.nlink === 1 && stat.size <= MAX_TEXT) inherited.push({ path: inside(candidate, options.privateRoot) ? `Codex home/${relative(options.privateRoot,candidate)}` : relative(selected,candidate), bytes: stat.size, readOnly: true });
      } catch {} finally { if (fd !== undefined) closeSync(fd); }
    }
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_TEXT) throw fail('TOOLS_FILE_UNSAFE', 403);
      const data = readFileSync(fd);
      if (data.length > MAX_TEXT || data.includes(0)) throw fail('TOOLS_FILE_UNSAFE', 403);
      let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw fail('TOOLS_FILE_UNSAFE', 403); }
      return { exists: true, text, revision: hash(data), inherited };
    } catch (error) { if (error.code === 'ENOENT') return { exists: false, text: '', revision: 'missing', inherited }; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function agentsPreview(input) {
    const cwd = project(input.cwd), before = agentsRead(cwd);
    if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > MAX_TEXT || input.text.includes('\0')) throw fail('TOOLS_INVALID_TEXT');
    if (input.revision !== before.revision) throw fail('TOOLS_FILE_CONFLICT', 409);
    const data = { cwd, text: input.text, revision: before.revision };
    return { previewToken: preview('agents', data), name: 'AGENTS.md', before: before.text, after: input.text, creating: !before.exists };
  }
  function agentsSave(input) {
    const data = consume('agents', input.previewToken), cwd = project(data.cwd), before = agentsRead(cwd);
    if (before.revision !== data.revision) throw fail('TOOLS_FILE_CONFLICT', 409);
    const path = join(cwd, 'AGENTS.md'), temp = join(cwd, `.codex-remote-agents-${randomUUID()}`);
    let fd;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, before.exists ? lstatSync(path).mode & 0o777 : 0o644);
      writeFileSync(fd, data.text); fsyncSync(fd); closeSync(fd); fd = undefined;
      if (project(cwd) !== cwd || agentsRead(cwd).revision !== data.revision) throw fail('TOOLS_FILE_CONFLICT', 409);
      // link creation uses an exclusive destination: a file that appeared after
      // preview is never replaced. Existing files use same-directory replacement.
      if (before.exists) renameSync(temp, path);
      else { linkSync(temp, path); unlinkSync(temp); }
      return { ok: true, ...agentsRead(cwd) };
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
  }
  async function registry() {
    initialize();
    try {
      const path = join(root, 'worktrees.json'), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077 || stat.uid !== process.getuid?.() || stat.size > 256 * 1024) throw fail('TOOLS_UNSAFE_PATH', 403);
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(data)) throw fail('TOOLS_UNSAFE_PATH', 403);
      return data;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function saveRegistry(items) {
    const temporary = join(root, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(items), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(root, 'worktrees.json'));
  }
  async function worktreesList(cwd) {
    cwd = project(cwd);
    const repository = await git(cwd, ['rev-parse', '--show-toplevel']);
    const records = await registry(), result = await listWorktrees(cwd);
    return { ...result, worktrees: result.worktrees.map(item => ({ ...item, managed: records.some(record => record.project === repository && record.path === item.path), id: records.find(record => record.project === repository && record.path === item.path)?.id || null, removable: Boolean(options.isWorktreeBusy) })) };
  }
  async function worktreesCreate(cwd) {
    cwd = project(cwd);
    const repository = project(await git(cwd, ['rev-parse', '--show-toplevel']));
    await git(cwd, ['rev-parse', '--verify', 'HEAD']);
    // A linked checkout gets its own managed directory; the registry records its
    // canonical repository root so removing arbitrary worktrees remains impossible.
    const managed = join(repository, '.codex-remote-web'); directory(managed, true);
    const parent = join(managed, 'worktrees'); directory(parent, true);
    const id = randomUUID(), path = join(parent, id), branch = `codex/web-${id}`;
    const exclude = await git(repository, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
    const excludeStat = await lstat(exclude).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (excludeStat && (!excludeStat.isFile() || excludeStat.isSymbolicLink() || excludeStat.nlink !== 1)) throw fail('TOOLS_UNSAFE_PATH', 403);
    const previous = excludeStat ? await readFile(exclude, 'utf8') : '';
    if (!previous.split('\n').includes('/.codex-remote-web/')) {
      const fd = await open(exclude, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o644);
      try { if (!(await fd.stat()).isFile() || (await fd.stat()).nlink !== 1) throw fail('TOOLS_UNSAFE_PATH', 403); await fd.writeFile('\n/.codex-remote-web/\n'); } finally { await fd.close(); }
    }
    const records = await registry();
    await git(repository, ['worktree', 'add', '-b', branch, path, 'HEAD']);
    const item = { id, project: repository, path, branch, createdAt: new Date().toISOString() };
    await saveRegistry([...records, item]);
    return { ok: true, item };
  }
  async function removable(cwd, id) {
    const repository = project(await git(project(cwd), ['rev-parse', '--show-toplevel']));
    if (!uuid(id)) throw fail('TOOLS_INVALID_WORKTREE');
    const records = await registry(), item = records.find(record => record.id === id && record.project === repository);
    if (!item || item.path !== join(repository, '.codex-remote-web', 'worktrees', id)) throw fail('TOOLS_UNMANAGED_WORKTREE', 403);
    directory(join(repository, '.codex-remote-web')); directory(dirname(item.path));
    if (directory(item.path) !== item.path) throw fail('TOOLS_UNSAFE_PATH', 403);
    const listed = (await listWorktrees(repository)).worktrees.find(tree => tree.path === item.path);
    if (!listed || listed.locked || listed.branch !== item.branch) throw fail('TOOLS_WORKTREE_CHANGED', 409);
    if (!options.isWorktreeBusy || await options.isWorktreeBusy(item.path)) throw fail('TOOLS_WORKTREE_BUSY', 409);
    const dirty = await git(item.path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']);
    if (dirty) throw fail('TOOLS_WORKTREE_DIRTY', 409);
    return { item, records };
  }
  async function worktreesPreview(input) {
    const { item } = await removable(input.cwd, input.id);
    return { previewToken: preview('worktree', { cwd: input.cwd, id: input.id }), item, preservesBranch: true };
  }
  async function worktreesRemove(input) {
    const data = consume('worktree', input.previewToken), { item, records } = await removable(data.cwd, data.id);
    await git(item.project, ['worktree', 'remove', item.path]);
    await saveRegistry(records.filter(record => record.id !== item.id));
    return { ok: true, branchPreserved: item.branch };
  }
  async function attachmentLock(callback) {
    const directoryPath = join(options.privateRoot, 'remote-web-attachments');
    try { directory(directoryPath, false, true); } catch (error) { if (error.code === 'ENOENT') return callback(); throw error; }
    const release = await acquirePrivateLock(join(directoryPath, 'upload.lock'), { timeoutMs: 0, legacyOwnerAlive: scheduleOwnerAlive });
    try { return await callback(); }
    finally { await release(); }
  }

  function snapshot(path) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw fail('TOOLS_UNSAFE_PATH', 403);
    return { size: stat.size, ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs };
  }
  async function cleanupCandidates() {
    initialize();
    const candidates = [], protectedIds = options.protectedAttachmentIds ? new Set(await options.protectedAttachmentIds()) : null;
    const attachments = join(options.privateRoot, 'remote-web-attachments');
    if (protectedIds) {
      let entries = [];
      try { directory(attachments, false, true); entries = readdirSync(attachments); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const id of entries.filter(uuid).slice(0, 1000)) {
        if (protectedIds.has(id)) continue;
        try {
          const path = join(attachments, id); directory(path, false, true);
          const names = readdirSync(path).sort();
          if (names.length !== 2 || !names.includes('metadata.json') || !names.some(name => /^content(?:\.[a-z0-9]+)?$/.test(name))) continue;
          const files = names.map(name => ({ name, ...snapshot(join(path, name)) }));
          const meta = JSON.parse(readFileSync(join(path, 'metadata.json'), 'utf8'));
          if (meta.format !== 1 || meta.id !== id || Date.parse(meta.createdAt) > Date.now() - DAY || !Number.isFinite(Date.parse(meta.createdAt))) continue;
          if (files.some(file => file.mtimeMs > Date.now() - DAY)) continue;
          candidates.push({ kind: 'attachment', id, name: typeof meta.name === 'string' ? meta.name.slice(0, 240) : id, bytes: files.reduce((sum, file) => sum + file.size, 0), files });
        } catch {}
      }
    }
    // Only this service's explicitly managed logs/cache. Native logs, sessions,
    // databases, memories and arbitrary Codex-home content are never eligible.
    for (const kind of ['logs', 'cache']) {
      const path = join(root, kind);
      let names = [];
      try { directory(path, false, true); names = readdirSync(path).slice(0, 1000); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const name of names) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(name)) continue;
        try { const file = snapshot(join(path, name)); if (file.mtimeMs < Date.now() - 7 * DAY) candidates.push({ kind, id: name, name, bytes: file.size, files: [file] }); } catch {}
      }
    }
    return candidates;
  }
  async function cleanupPreview() {
    return attachmentLock(async () => {
      const candidates = await cleanupCandidates();
      return { previewToken: preview('cleanup', candidates), items: candidates.map(({ files, ...item }) => item), totalBytes: candidates.reduce((sum, item) => sum + item.bytes, 0), attachmentsProtected: !options.protectedAttachmentIds };
    });
  }
  async function cleanupExecute(input) {
    const previous = consume('cleanup', input.previewToken);
    return attachmentLock(async () => {
      const current = await cleanupCandidates();
      if (previous.some(item => !current.some(candidate => JSON.stringify(candidate) === JSON.stringify(item)))) throw fail('TOOLS_CLEANUP_CHANGED', 409);
      // Revalidation and removal are synchronous within this process, under the
      // attachment binding/upload lock shared by local and public gateways.
      for (const item of previous) {
        const path = item.kind === 'attachment' ? join(options.privateRoot, 'remote-web-attachments', item.id) : join(root, item.kind, item.id);
        if (item.kind === 'attachment') {
          for (const file of item.files) unlinkSync(join(path, file.name));
          // Directory itself has no user content beyond the validated two files.
          rmdirSync(path);
        } else unlinkSync(path);
      }
      return { ok: true, removed: previous.length, totalBytes: previous.reduce((sum, item) => sum + item.bytes, 0) };
    });
  }
  async function mcpInventory(input) {
    if (input.cwd) project(input.cwd);
    const servers = []; let cursor = null, partial = false;
    do {
      const page = await options.request('mcpServerStatus/list', { limit: 100, cursor, detail: 'full', ...(input.threadId ? { threadId: input.threadId } : {}) });
      if (!Array.isArray(page?.data)) throw fail('TOOLS_MCP_UNAVAILABLE', 503);
      for (const server of page.data) servers.push({ name: String(server.name || '').slice(0, 256), authStatus: server.authStatus || 'unknown', runtimeStatus: server.runtimeStatus || 'unknown', tools: Object.values(server.tools || {}).slice(0, 1000).map(tool => ({ name: String(tool.name || '').slice(0, 256), description: String(tool.description || '').slice(0, 2000) })), resources: (server.resources || []).slice(0, 1000).map(resource => ({ name: String(resource.name || '').slice(0, 256), mimeType: String(resource.mimeType || '').slice(0, 128) })), resourceTemplates: (server.resourceTemplates || []).slice(0, 1000).map(resource => ({ name: String(resource.name || '').slice(0, 256) })) });
      if (page.nextCursor && page.nextCursor === cursor) { partial = true; break; }
      cursor = page.nextCursor || null;
      if (servers.length >= 500) { partial = Boolean(cursor); break; }
    } while (cursor);
    return { servers, partial, readOnly: true };
  }
  async function action(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('TOOLS_INVALID_REQUEST');
    const reads = { 'agents.read': () => agentsRead(input.cwd), 'agents.preview': () => agentsPreview(input), 'worktrees.list': () => worktreesList(input.cwd), 'worktrees.preview-remove': () => worktreesPreview(input), 'cleanup.preview': cleanupPreview, 'mcp.inventory': () => mcpInventory(input) };
    if (Object.hasOwn(reads, input.action)) return reads[input.action]();
    const writes = { 'agents.save': () => agentsSave(input), 'worktrees.create': () => worktreesCreate(input.cwd), 'worktrees.remove': () => worktreesRemove(input), 'cleanup.execute': () => cleanupExecute(input) };
    if (!Object.hasOwn(writes, input.action)) throw fail('TOOLS_INVALID_ACTION');
    if (mutation) throw fail('TOOLS_BUSY', 409);
    mutation = true;
    let release;
    try {
      initialize();
      release = await acquirePrivateLock(join(root, 'mutation.lock'), { timeoutMs: 0, legacyOwnerAlive: scheduleOwnerAlive });
      return await writes[input.action]();
    } finally { try { if (release) await release(); } finally { mutation = false; } }
  }

  return { action };
}
