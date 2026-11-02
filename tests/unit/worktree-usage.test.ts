import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorktreeUsageCheck, worktreeContainsCwd } from '../../src/server/services/worktree-usage.js';

async function fixture(fn) {
  const root = await mkdtemp('/tmp/crw-worktree-usage-');
  const worktree = join(root, 'tree'), child = join(worktree, 'src'), sibling = join(root, 'tree-other'), alias = join(root, 'alias');
  await mkdir(child, { recursive: true }); await mkdir(sibling); await symlink(child, alias);
  try { await fn({ root, worktree, child, sibling, alias }); } finally { await rm(root, { recursive: true, force: true }); }
}
test('worktree occupancy includes child and canonical alias but excludes adjacent directory', async () => fixture(async ({ worktree, child, sibling, alias, root }) => {
  expect(worktreeContainsCwd(worktree, child)).toBe(true);
  expect(worktreeContainsCwd(worktree, alias)).toBe(true);
  expect(worktreeContainsCwd(worktree, sibling)).toBe(false);
  expect(worktreeContainsCwd(worktree, root)).toBe(false);
  expect(worktreeContainsCwd(worktree, join(root, 'missing'))).toBe(true);
}));
test('worktree removal detects queued, scheduled and loaded child-directory users', async () => fixture(async ({ worktree, child, sibling }) => {
  let entries = [], jobs = [], runs = [], nativeCwd = sibling;
  const busy = createWorktreeUsageCheck({ connected: () => true, terminalCount: () => 0, queue: { list: async () => ({ entries }) }, scheduler: { list: async () => ({ jobs, runs }) }, request: async method => method === 'thread/loaded/list' ? { data: ['native'] } : { thread: { cwd: nativeCwd } } });
  expect(await busy(worktree)).toBe(false);
  nativeCwd = child; expect(await busy(worktree)).toBe(true);
  nativeCwd = sibling; entries = [{ params: { cwd: child } }]; expect(await busy(worktree)).toBe(true);
  entries = []; jobs = [{ id: 'scheduled', enabled: true, cwd: child }]; expect(await busy(worktree)).toBe(true);
  jobs[0].enabled = false; expect(await busy(worktree)).toBe(false);
  runs = [{ jobId: 'scheduled', status: 'running' }]; expect(await busy(worktree)).toBe(true);
}));
test('worktree usage checks fail closed on disconnected or unidentifiable native state', async () => fixture(async ({ worktree }) => {
  const base = { connected: () => true, terminalCount: () => 0, queue: { list: async () => ({ entries: [] }) }, scheduler: { list: async () => ({ jobs: [], runs: [] }) }, request: async method => method === 'thread/loaded/list' ? { data: ['native'] } : {} };
  expect(await createWorktreeUsageCheck(base)(worktree)).toBe(true);
  expect(await createWorktreeUsageCheck({ ...base, connected: () => false })(worktree)).toBe(true);
  expect(await createWorktreeUsageCheck({ ...base, terminalCount: () => 1 })(worktree)).toBe(true);
}));
