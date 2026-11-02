import { realpathSync } from 'node:fs';
import { relative, isAbsolute, sep } from 'node:path';

// Native sessions may use a child directory or a symlinked spelling of the
// worktree. Failure to resolve an occupied directory must never authorize removal.
export function worktreeContainsCwd(worktree, cwd) {
  if (typeof cwd !== 'string' || !cwd) return true;
  try {
    const child = relative(realpathSync(worktree), realpathSync(cwd));
    return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep));
  } catch { return true; }
}

export function createWorktreeUsageCheck({ connected, terminalCount, queue, scheduler, request }) {
  return async worktree => {
    if (!connected() || terminalCount()) return true;
    const delivery = await queue.list();
    if (delivery.entries.some(entry => worktreeContainsCwd(worktree, entry.params?.cwd))) return true;
    const schedules = await scheduler.list();
    const activeJobs = new Set(schedules.runs.filter(run => ['starting', 'running', 'waiting', 'stopping'].includes(run.status)).map(run => run.jobId));
    if (schedules.jobs.some(job => (job.enabled || activeJobs.has(job.id)) && worktreeContainsCwd(worktree, job.cwd))) return true;
    let cursor;
    const cursors = new Set();
    do {
      const page = await request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) return true;
      for (const id of page.data) {
        const result = await request('thread/read', { threadId: typeof id === 'string' ? id : id.id, includeTurns: false });
        if (worktreeContainsCwd(worktree, result.thread?.cwd)) return true;
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) return true;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return false;
  };
}
