import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './distribution.ts';

const machoMagic = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
export async function isMachO(path: string) {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(4);
    return (await file.read(bytes, 0, 4, 0)).bytesRead === 4 && machoMagic.has(bytes.toString('hex'));
  } finally { await file.close(); }
}

// Packager changes Electron's executable names, plists and sealed resources.
// Rebuild signatures only AFTER payload, artwork and permissions are final.
// Ad-hoc signing restores integrity; it is NOT Developer ID or notarization.
export async function signMacApp(app: string) {
  if (process.platform !== 'darwin') throw new Error('macOS signing requires native codesign');
  const binaries: string[] = [], bundles: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      // Never follow framework aliases or escape the installation tree.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(path);
        if (/\.(?:app|framework|xpc|bundle)$/.test(entry.name)) bundles.push(path);
      } else if (entry.isFile() && await isMachO(path)) binaries.push(path);
    }
  }
  await visit(app);
  const sign = (path: string) => command(['codesign', '--force', '--sign', '-', '--timestamp=none', '--preserve-metadata=entitlements', path], app);
  // Sign inside out, explicitly including gateway/Bun, Node, PTY addons and
  // spawn-helper in Resources (not just Electron's nested framework bundles).
  for (const binary of binaries) await sign(binary);
  for (const bundle of [...bundles, app]) await sign(bundle);
  for (const binary of binaries) await command(['codesign', '--verify', '--strict', binary], app);
  await command(['codesign', '--verify', '--deep', '--strict', app], app);
}
