import { lstat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Only a trusted Electron-selected app data path is passed here, never a
// renderer path. Reject a redirected leaf before recursive removal.
export async function removeAppData(path) {
  const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || await realpath(path) !== join(await realpath(dirname(path)), basename(path))) throw new Error('Application data path is unsafe; cleanup stopped.');
  await rm(path, { recursive: true });
}
