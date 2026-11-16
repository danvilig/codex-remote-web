import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateAccess } from '../config/private-access.js';
import { syncDirectory } from '../config/durability.js';

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateAccess(stat, path)) throw new Error('Desktop state must be in a private local directory');
}
export async function readPrivate(path, fallback = null) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144 || !privateAccess(stat, path)) throw new Error('Unsafe desktop state file');
    return JSON.parse(await file.readFile('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  finally { await file?.close(); }
}
export async function writePrivate(path, value) {
  await privateDirectory(dirname(path));
  // Inspect existing state rather than overwriting an unsafe link or shared file.
  await readPrivate(path);
  const temp = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if (!privateAccess(await file.stat(), temp)) throw new Error('Desktop state permissions are unsafe');
    await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); await file.close(); file = null;
    await rename(temp, path); await syncDirectory(dirname(path));
  } finally { await file?.close(); await rm(temp, { force: true }); }
}
