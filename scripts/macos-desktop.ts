import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command, portableTarget } from './distribution.ts';
import { macIcon } from './macos-dmg.ts';
import { installationHelp } from './macos-guide.ts';
import { macosMinimumVersion } from './macos-validation.ts';
import { nativeTranslations } from '../desktop/localization.js';
import { macAppSize } from './macos-size.ts';

async function compactGateway(gateway: string, root: string) {
  const target = portableTarget();
  const result = await Bun.build({ entrypoints: [join(root, 'src/server/cli.ts')], outdir: join(gateway, 'dist'), naming: 'portable.js', target: 'bun', packages: 'bundle', define: { CODEX_REMOTE_WEB_COMPILED: 'true', CODEX_REMOTE_WEB_NATIVE_MAC: 'true' } });
  if (!result.success) throw new Error(result.logs.join('\n'));
  await rm(join(gateway, target.executable));
  await command(['bun', 'build', '--compile', `--target=${target.bun}`, '--no-compile-autoload-bunfig', '--outfile', join(gateway, target.executable), join(gateway, 'dist/portable.js')], root, { timeoutMs: 120_000 });
  for (const file of ['runtime/node', 'runtime/NODE-LICENSE', 'node_modules/node-pty']) await rm(join(gateway, file), { recursive: true });
  const runtimes = join(gateway, 'runtime/RUNTIMES.json');
  await writeFile(runtimes, JSON.stringify(JSON.parse(await readFile(runtimes, 'utf8')).filter((runtime: { name: string }) => runtime.name !== 'Node.js'), null, 2) + '\n');
  await writeFile(join(gateway, 'runtime/REBUILD.md'), `# Rebuilding and relinking\n\nSee BUN-LICENSE.md and RUNTIMES.json for this Bun version's license and upstream sources.\n\nFrom the gateway directory, rebuild the self-contained runtime with a compatible Bun build:\n\n\`\`\`sh\nbun build --compile dist/portable.js --outfile codex-remote-web-rebuilt\n\`\`\`\n\nKeep the output next to public/, runtime/ and dist/. Quit the application and remove its background component before replacing the executable. Re-sign the modified macOS bundle before launching it.\n`);
  const metadata = join(gateway, 'release.json');
  await writeFile(metadata, JSON.stringify({ ...JSON.parse(await readFile(metadata, 'utf8')), desktopRuntime: 'macos-native' }, null, 2) + '\n');
}

export async function nativeMacDesktop(gateway: string, output: string, root: string, pkg: { version: string }) {
  const destination = join(output, 'Codex Remote Web-darwin-arm64');
  const app = join(destination, 'Codex Remote Web.app'), contents = join(app, 'Contents');
  const resources = join(contents, 'Resources'), assets = join(resources, 'desktop');
  await mkdir(join(contents, 'MacOS'), { recursive: true }); await mkdir(assets, { recursive: true });
  const payload = join(resources, 'gateway');
  await cp(gateway, payload, { recursive: true });
  const portableGateway = await macAppSize(payload);
  await compactGateway(payload, root);
  const result = await Bun.build({ entrypoints: [join(root, 'desktop/renderer.js')], outdir: assets, naming: 'renderer.js', target: 'browser', format: 'esm', packages: 'bundle' });
  if (!result.success) throw new Error(result.logs.join('\n'));
  for (const file of ['index.html', 'desktop.css']) await cp(join(root, 'desktop', file), join(assets, file));
  for (const file of ['style.css', 'workspace.css', 'remote-access.css']) await cp(join(root, 'public', file), join(assets, file));
  // Reuse original app/tray artwork and shared translations; no duplicated
  // renderer or external image assets enter the native app.
  const { trayPng } = await import('./desktop.ts');
  await writeFile(join(assets, 'tray.png'), trayPng());
  await writeFile(join(resources, 'native-localization.json'), JSON.stringify(nativeTranslations));
  await writeFile(join(resources, 'Install Guide.html'), installationHelp);
  await cp(await macIcon(root, output), join(resources, 'app.icns'));
  const info = { CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'Codex Remote Web', CFBundleName: 'Codex Remote Web', CFBundleExecutable: 'Codex Remote Web', CFBundleIdentifier: 'io.github.danvilig.codex-remote-web', CFBundlePackageType: 'APPL', CFBundleShortVersionString: pkg.version, CFBundleVersion: pkg.version.split('-')[0], CFBundleIconFile: 'app.icns', LSMinimumSystemVersion: macosMinimumVersion, NSHighResolutionCapable: true, NSPrincipalClass: 'NSApplication', CFBundleLocalizations: ['en', 'zh-Hans'] };
  await writeFile(join(contents, 'Info.plist'), JSON.stringify(info));
  await command(['plutil', '-convert', 'xml1', join(contents, 'Info.plist')], root);
  await command(['xcrun', 'swiftc', '-O', '-whole-module-optimization', '-target', `arm64-apple-macosx${macosMinimumVersion}`, '-framework', 'AppKit', '-framework', 'WebKit', join(root, 'desktop/macos/App.swift'), '-o', join(contents, 'MacOS/Codex Remote Web')], root, { timeoutMs: 120_000, stream: true });
  await command(['strip', '-S', '-x', join(contents, 'MacOS/Codex Remote Web')], root);
  const helper = join(contents, 'Helpers/Background.app/Contents');
  await mkdir(join(helper, 'MacOS'), { recursive: true });
  await cp(join(contents, 'MacOS/Codex Remote Web'), join(helper, 'MacOS/Background'));
  await writeFile(join(helper, 'Info.plist'), JSON.stringify({ CFBundleExecutable: 'Background', CFBundleIdentifier: `${info.CFBundleIdentifier}.background`, CFBundlePackageType: 'APPL', CFBundleVersion: info.CFBundleVersion, LSMinimumSystemVersion: macosMinimumVersion, LSBackgroundOnly: true }));
  await command(['plutil', '-convert', 'xml1', join(helper, 'Info.plist')], root);
  await writeFile(join(root, '.artifacts/macos-package-size.json'), JSON.stringify({ portableGateway, app: await macAppSize(app), gateway: await macAppSize(payload) }, null, 2) + '\n');
  return destination;
}
