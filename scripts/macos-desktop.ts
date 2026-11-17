import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './distribution.ts';
import { macIcon } from './macos-dmg.ts';
import { macosMinimumVersion } from './macos-validation.ts';
import { nativeTranslations } from '../desktop/localization.js';

// Only macOS uses the system WebKit shell. Portable CLI, Windows and Linux
// retain their runtime contracts and do not depend on a user-installed Node.
export async function nativeMacDesktop(gateway: string, output: string, root: string, pkg: { version: string }) {
  const destination = join(output, 'Codex Remote Web-darwin-arm64');
  const app = join(destination, 'Codex Remote Web.app'), contents = join(app, 'Contents');
  const resources = join(contents, 'Resources'), assets = join(resources, 'desktop');
  await mkdir(join(contents, 'MacOS'), { recursive: true }); await mkdir(assets, { recursive: true });
  await cp(gateway, join(resources, 'gateway'), { recursive: true });
  const result = await Bun.build({ entrypoints: [join(root, 'desktop/renderer.js')], outdir: assets, naming: 'renderer.js', target: 'browser', format: 'esm', packages: 'bundle' });
  if (!result.success) throw new Error(result.logs.join('\n'));
  for (const file of ['index.html', 'desktop.css']) await cp(join(root, 'desktop', file), join(assets, file));
  for (const file of ['style.css', 'workspace.css', 'remote-access.css']) await cp(join(root, 'public', file), join(assets, file));
  // Reuse original app/tray artwork and shared translations; no duplicated
  // renderer or external image assets enter the native app.
  const { trayPng } = await import('./desktop.ts');
  await writeFile(join(assets, 'tray.png'), trayPng());
  await writeFile(join(resources, 'native-localization.json'), JSON.stringify(nativeTranslations));
  await cp(await macIcon(root, output), join(resources, 'app.icns'));
  const info = { CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'Codex Remote Web', CFBundleName: 'Codex Remote Web', CFBundleExecutable: 'Codex Remote Web', CFBundleIdentifier: 'io.github.danvilig.codex-remote-web', CFBundlePackageType: 'APPL', CFBundleShortVersionString: pkg.version, CFBundleVersion: pkg.version.split('-')[0], CFBundleIconFile: 'app.icns', LSMinimumSystemVersion: macosMinimumVersion, NSHighResolutionCapable: true, NSPrincipalClass: 'NSApplication', CFBundleLocalizations: ['en', 'zh-Hans'] };
  await writeFile(join(contents, 'Info.plist'), JSON.stringify(info));
  await command(['plutil', '-convert', 'xml1', join(contents, 'Info.plist')], root);
  await command(['xcrun', 'swiftc', '-O', '-whole-module-optimization', '-target', `arm64-apple-macosx${macosMinimumVersion}`, '-framework', 'AppKit', '-framework', 'WebKit', join(root, 'desktop/macos/App.swift'), '-o', join(contents, 'MacOS/Codex Remote Web')], root, { timeoutMs: 120_000, stream: true });
  await command(['strip', '-S', '-x', join(contents, 'MacOS/Codex Remote Web')], root);
  return destination;
}
