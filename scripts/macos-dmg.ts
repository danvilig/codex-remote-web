import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { macAppSize } from './macos-size.ts';
import { command } from './distribution.ts';

export const dmgLayout = { width: 680, height: 480, iconSize: 80, app: [170, 216], applications: [510, 216], help: [572, 394] };

export async function macIcon(root: string, output: string) {
  const iconset = join(output, 'app.iconset'); await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    await command(['sips', '-z', String(size * scale), String(size * scale), join(root, 'desktop/assets/app-icon.png'), '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], root);
  }
  const icon = join(output, 'app.icns');
  await command(['iconutil', '-c', 'icns', '-o', icon, iconset], root);
  return icon;
}

// JSON is not AppleScript quoting. Escape paths as literal strings; no shell.
const appleString = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
export function finderLayoutScript(mount: string) {
  return `tell application "Finder"
    set installerFolder to POSIX file ${appleString(mount)} as alias
    open installerFolder
    set installerWindow to container window of installerFolder
    set current view of installerWindow to icon view
    set toolbar visible of installerWindow to false
    set statusbar visible of installerWindow to false
    set bounds of installerWindow to {100, 100, ${114 + dmgLayout.width}, ${142 + dmgLayout.height}}
    set options to icon view options of installerWindow
    set arrangement of options to not arranged
    set icon size of options to ${dmgLayout.iconSize}
    set text size of options to 13
    set background picture of options to file ".background:installer.tiff" of installerFolder
    set position of item "Codex Remote Web.app" of installerFolder to {${dmgLayout.app}}
    set position of item "Applications" of installerFolder to {${dmgLayout.applications}}
    set position of item "Install Guide.html" of installerFolder to {${dmgLayout.help}}
    update installerFolder without registering applications
    delay 2
    close installerWindow
    delay 2
  end tell`;
}

export { installationHelp } from './macos-guide.ts';
import { installationHelp } from './macos-guide.ts';

export async function createMacDmg(app: string, installer: string, temp: string, root: string) {
  const image = join(temp, 'image'), mount = join(temp, 'mount'), writable = join(temp, 'installer-rw.dmg');
  await mkdir(join(image, '.background'), { recursive: true }); await mkdir(mount);
  await symlink('/Applications', join(image, 'Applications'));
  // A multi-representation TIFF preserves point dimensions while supplying
  // Retina pixels. A single 1x PNG gets enlarged and blurs all baked-in text.
  await command(['tiffutil', '-cathidpicheck', join(root, 'desktop/assets/dmg-background.png'), join(root, 'desktop/assets/dmg-background@2x.png'), '-out', join(image, '.background/installer.tiff')], root);
  await writeFile(join(image, 'Install Guide.html'), installationHelp);
  await command(['plutil', '-lint', join(image, 'Codex Remote Web.app/Contents/Info.plist')], root);
  const kilobytes = Number((await command(['du', '-sk', image], root)).split(/\s+/)[0]) + Number((await command(['du', '-sk', app], root)).split(/\s+/)[0]);
  if (!Number.isFinite(kilobytes) || kilobytes <= 0) throw new Error('Cannot size DMG payload');
  const megabytes = Math.max(512, Math.ceil(kilobytes / 1024 * 1.35 + 64));
  await command(['hdiutil', 'create', '-size', `${megabytes}m`, '-fs', 'HFS+', '-volname', 'Codex Remote Web', '-srcfolder', image, '-format', 'UDRW', writable], root);
  let mounted = false;
  try {
    await command(['hdiutil', 'attach', '-nobrowse', '-mountpoint', mount, writable], root); mounted = true;
    // Compress actual installed files with macOS transparent compression,
    // rather than only reducing the downloadable container. Finder preserves
    // this metadata when copying to an APFS/HFS+ destination.
    await command(['ditto', '--hfsCompression', app, join(mount, 'Codex Remote Web.app')], root, { timeoutMs: 120_000 });
    await command(['codesign', '--verify', '--deep', '--strict', join(mount, 'Codex Remote Web.app')], root);
    const sizePath = join(root, '.artifacts/macos-package-size.json');
    const size = await Bun.file(sizePath).json();
    size.compressed = await macAppSize(join(mount, 'Codex Remote Web.app'));
    await writeFile(sizePath, JSON.stringify(size, null, 2) + '\n');
    // Set the custom document icon on the mounted HFS+ image itself so its
    // resource fork survives compression and is independent of browser defaults.
    await command(['swift', '-e', `import AppKit
      guard let icon = NSImage(contentsOfFile: CommandLine.arguments[1]),
        NSWorkspace.shared.setIcon(icon, forFile: CommandLine.arguments[2], options: []) else { exit(1) }
    `, join(root, 'desktop/assets/guide-icon.png'), join(mount, 'Install Guide.html')], root, { timeoutMs: 60_000 });
    await command(['osascript', '-e', finderLayoutScript(mount)], root, { timeoutMs: 60_000 });
    // The Finder view must be persisted in the image, not just the host prefs.
    await Bun.file(join(mount, '.DS_Store')).bytes();
  } finally {
    if (mounted) await command(['hdiutil', 'detach', mount], root);
  }
  await command(['hdiutil', 'convert', writable, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', installer], root);
  await command(['hdiutil', 'verify', installer], root);
  await rm(writable);
}
