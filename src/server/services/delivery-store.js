import { acquirePrivateLock } from './private-lock.js';
import { mkdir, open, lstat, readFile, rename, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
const startStamp = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8')
      .split(') ')
      .at(-1)
      .split(' ')[19];
  } catch {
    return null;
  }
};
export const scheduleOwner = () => ({
  pid: process.pid,
  host: hostname(),
  stamp: startStamp(process.pid),
  instance: randomUUID()
});
export function scheduleOwnerAlive(owner) {
  if (
    !owner ||
    owner.host !== hostname() ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1
  )
    return false;
  try {
    process.kill(owner.pid, 0);
    return !owner.stamp || startStamp(owner.pid) === owner.stamp;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
const empty = () => ({ format: 1, revision: 0, entries: [] });
export function createDeliveryStore(privateRoot) {
  const directory = join(privateRoot, 'remote-web-delivery'),
    file = join(directory, 'queue.json'),
    lock = join(directory, 'write.lock');
  async function safeFile(path) {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 8 * 1024 * 1024
    )
      throw new Error('Unsafe delivery queue state');
    return stat;
  }
  async function load() {
    try {
      await safeFile(file);
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (
        data.format !== 1 ||
        !Array.isArray(data.entries) ||
        data.entries.length > 1000
      )
        throw new Error('Invalid delivery queue state');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return empty();
      throw error;
    }
  }
  async function exists() {
    try {
      await lstat(file);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  async function transaction(change) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw new Error('Unsafe delivery queue directory');
    const token = randomUUID();
    const release = await acquirePrivateLock(lock, { legacyOwnerAlive: scheduleOwnerAlive });
    try {
      const state = await load(),
        result = await change(state);
      if (result.changed !== false) {
        state.revision++;
        const terminal = new Set(['completed', 'cancelled']);
        const recent = new Set(state.entries.filter(entry => terminal.has(entry.status)).slice(-100));
        state.entries = state.entries.filter(entry => !terminal.has(entry.status) || recent.has(entry));
        const data = JSON.stringify(state);
        if (Buffer.byteLength(data) > 8 * 1024 * 1024)
          throw new Error('Delivery queue storage limit reached');
        const temporary = join(directory, `.state-${token}`),
          fd = await open(temporary, 'wx', 0o600);
        try {
          await fd.writeFile(data);
          await fd.sync();
        } finally {
          await fd.close();
        }
        try {
          await rename(temporary, file);
          const dir = await open(directory, 'r');
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        } finally {
          await unlink(temporary).catch(() => {});
        }
      }
      return result.value;
    } finally {
      await release();
    }
  }
  return {
    transaction,
    exists,
    async read() {
      if (!(await exists())) return empty();
      return transaction((state) => ({ value: state, changed: false }));
    }
  };
}
