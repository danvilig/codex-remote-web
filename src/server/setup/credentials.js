import { constants } from 'node:fs';
import { open, mkdir, lstat, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicPrivate } from './deployment.js';
import { SetupError } from './cloudflare.js';

// A local owner credential, separate from deployment receipts, runtime env and release files.
// Never send its value to a browser or follow a symbolic link when reading it.
export class SetupCredentials {
  constructor(directory) { this.directory = directory; this.path = join(directory, 'management-token.json'); }
  async read() {
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2048 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error();
      const data = JSON.parse(await handle.readFile('utf8'));
      if (data.version !== 1 || typeof data.token !== 'string' || !/^[A-Za-z0-9_.-]{16,512}$/.test(data.token)) throw new Error();
      return data.token;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new SetupError('The saved management token cannot be read securely. Replace or forget it.', 400);
    } finally { await handle?.close(); }
  }
  async save(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{16,512}$/.test(token)) throw new SetupError('Enter a valid Cloudflare API token.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new SetupError('The management credential directory is not a private local directory.', 400);
    await chmod(this.directory, 0o700);
    await atomicPrivate(this.path, JSON.stringify({ version: 1, token }) + '\n');
  }
  async forget() { await rm(this.path, { force: true }); }
}
