import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './distribution.ts';

// Count inode blocks as well as logical bytes: Finder's apparent size and
// actual disk allocation differ for transparently compressed macOS files.
export async function macAppSize(path: string) {
  const seen = new Set<string>();
  const result = { logicalBytes: 0, allocatedBytes: 0, files: 0 };
  async function visit(file: string) {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { for (const name of await readdir(file)) await visit(join(file, name)); return; }
    const key = `${stat.dev}:${stat.ino}`;
    if (seen.has(key)) return;
    seen.add(key); result.files++; result.logicalBytes += stat.size; result.allocatedBytes += stat.blocks * 512;
  }
  await visit(path);
  return result;
}
export async function trimMacApp(app: string, root: string) {
  const before = await macAppSize(app);
  // The native AppKit/WebKit shell has no Chromium payload. Strip only
  // Node's debug/local symbols; the compiled Bun image must stay intact.
  // All signatures are rebuilt after this final mutation.
  await command(['strip', '-S', '-x', join(app, 'Contents/Resources/gateway/runtime/node')], root);
  return { before, trimmed: await macAppSize(app), components: {
    shell: await macAppSize(join(app, 'Contents/MacOS')),
    gateway: await macAppSize(join(app, 'Contents/Resources/gateway')),
    node: await macAppSize(join(app, 'Contents/Resources/gateway/runtime')),
  } };
}
