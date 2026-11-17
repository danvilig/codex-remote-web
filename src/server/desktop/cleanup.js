import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquirePrivateLock } from '../services/private-lock.js';
import { privateDirectory, readPrivate } from './private-store.js';

export const cleanupFiles = ['config.json', 'management-token.json', 'setup-state.json'];
export async function assertDesktopCleanup(directory) {
  const receipt = await readPrivate(join(directory, 'setup-state.json'));
  if (receipt && receipt.phase !== 'removed') throw new Error('Remove the remote deployment in Remote access before cleaning up.');
  for (const name of ['protected-gateway.json', 'tunnel-token.json', 'setup.lock', 'session-windows-pending.json']) {
    if (await lstat(join(directory, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error('Finish remote access or startup recovery before cleaning up.');
  }
  // Preflight every file before deleting any; unsafe links must remain visible.
  for (const name of cleanupFiles) await readPrivate(join(directory, name));
}
export async function cleanDesktopState(directory) {
  await privateDirectory(directory);
  // Use the established stable lock inodes; never unlink them or their parent
  // while another contender could still be waiting on the same inode.
  const releaseAgent = await acquirePrivateLock(join(directory, 'agent-lock'), { timeoutMs: 10000 });
  let releaseSession;
  try {
    releaseSession = await acquirePrivateLock(join(directory, 'session-lock'));
    if (await readPrivate(join(directory, 'agent.json')) || await readPrivate(join(directory, 'session.json'))) throw new Error('Stop and remove the background component before cleaning up.');
    await assertDesktopCleanup(directory);
    for (const name of cleanupFiles) await rm(join(directory, name), { force: true });
    // Unknown files, headless deployments, projects and ~/.codex are outside
    // this exact list. Lock anchors and the generation tombstone contain no
    // user settings and intentionally remain safe for concurrent launchers.
    return { removed: [...cleanupFiles] };
  } finally { await releaseSession?.(); await releaseAgent(); }
}
