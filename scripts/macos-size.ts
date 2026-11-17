import { lstat, readdir, rm } from 'node:fs/promises';
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
  // Strip only the bundled Node executable's debug/local symbols. Do not
  // rewrite Electron or Bun binaries; signing follows this final mutation.
  await command(['strip', '-S', '-x', join(app, 'Contents/Resources/gateway/runtime/node')], root);
  const resources = join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources');
  const keep = new Set(['en.lproj', 'en_GB.lproj', 'zh_CN.lproj', 'zh_TW.lproj', 'Base.lproj']);
  for (const name of await readdir(resources)) if (name.endsWith('.lproj') && !keep.has(name)) await rm(join(resources, name), { recursive: true });
  // Symbols are for crash analysis, not execution. Retain runtime notices.
  for (const directory of [join(app, 'Contents/Resources'), resources]) {
    for (const name of await readdir(directory)) if (name.endsWith('.dSYM') || name.endsWith('.debug') || name === 'default_app.asar') await rm(join(directory, name), { recursive: true });
  }
  return { before, trimmed: await macAppSize(app) };
}
