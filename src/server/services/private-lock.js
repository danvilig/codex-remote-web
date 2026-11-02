import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const localLocks = new Set();
const busy = () => Object.assign(new Error('Private storage is busy. Retry shortly.'), { code: 'PRIVATE_LOCK_BUSY', status: 409 });

const unsafe = () => Object.assign(new Error('Unsafe private lock file'), { code: 'PRIVATE_LOCK_UNSAFE', status: 500 });
async function privateFile(path, create = false) {
  const fd = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 1024 * 1024 || (create && stat.nlink !== 1)) throw unsafe();
    return create ? null : JSON.parse(await fd.readFile('utf8'));
  } finally { await fd.close(); }
}

// SQLite's OS-backed reserved lock is the authority, never a PID marker. Lock
// files are stable inodes: do not unlink or rename them, including after crashes.
// Separate databases allow a per-thread lock to enclose store transactions.
export async function acquirePrivateLock(path, { timeoutMs = 5000, legacyOwnerAlive } = {}) {
  // Resolve aliases before any descriptor is opened. SQLite's process-wide
  // fcntl locks must not be disrupted by a second lexical path to its inode.
  path = join(await realpath(dirname(path)), basename(path));
  if (legacyOwnerAlive) {
    try {
      const legacy = await privateFile(path);
      if (!legacy?.owner || legacyOwnerAlive(legacy.owner))
        throw Object.assign(new Error('An older gateway may still own this lock. Stop it before upgrading.'), { code: 'PRIVATE_LOCK_LEGACY_BUSY', status: 409 });
      // A dead owner's old JSON marker remains untouched. Concurrent recovery
      // contenders coordinate on the same SQLite lock, not check/unlink races.
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const databasePath = `${path}.sqlite`;
  const deadline = Date.now() + timeoutMs;
  // POSIX record locks are process scoped: opening/closing the inode outside
  // SQLite while another local connection holds it would release its OS lock.
  // Serialize local opens too, before the safety file descriptor is created.
  while (localLocks.has(databasePath)) {
    if (Date.now() >= deadline) throw busy();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  localLocks.add(databasePath);
  let database;
  try {
    await privateFile(databasePath, true);
    database = new Database(databasePath, { create: true });
    database.exec('PRAGMA busy_timeout = 0');
    for (;;) {
      try { database.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if (!['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code)) throw error;
        if (Date.now() >= deadline) throw busy();
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  } catch (error) { database?.close(); localLocks.delete(databasePath); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try { database.exec('ROLLBACK'); } finally { database.close(); localLocks.delete(databasePath); }
  };
}
