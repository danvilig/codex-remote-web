import { lstat, opendir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Metadata only: never follow symlinks or read session, database or credential contents.
// Limit the scan so a large Codex home cannot monopolize the gateway.
export async function storageUsage(root, { maxEntries = 20000, timeoutMs = 1500 } = {}) {
  const groups = { sessions: 0, archived: 0, memories: 0, worktrees: 0, logs: 0, other: 0 };
  let entries = 0, partial = false;
  const deadline = Date.now() + timeoutMs;
  async function visit(path, category) {
    if (++entries > maxEntries || Date.now() > deadline) { partial = true; return; }
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code !== 'ENOENT') partial = true; return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) { groups[category] += stat.size; return; }
    if (!stat.isDirectory()) return;
    try {
      for await (const entry of await opendir(path)) {
        if (entries >= maxEntries || Date.now() > deadline) { partial = true; break; }
        const top = path === root;
        const group = top ? ({ sessions: 'sessions', archived_sessions: 'archived', memories: 'memories', worktrees: 'worktrees', log: 'logs', logs: 'logs' }[entry.name] || 'other') : category;
        await visit(join(path, entry.name), group);
      }
    } catch { partial = true; }
  }
  await visit(root, 'other');
  return { groups, totalBytes: Object.values(groups).reduce((sum, value) => sum + value, 0), partial, measuredAt: new Date().toISOString() };
}

export async function listWorktrees(cwd) {
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain', '-z'], { cwd, timeout: 5000, maxBuffer: 512 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return { worktrees: stdout.split('\0\0').filter(Boolean).map(record => {
    const fields = record.split('\0');
    const path = fields.find(field => field.startsWith('worktree '))?.slice(9) || '';
    return { path, name: relative(cwd, path) || '.', branch: fields.find(field => field.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') || '', detached: fields.includes('detached'), locked: fields.some(field => /^locked(?: |$)/.test(field)) };
  }) };
}
