import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export function portableTarget(platform = process.platform, arch = process.arch) {
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64') || (platform === 'darwin' && arch !== 'arm64')) throw new Error('Supported native builds: Linux x64/arm64, macOS arm64, Windows x64');
  return { platform, arch, label: platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux', extension: platform === 'win32' ? 'zip' : 'tar.gz', executable: `codex-remote-web${platform === 'win32' ? '.exe' : ''}`, node: `node${platform === 'win32' ? '.exe' : ''}`, bun: `bun-${platform === 'win32' ? 'windows' : platform}-${arch}${arch === 'x64' ? '-baseline' : ''}` };
}
export async function command(args: string[], cwd: string, options: { stream?: boolean; timeoutMs?: number } = {}) {
  if (options.stream) console.error(`Running: ${args.join(' ')}`);
  const child = Bun.spawn(args, { cwd, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs) : undefined;
  async function collect(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder(); let result = '';
    for await (const chunk of stream) { const value = decoder.decode(chunk, { stream: true }); result += value; if (options.stream) process.stderr.write(value); }
    return result + decoder.decode();
  }
  let out: string, error: string, code: number;
  try { [out, error, code] = await Promise.all([collect(child.stdout), collect(child.stderr), child.exited]); }
  finally { clearTimeout(timer); }
  if (timedOut) throw new Error(`${args[0]} timed out after ${options.timeoutMs}ms: ${error.slice(-4000)}\n${out.slice(-4000)}`);
  if (code) throw Object.assign(new Error(`${args[0]} failed (${code}): ${error.slice(-4000)}\n${out.slice(-4000)}`), { exitCode: code });
  return out.trim();
}
export async function pack(stage: string, archive: string) {
  // Linux retains reproducible GNU tar metadata. BSD tar on macOS/Windows has
  // different flags; Windows bsdtar writes zip and includes dotfiles as well.
  const args = archive.endsWith('.zip') ? ['-a', '-cf'] : process.platform === 'linux' ? ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf'] : ['-czf'];
  await command(['tar', ...args, archive, '-C', dirname(stage), basename(stage)], dirname(stage));
}
export async function copyPtyNative(source: string, destination: string, platform = process.platform) {
  const required = platform === 'win32' ? ['conpty.node', 'conpty_console_list.node'] : platform === 'darwin' ? ['pty.node', 'spawn-helper'] : ['pty.node'];
  const built = join(source, 'build/Release'), prebuilt = join(source, 'prebuilds', `${platform}-${process.arch}`);
  let folder = built;
  const builtNames = await readdir(built).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
  if (!required.every(file => builtNames.includes(file))) folder = prebuilt;
  const names = await readdir(folder);
  for (const file of required) if (!names.includes(file)) throw new Error(`Missing native terminal artifact ${file}; rebuild node-pty on the target system`);
  await mkdir(join(destination, 'build/Release'), { recursive: true });
  if (platform === 'win32') {
    // Supported Windows 11 uses the OS ConPTY API (useConptyDll defaults false).
    // Do not ship unused WinPTY or redistributable OpenConsole/DLL payloads.
    for (const file of required) await cp(join(folder, file), join(destination, 'build/Release', file));
    return;
  }
  // Copy runtime binaries only (including Windows DLLs/helpers), never obj,
  // pdb, source, build scripts or fixtures. Preserve nested runtime DLL paths.
  async function copy(directory: string, target: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!/^(?:obj|obj\.target|\.deps)$/.test(entry.name)) await copy(join(directory, entry.name), join(target, entry.name)); }
      else if (/\.(?:node|dll|exe)$/.test(entry.name) || entry.name === 'spawn-helper') { await mkdir(target, { recursive: true }); await cp(join(directory, entry.name), join(target, entry.name)); if (entry.name === 'spawn-helper') await chmod(join(target, entry.name), 0o755); }
    }
  }
  await copy(folder, join(destination, 'build/Release'));
  if (folder !== built && builtNames.length) await copy(built, join(destination, 'build/Release'));
}

// Stable UUIDv5 component identities keep MSI repair/upgrade/uninstall coherent
// across installation paths. The namespace belongs to this product family.
export function installerGuid(name: string) {
  const bytes=createHash('sha1').update(Buffer.from('8f8555d4c0e04b2f94573c824076eb40','hex')).update(name).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
