import { chmod, cp, mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export function portableTarget(platform = process.platform, arch = process.arch) {
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64') || (platform === 'darwin' && arch !== 'arm64')) throw new Error('Supported native builds: Linux x64/arm64, macOS arm64, Windows x64');
  return { platform, arch, label: platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux', extension: platform === 'win32' ? 'zip' : 'tar.gz', executable: `codex-remote-web${platform === 'win32' ? '.exe' : ''}`, node: `node${platform === 'win32' ? '.exe' : ''}`, bun: `bun-${platform === 'win32' ? 'windows' : platform}-${arch}${arch === 'x64' ? '-baseline' : ''}` };
}
export async function command(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`${args[0]} failed: ${error.slice(-4000)}`);
  return out.trim();
}
export async function pack(stage: string, archive: string) {
  // Linux retains reproducible GNU tar metadata. BSD tar on macOS/Windows has
  // different flags; Windows bsdtar writes zip and includes dotfiles as well.
  const args = archive.endsWith('.zip') ? ['-a', '-cf'] : process.platform === 'linux' ? ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf'] : ['-czf'];
  await command(['tar', ...args, archive, '-C', dirname(stage), basename(stage)], dirname(stage));
}
export async function copyPtyNative(source: string, destination: string, platform = process.platform) {
  let folder = join(source, 'build/Release');
  try { await readdir(folder); } catch (error) { if (error.code !== 'ENOENT') throw error; folder = join(source, 'prebuilds', `${platform}-${process.arch}`); }
  const names = await readdir(folder);
  const required = platform === 'win32' ? ['conpty.node', 'conpty_console_list.node'] : platform === 'darwin' ? ['pty.node', 'spawn-helper'] : ['pty.node'];
  for (const file of required) if (!names.includes(file)) throw new Error(`Missing native terminal artifact ${file}; rebuild node-pty on the target system`);
  await mkdir(join(destination, 'build/Release'), { recursive: true });
  // Copy runtime binaries only (including Windows DLLs/helpers), never obj,
  // pdb, source, build scripts or fixtures. Preserve nested runtime DLL paths.
  async function copy(directory: string, target: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!/^(?:obj|obj\.target|\.deps)$/.test(entry.name)) await copy(join(directory, entry.name), join(target, entry.name)); }
      else if (/\.(?:node|dll|exe)$/.test(entry.name) || entry.name === 'spawn-helper') { await mkdir(target, { recursive: true }); await cp(join(directory, entry.name), join(target, entry.name)); if (entry.name === 'spawn-helper') await chmod(join(target, entry.name), 0o755); }
    }
  }
  await copy(folder, join(destination, 'build/Release'));
}
