import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { provisionCloudflared } from '../../scripts/provision-ci-cloudflared.ts';

test('CI cloudflared rejects unverified bytes before creating an executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-cloudflared-')), directory = join(root, 'tool');
  try {
    await expect(provisionCloudflared(directory, { platform: 'linux', arch: 'x64', download: async () => new Response('untrusted executable') })).rejects.toThrow('SHA256 mismatch');
    expect(await Bun.file(join(directory, 'cloudflared')).exists()).toBe(false);
    expect(await Bun.file(join(directory, 'cloudflared.download')).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CI cloudflared HTTP failure is fatal and existing tool directories are preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-cloudflared-')), directory = join(root, 'tool');
  try {
    await expect(provisionCloudflared(directory, { platform: 'linux', arch: 'arm64', download: async () => new Response('', { status: 404 }) })).rejects.toThrow('HTTP 404');
    await writeFile(join(directory, 'cloudflared'), 'preserve existing');
    await expect(provisionCloudflared(directory, { platform: 'linux', arch: 'arm64' })).rejects.toThrow();
    expect(await readFile(join(directory, 'cloudflared'), 'utf8')).toBe('preserve existing');
    await expect(provisionCloudflared(join(root, 'unsupported'), { platform: 'win32', arch: 'x64' })).rejects.toThrow('Linux');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a required but missing cloudflared fails before the release gate starts other suites', async () => {
  const emptyPath = await mkdtemp(join(tmpdir(), 'ci-cloudflared-empty-'));
  try {
    const result = spawnSync(process.execPath, [join(import.meta.dir, '../../scripts/verify-release.ts')], {
      env: { ...process.env, PATH: emptyPath, CODEX_WEBUI_REQUIRE_CLOUDFLARED: '1' }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('requires the verified cloudflared binary');
    expect(result.stdout).not.toContain('Verifying:');
  } finally { await rm(emptyPath, { recursive: true, force: true }); }
});
