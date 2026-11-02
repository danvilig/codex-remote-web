import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageUsage, listWorktrees } from '../../src/server/services/storage.js';

test('storage counts only regular files and never follows symlinks or returns names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-storage-'));
  try {
    await mkdir(join(root, 'sessions')); await mkdir(join(root, 'archived_sessions'));
    await writeFile(join(root, 'sessions/a.jsonl'), 'abc'); await writeFile(join(root, 'archived_sessions/b.jsonl'), '12345');
    await writeFile(join(root, 'auth.json'), 'SECRET'); await symlink(join(root, 'sessions'), join(root, 'sessions/link'));
    const result = await storageUsage(root);
    expect(result.groups.sessions).toBe(3); expect(result.groups.archived).toBe(5); expect(result.groups.other).toBe(6);
    expect(result.totalBytes).toBe(14); expect(result.partial).toBe(false);
    expect(JSON.stringify(result)).not.toContain('auth.json'); expect(JSON.stringify(result)).not.toContain('SECRET');
    expect((await storageUsage(root, { maxEntries: 1 })).partial).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worktree reader reports an isolated registered worktree without changing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-worktrees-'));
  try {
    const init = Bun.spawn(['git', 'init', '-q', root], { stdout: 'ignore', stderr: 'ignore' }); expect(await init.exited).toBe(0);
    const result = await listWorktrees(root);
    expect(result.worktrees).toHaveLength(1); expect(result.worktrees[0].path).toBe(root);
    expect(result.worktrees[0].locked).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
