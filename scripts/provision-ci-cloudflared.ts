// Test tooling only: not included in desktop/portable runtime resources.
// Source and Apache-2.0 license: https://github.com/cloudflare/cloudflared
// Hashes verified against the official release notes and asset digests:
// https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0
import { createHash } from 'node:crypto';
import { mkdir, writeFile, chmod, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const version = '2026.11.0';
const targets = {
  x64: { asset: 'cloudflared-linux-amd64', sha256: '51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd' },
  arm64: { asset: 'cloudflared-linux-arm64', sha256: 'abe54a006acf9faf2d19ee9d953cb0d0804e92f59c5382a162e57b84d086f56f' },
};

export async function provisionCloudflared(directory: string, { platform = process.platform, arch = process.arch, download = fetch } = {}) {
  if (platform !== 'linux' || !(arch in targets)) throw new Error('CI cloudflared provisioning supports Linux x64/arm64 only');
  const target = targets[arch as keyof typeof targets];
  // Refuse an existing directory rather than overwrite a preexisting tool.
  await mkdir(directory, { mode: 0o700 });
  const pending = join(directory, 'cloudflared.download'), binary = join(directory, 'cloudflared');
  try {
    const response = await download(`https://github.com/cloudflare/cloudflared/releases/download/${version}/${target.asset}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`cloudflared download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== target.sha256) throw new Error('cloudflared SHA256 mismatch');
    await writeFile(pending, bytes, { flag: 'wx', mode: 0o600 });
    await chmod(pending, 0o700);
    await rename(pending, binary);
    console.log(`Verified cloudflared ${version} (${target.asset}, SHA256 ${target.sha256})`);
    return binary;
  } catch (error) {
    await rm(pending, { force: true });
    throw error;
  }
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('Usage: bun scripts/provision-ci-cloudflared.ts <new-directory>');
  await provisionCloudflared(resolve(process.argv[2]));
}
