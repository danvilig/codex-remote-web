import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { systemDesktopBudget } from './system-desktop-size.ts';
import { macosSidebarSamples, macosVisibleSidebarThreshold } from './macos-validation.ts';

const mac27Job = 'validate-dmg-macos-27-arm64';
const mac27Step = 'Mount, install, launch and inspect the same DMG on macOS 27';
const packages = {
  'linux-x64': ['deployment-linux-x64.tar.gz', 'desktop-linux-x64.deb', 'linux-x64.tar.gz'],
  'linux-arm64': ['deployment-linux-arm64.tar.gz', 'desktop-linux-arm64.deb', 'linux-arm64.tar.gz'],
  'darwin-arm64': ['macos-arm64.dmg', 'macos-arm64.tar.gz'],
  'win32-x64': ['windows-x64.msi', 'windows-x64.zip'],
};
const versions = {
  15: /^15\.\d+(?:\.\d+)?$/,
  27: /^27\.\d+(?:\.\d+)?$/,
};
const build = /^[0-9]+[A-Z][0-9]+[a-z]?$/;
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function nonemptyFile(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && info.size > 0, `Expected a nonempty regular file: ${path}`);
  return info.size;
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function macReport(dir, major, installer, sha, commit) {
  const report = await json(join(dir, 'macos-installation-check.json'));
  const { system, checks } = report;
  assert.equal(report.format, 1);
  assert.equal(report.sourceCommit, commit, `macOS ${major} source commit`);
  assert.equal(report.installer, installer);
  assert.equal(report.sha256, sha, `macOS ${major} tested a different DMG`);
  assert.equal(system.arch, 'arm64');
  assert.equal(system.major, major);
  assert.equal(system.expectedMajor, major);
  assert.match(system.version, versions[major]);
  assert.match(system.build, build);
  for (const check of ['dmgIntegrityAndMount', 'relocatedApplicationAndRuntimeSignatures', 'installedGatewayAndPty']) {
    assert.equal(checks[check], true, `macOS ${major}: ${check}`);
  }
  assert.equal(checks.minimumSystemVersion, '15.0');
  assert.equal(checks.gatewayRuntime, 'native-go');
  assert.equal(checks.desktopRuntime, 'system AppKit/WebKit');
  assert.deepEqual(checks.retinaBackground, { points: [680, 480], pixels: [[680, 480], [1360, 960]] });
  assert.equal(checks.guideCustomIcon.finderFlag, true);
  assert.ok(checks.guideCustomIcon.resourceBytes > 1024);
  assert.equal(checks.finderLayoutAndBackground.screenshot, 'macos-installer-native.png');
  const { allocatedBytes, logicalBytes } = checks.installedSize;
  assert.ok(Number.isSafeInteger(allocatedBytes) && allocatedBytes > 0 && allocatedBytes < 18_000_000);
  assert.ok(Number.isSafeInteger(logicalBytes) && logicalBytes < 28_000_000 && allocatedBytes < logicalBytes * 0.8);

  const lifecycle = await json(join(dir, 'macos-desktop-lifecycle.json'));
  for (const check of ['closeAndMinimizeReopen', 'quitWithGatewayContinuity', 'relaunchAndCleanUninstall']) {
    assert.equal(lifecycle[check], true, `macOS ${major}: ${check}`);
  }
  const samples = macosSidebarSamples(lifecycle);
  assert.ok(samples, `macOS ${major}: missing pixel evidence`);
  for (const { phase, suffix } of samples) {
    const captures = await Promise.allSettled(['onscreen', 'window'].map(source => nonemptyFile(join(dir, `macos-desktop-${source}${suffix}.png`))));
    assert.ok(captures.some(result => result.status === 'fulfilled'), `macOS ${major}: missing WindowServer capture for ${phase}`);
  }
  for (const file of ['macos-installer-native.png', 'macos-desktop-overview.png', 'macos-desktop-settings-light.png', 'macos-desktop-settings-dark.png', 'macos-native-menus.json']) {
    await nonemptyFile(join(dir, file));
  }
  return { report, samples };
}

export async function verifyCandidate(directory, tag, commit, { manualHash = '', manualVersion = '' } = {}) {
  assert.match(tag, /^v\d+\.\d+\.\d+-beta\.\d+$/);
  assert.match(commit, /^[a-f0-9]{40}$/);
  const run = await json(join(directory, 'run.json'));
  assert.equal(run.head_sha, commit);
  assert.equal(run.run_attempt, 1);
  assert.equal(run.status, 'completed');
  const jobs = await json(join(directory, 'jobs.json'));
  const required = ['compile-native-shell-macos-27', ...Object.keys(packages).map(platform => `package-${platform}`), mac27Job];
  assert.equal(jobs.total_count, required.length);
  assert.deepEqual(jobs.jobs.map(job => job.name).sort(), required.sort(), 'Unexpected native platform job set');
  for (const job of jobs.jobs) {
    assert.equal(job.status, 'completed', job.name);
    if (job.name !== mac27Job) assert.equal(job.conclusion, 'success', job.name);
  }
  const mac27 = jobs.jobs.find(job => job.name === mac27Job);
  assert.ok(['success', 'failure'].includes(mac27.conclusion), `${mac27Job}: ${mac27.conclusion}`);
  assert.equal(run.conclusion, mac27.conclusion, 'Unexpected native workflow conclusion');

  const prefix = `codex-remote-web-${tag.slice(1)}-`;
  const assets = [], sums = new Map(), desktopResults = [];
  let dmgSize;
  for (const [platform, suffixes] of Object.entries(packages)) {
    const artifact = join(directory, `release-${platform}`);
    // upload-artifact roots a single matching parent at that directory.
    // macOS also uploads reports from the parent of release/.
    const dir = (await readdir(artifact)).includes('release') ? join(artifact, 'release') : artifact;
    const names = suffixes.map(suffix => prefix + suffix);
    assert.deepEqual((await readdir(dir)).sort(), names.flatMap(name => [name, `${name}.sha256`]).sort(), `Unexpected archives for ${platform}`);
    for (const name of names) {
      const path = join(dir, name);
      const bytes = await nonemptyFile(path);
      await nonemptyFile(`${path}.sha256`);
      const sha = await digest(path);
      const line = `${sha}  ${name}`;
      assert.equal((await readFile(`${path}.sha256`, 'utf8')).replace(/\r?\n$/, ''), line, `Checksum mismatch for ${name}`);
      sums.set(name, line);
      assets.push(path, `${path}.sha256`);
      if (name.endsWith('.dmg')) dmgSize = bytes;
      if (/\.(?:msi|deb)$/.test(name)) {
        const [os, arch] = platform.split('-'), windows = os === 'win32';
        const report = await json(join(artifact, windows ? 'windows-desktop-installation.json' : 'linux-desktop-installation.json'));
        assert.equal(report.format, 1);
        assert.equal(report.sourceCommit, commit, `${platform} installer source commit`);
        assert.equal(report.platform, os);
        assert.equal(report.arch, arch);
        assert.equal(report.renderer, windows ? 'system-webview2' : 'system-webkitgtk');
        assert.equal(report.installer, name);
        assert.equal(report.sha256, sha, `${platform} tested a different desktop installer`);
        assert.equal(report.installerBytes, bytes);
        assert.ok(bytes < systemDesktopBudget.installerBytes);
        for (const measure of ['allocatedBytes', 'logicalBytes']) assert.ok(Number.isSafeInteger(report.installed[measure]) && report.installed[measure] > 0 && report.installed[measure] < systemDesktopBudget.installedBytes, `${platform} installed ${measure}`);
        for (const check of ['nativeControls', 'gatewaySurvivedWindowExit', 'uninstall']) assert.equal(report[check], true, `${platform} ${check}`);
        if (windows) assert.equal(report.uninstallWhileTrayRunning, true, 'Windows MSI uninstall was not checked with the tray running');
        desktopResults.push(`- ${platform} system WebView installer passed installed controls, gateway continuity and ${windows ? 'uninstall with the tray running' : 'uninstall'}. Download: ${bytes} bytes; installed: ${report.installed.allocatedBytes} allocated bytes (${report.installed.logicalBytes} logical bytes).`);
      }
    }
  }
  const dmg = `${prefix}macos-arm64.dmg`;
  const sha = sums.get(dmg).slice(0, 64);
  const mac15 = await macReport(join(directory, 'release-darwin-arm64'), 15, dmg, sha, commit);
  const newer = await macReport(join(directory, 'validation-macos-27-arm64'), 27, dmg, sha, commit);
  function requireUiPass({ report, samples }) {
    assert.equal(report.status, 'passed');
    assert.equal(report.failureCode, undefined);
    assert.equal(report.checks.installedDesktopLaunchUiAndLifecycle, true);
    for (const { phase, pixels } of samples) {
      assert.ok(pixels > macosVisibleSidebarThreshold, `Visible macOS UI did not pass the pixel threshold on ${phase}`);
    }
  }
  requireUiPass(mac15);
  const systemLabel = ({ report: { system } }) => `${system.version} (${system.build})`;
  const installerStep = mac27.steps.filter(step => step.name === mac27Step);
  assert.equal(installerStep.length, 1, 'Missing same-file macOS 27 installer step');
  assert.equal(installerStep[0].conclusion, mac27.conclusion);
  for (const name of ['Verify actual macOS 27 runtime', 'Select and verify the exact macOS 15-built DMG', 'Run actions/upload-artifact@v4']) {
    assert.equal(mac27.steps.find(step => step.name === name)?.conclusion, 'success', name);
  }
  let mac27Note;
  if (mac27.conclusion === 'success') {
    requireUiPass(newer);
    assert.ok(!manualHash && !manualVersion, 'Manual substitution is only for a visible composite failure');
    mac27Note = `macOS ${systemLabel(newer)} passed the same mounted installer, gateway, PTY, lifecycle and visible UI checks in CI.`;
  } else {
    assert.deepEqual(mac27.steps.filter(step => step.conclusion === 'failure').map(step => step.name), [mac27Step], 'Unrelated macOS 27 step failures');
    assert.ok(mac27.steps.every(step => ['success', 'failure', 'skipped'].includes(step.conclusion)), 'Incomplete macOS 27 steps');
    assert.equal(newer.report.status, 'failed');
    assert.equal(newer.report.failureCode, 'MACOS_VISIBLE_COMPOSITE', 'Only the Mac visible composite check is eligible for manual acceptance');
    assert.equal(newer.report.checks.installedDesktopLaunchAndLifecycle, true);
    assert.equal(newer.report.checks.installedDesktopLaunchUiAndLifecycle, undefined);
    const blank = newer.samples.filter(sample => sample.pixels <= macosVisibleSidebarThreshold);
    assert.ok(blank.length > 0, 'The reported visible composite failure needs a failed pixel measurement');
    assert.equal(manualHash, sha, 'Physical macOS 27 acceptance requires the exact DMG SHA-256');
    const match = /^(27\.\d+(?:\.\d+)?) \(([^)]+)\)$/.exec(manualVersion);
    assert.ok(match && build.test(match[2]), 'Enter the physical macOS 27 version and build from sw_vers');
    mac27Note = `macOS ${systemLabel(newer)} CI passed mounting, installation, gateway, PTY and lifecycle but failed the WindowServer capture (${blank.map(({ phase, pixels }) => `${phase}: ${pixels} sidebar ink pixels`).join('; ')}; requires more than ${macosVisibleSidebarThreshold}). The maintainer accepted mounting, installing and visible UI at launch and after reopening from close and minimize on a physical Mac running macOS ${manualVersion} with the identical DMG SHA-256.`;
  }

  const checksumPath = join(directory, 'SHA256SUMS');
  await writeFile(checksumPath, [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([, line]) => line).join('\n') + '\n');
  await writeFile(join(directory, 'assets.txt'), [...assets, checksumPath].join('\n') + '\n');
  const { allocatedBytes, logicalBytes } = mac15.report.checks.installedSize;
  await writeFile(join(directory, 'acceptance.md'), `- macOS ${systemLabel(mac15)} passed installation, gateway, PTY, lifecycle and visible UI. Minimum macOS is 15.0.\n- ${mac27Note}\n- The macOS DMG is ${dmgSize} bytes (SHA-256: \`${sha}\`); Finder installation used ${allocatedBytes} allocated bytes (${logicalBytes} logical bytes).\n${desktopResults.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyCandidate(resolve(process.argv[2]), process.argv[3], process.argv[4], {
    manualHash: process.env.MACOS27_MANUAL_SHA256,
    manualVersion: process.env.MACOS27_MANUAL_VERSION,
  });
}
