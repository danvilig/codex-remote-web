import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { verifyCandidate } from '../../scripts/verify-platform-candidate.mjs';

async function candidate(t, failure = false) {
  const dir = await mkdtemp(join(tmpdir(), 'crw-release-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tag = 'v0.2.0-beta.2', sha = 'a'.repeat(40), dmg = 'codex-remote-web-0.2.0-beta.2-macos-arm64.dmg';
  const mac27 = 'validation-macos-27-arm64';
  const hash = createHash('sha256').update('archive fixture').digest('hex');
  const write = async (file, contents) => {
    const path = join(dir, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  };
  const archives = {
    'darwin-arm64/release': ['macos-arm64.dmg', 'macos-arm64.tar.gz'],
    'win32-x64': ['windows-x64.msi', 'windows-x64.zip'],
    'linux-arm64': ['linux-arm64.tar.gz', 'desktop-linux-arm64.deb', 'deployment-linux-arm64.tar.gz'],
    'linux-x64': ['linux-x64.tar.gz', 'desktop-linux-x64.deb', 'deployment-linux-x64.tar.gz'],
  };
  for (const [platform, suffixes] of Object.entries(archives)) {
    for (const suffix of suffixes) {
      const name = `codex-remote-web-0.2.0-beta.2-${suffix}`;
      const path = `release-${platform}/${name}`;
      await write(path, 'archive fixture');
      await write(`${path}.sha256`, `${hash}  ${name}\n`);
    }
  }
  const conclusion = failure ? 'failure' : 'success';
  await write('run.json', { head_sha: sha, run_attempt: 1, status: 'completed', conclusion });
  const steps = ['Verify actual macOS 27 runtime', 'Select and verify the exact macOS 15-built DMG', 'Run actions/upload-artifact@v4'].map(name => ({ name, conclusion: 'success' }));
  steps.push({ name: 'Mount, install, launch and inspect the same DMG on macOS 27', conclusion });
  const jobs = ['compile-native-shell-macos-27', 'package-darwin-arm64', 'package-win32-x64', 'package-linux-arm64', 'package-linux-x64'].map(name => ({ name, status: 'completed', conclusion: 'success' }));
  jobs.push({ name: 'validate-dmg-macos-27-arm64', status: 'completed', conclusion, steps });
  await write('jobs.json', { total_count: jobs.length, jobs });
  for (const [major, platform] of [[15, 'release-darwin-arm64'], [27, mac27]]) {
    const failed = major === 27 && failure;
    await write(`${platform}/macos-installation-check.json`, {
      format: 1, status: failed ? 'failed' : 'passed', failureCode: failed ? 'MACOS_VISIBLE_COMPOSITE' : undefined,
      sourceCommit: sha, installer: dmg, sha256: hash,
      system: { arch: 'arm64', major, expectedMajor: major, version: `${major}.0.1`, build: '26A434' },
      checks: { dmgIntegrityAndMount: true, relocatedApplicationAndRuntimeSignatures: true, installedGatewayAndPty: true,
        minimumSystemVersion: '15.0', gatewayRuntime: 'native-go', desktopRuntime: 'system AppKit/WebKit',
        retinaBackground: { points: [680, 480], pixels: [[680, 480], [1360, 960]] }, guideCustomIcon: { finderFlag: true, resourceBytes: 1025 },
        finderLayoutAndBackground: { screenshot: 'macos-installer-native.png' }, installedSize: { allocatedBytes: 1, logicalBytes: 2 },
        [failed ? 'installedDesktopLaunchAndLifecycle' : 'installedDesktopLaunchUiAndLifecycle']: true },
    });
    await write(`${platform}/macos-desktop-lifecycle.json`, { closeAndMinimizeReopen: true, quitWithGatewayContinuity: true,
      relaunchAndCleanUninstall: true, sidebarInkPixels: failed ? 100 : 101, reopenedSidebarInkPixels: { close: 101, minimize: 101 } });
    for (const name of ['macos-installer-native.png', 'macos-desktop-overview.png', 'macos-desktop-settings-light.png', 'macos-desktop-settings-dark.png', 'macos-desktop-onscreen.png', 'macos-native-menus.json']) {
      await write(`${platform}/${name}`, 'fixture');
    }
  }
  return { dir, write, dmg, hash, mac27, verify: options => verifyCandidate(dir, tag, sha, options) };
}

test('verifies the exact candidate and emits only the 21 verified release assets', async t => {
  const { dir, verify, write, dmg } = await candidate(t);
  await verify();
  const assets = (await readFile(join(dir, 'assets.txt'), 'utf8')).trim().split('\n');
  assert.equal(new Set(assets).size, 21);
  assert.equal((await readFile(join(dir, 'SHA256SUMS'), 'utf8')).trim().split('\n').length, 10);
  await write(`release-darwin-arm64/release/${dmg}`, 'different DMG');
  await assert.rejects(verify(), /Checksum mismatch/);
});

test('accepts a visible-only failure only with exact physical acceptance evidence', async t => {
  const { dir, verify, hash, mac27, write } = await candidate(t, true);
  const manual = { manualHash: hash, manualVersion: '27.0.1 (26A434)' };
  await assert.rejects(verify(), /exact DMG SHA-256/);
  await assert.rejects(verify({ ...manual, manualVersion: '15.8 (24H232)' }), /physical macOS 27 version/);
  await verify(manual);
  assert.match(await readFile(join(dir, 'acceptance.md'), 'utf8'), /failed the WindowServer capture \(100 sidebar ink pixels/);
  const report = `${mac27}/macos-installation-check.json`;
  const record = JSON.parse(await readFile(join(dir, report), 'utf8'));
  await write(report, { ...record, sha256: 'b'.repeat(64) });
  await assert.rejects(verify(manual), /different DMG/);
  await write(report, { ...record, failureCode: 'OTHER' });
  await assert.rejects(verify(manual), /Only the Mac visible composite check/);
  await write(report, record);
  const meta = JSON.parse(await readFile(join(dir, 'jobs.json'), 'utf8'));
  meta.jobs.at(-1).steps.push({ name: 'Unrelated test', conclusion: 'failure' });
  await write('jobs.json', meta);
  await assert.rejects(verify(manual), /Unrelated macOS 27 step failures/);
});
