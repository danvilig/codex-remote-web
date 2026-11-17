import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signMacApp } from '../../scripts/macos-sign.ts';
import { command } from '../../scripts/distribution.ts';

test.skipIf(process.platform !== 'darwin')('modified app seals fail verification, are repaired inside out, and survive relocation', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'crw-signing-'));
  try {
    const app = join(temp, 'Fixture.app'), contents = join(app, 'Contents');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await mkdir(join(contents, 'Resources/gateway/runtime'), { recursive: true });
    await cp('/usr/bin/true', join(contents, 'MacOS/fixture'));
    await cp('/usr/bin/true', join(contents, 'Resources/gateway/runtime/node'));
    const plist = `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.crw.fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleName</key><string>Before packaging</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`;
    await writeFile(join(contents, 'Info.plist'), plist);
    await writeFile(join(contents, 'Resources/main.js'), 'original resource');
    await signMacApp(app);
    // Reproduce the package operation: change a sealed plist/resource after
    // the upstream app was signed. Running a binary directly misses this.
    await writeFile(join(contents, 'Info.plist'), plist.replace('Before packaging', 'After packaging'));
    await expect(command(['codesign', '--verify', '--deep', '--strict', app], temp)).rejects.toThrow();
    await signMacApp(app);
    const installed = join(temp, 'Installed path with spaces/Fixture.app');
    await cp(app, installed, { recursive: true, verbatimSymlinks: true });
    await command(['codesign', '--verify', '--deep', '--strict', installed], temp);
    await command(['codesign', '--verify', '--strict', join(installed, 'Contents/Resources/gateway/runtime/node')], temp);
    await writeFile(join(installed, 'Contents/Resources/main.js'), 'tampered resource');
    await expect(command(['codesign', '--verify', '--deep', '--strict', installed], temp)).rejects.toThrow();
  } finally { await rm(temp, { recursive: true, force: true }); }
}, 60_000);
