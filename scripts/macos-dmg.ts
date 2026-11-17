import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
    set background picture of options to file ".background:installer.png" of installerFolder
    set position of item "Codex Remote Web.app" of installerFolder to {${dmgLayout.app}}
    set position of item "Applications" of installerFolder to {${dmgLayout.applications}}
    set position of item "Install Guide.html" of installerFolder to {${dmgLayout.help}}
    update installerFolder without registering applications
    delay 2
    close installerWindow
    delay 2
  end tell`;
}

export const installationHelp = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Install Codex Remote Web</title>
<style>
*{box-sizing:border-box}body{margin:0;color:#1d1d1f;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:880px;margin:auto;padding:80px 28px 48px;text-align:center;animation:enter .85s ease-out both}.eyebrow{font-size:12px;color:#86868b;letter-spacing:1.4px}h1{font-size:clamp(32px,6vw,52px);font-weight:600;letter-spacing:-2px;margin:18px 0 14px}p{color:#6e6e73;font-size:16px;line-height:1.65}p.zh{font-size:13px;margin-top:-6px}
.flow{display:flex;align-items:center;justify-content:center;gap:clamp(24px,6vw,70px);margin:54px 0 48px}.tile{width:120px;transition:transform .3s ease}.tile:hover{transform:translateY(-6px)}.tile svg{width:104px;height:104px;filter:drop-shadow(0 10px 14px #0000000e)}.tile span{display:block;font-size:13px;margin-top:16px}.arrow{width:48px;height:24px;color:#a1a1a6;animation:drift 2.8s ease-in-out infinite}
.note{max-width:580px;margin:auto;border-top:1px solid #dedee3;padding-top:24px}h2{font-size:17px;font-weight:600;letter-spacing:-.3px;margin:0 0 12px}.note p{font-size:14px}.note .zh{font-size:12px}details{text-align:left;margin:26px auto 0;max-width:580px;border-top:1px solid #dedee3;padding-top:18px}summary{cursor:pointer;font-size:13px;color:#515154;padding:6px 0}details p{font-size:13px}a{color:#0066cc;text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,summary:focus-visible{outline:3px solid #0071e3;outline-offset:5px;border-radius:3px}footer{font-size:11px;color:#86868b;margin-top:42px}
@keyframes enter{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}@keyframes drift{0%,100%{transform:translateX(-3px);opacity:.5}50%{transform:translateX(3px);opacity:1}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}@media(max-width:500px){main{padding-top:48px}h1{letter-spacing:-1px}.tile{width:92px}.tile svg{width:80px;height:80px}.flow{gap:20px}.tile span{font-size:11px}}
</style><main><div class="eyebrow">MACOS · APPLE SILICON</div><h1>Make room for your workspace.</h1><p>Drag Codex Remote Web into Applications.</p><p class="zh" lang="zh-CN">将应用拖入“应用程序”，然后从那里打开。</p>
<div class="flow" aria-label="Drag the app to Applications"><div class="tile"><svg aria-hidden="true" viewBox="0 0 128 128"><rect x="4" y="4" width="120" height="120" rx="28" fill="#e4efeb"/><rect x="25" y="29" width="78" height="68" rx="11" fill="#1c3030"/><path d="M25 47h78" stroke="#42615c" stroke-width="3"/><circle cx="35" cy="38" r="2" fill="#86b2a5"/><circle cx="43" cy="38" r="2" fill="#86b2a5"/><path d="m40 59 14 12-14 12m28 0h20" stroke="#edf6f2" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Codex Remote Web</span></div>
<svg class="arrow" aria-hidden="true" viewBox="0 0 48 24" fill="none"><path d="M2 12h42M35 3l9 9-9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
<div class="tile"><svg aria-hidden="true" viewBox="0 0 128 128"><path d="M8 35a8 8 0 0 1 8-8h35l12 12h49a8 8 0 0 1 8 8v59H8z" fill="#70b9ec"/><rect x="8" y="44" width="112" height="66" rx="9" fill="#8bcaf3"/><path d="m51 64 24 32m2-32-24 32m-9-8h43" fill="none" stroke="#e7f5ff" stroke-width="6" stroke-linecap="round"/></svg><span>Applications</span></div></div>
<section class="note"><h2>A one-time welcome.</h2><p>Copy first, then eject the installer disk.<br>If macOS blocks this test build, go to<br><b>System Settings → Privacy &amp; Security → Open Anyway.</b></p><p class="zh" lang="zh-CN">复制后推出磁盘。首次若被阻止：<br>系统设置 → 隐私与安全性 → 仍要打开。</p></section>
<details><summary>Before you start / 开始之前</summary><p>Requires macOS 15+ and an Apple Silicon Mac (M-series). Intel Macs are not supported. Install and configure Codex CLI and Git before gateway setup; cloudflared is only needed for public remote access.</p><p lang="zh-CN">需要 macOS 15+ 与 Apple 芯片（M 系列），不支持 Intel Mac。初始化前请安装并配置 Codex CLI 和 Git；公网访问才需要 cloudflared。</p></details>
<details><summary>About this test build / 测试包说明</summary><p>This build has an ad-hoc integrity signature, with no Apple Developer ID or notarization. After attempting to open it, you may need to explicitly allow it in System Settings. Only approve a build whose source you trust. <a href="https://support.apple.com/102445">Apple's instructions</a>.</p><p lang="zh-CN">本包完成本地完整性签名，尚无 Apple 开发者签名及公证。首次尝试打开后可能需要手动允许；仅允许来源可信的构建。</p><p>If macOS still says the app is <b>damaged</b>, stop and report the warning, macOS version and package SHA-256. Do not disable Gatekeeper or remove quarantine attributes to bypass that error.</p><p lang="zh-CN">若仍提示“已损坏”，请停止并反馈原始提示、系统版本与 SHA-256；不要关闭 Gatekeeper 或清除隔离属性来绕过错误。</p></details>
<footer>Codex Remote Web · macOS 15+ · Apple Silicon</footer></main></html>`;

export async function createMacDmg(app: string, installer: string, temp: string, root: string) {
  const image = join(temp, 'image'), mount = join(temp, 'mount'), writable = join(temp, 'installer-rw.dmg');
  await mkdir(join(image, '.background'), { recursive: true }); await mkdir(mount);
  await cp(app, join(image, 'Codex Remote Web.app'), { recursive: true, verbatimSymlinks: true });
  await symlink('/Applications', join(image, 'Applications'));
  await cp(join(root, 'desktop/assets/dmg-background.png'), join(image, '.background/installer.png'));
  await writeFile(join(image, 'Install Guide.html'), installationHelp);
  await command(['plutil', '-lint', join(image, 'Codex Remote Web.app/Contents/Info.plist')], root);
  const kilobytes = Number((await command(['du', '-sk', image], root)).split(/\s+/)[0]);
  if (!Number.isFinite(kilobytes) || kilobytes <= 0) throw new Error('Cannot size DMG payload');
  const megabytes = Math.max(512, Math.ceil(kilobytes / 1024 * 1.35 + 64));
  await command(['hdiutil', 'create', '-size', `${megabytes}m`, '-fs', 'HFS+', '-volname', 'Codex Remote Web', '-srcfolder', image, '-format', 'UDRW', writable], root);
  let mounted = false;
  try {
    await command(['hdiutil', 'attach', '-nobrowse', '-mountpoint', mount, writable], root); mounted = true;
    await command(['osascript', '-e', finderLayoutScript(mount)], root, { timeoutMs: 60_000 });
    // The Finder view must be persisted in the image, not just the host prefs.
    await Bun.file(join(mount, '.DS_Store')).bytes();
  } finally {
    if (mounted) await command(['hdiutil', 'detach', mount], root);
  }
  await command(['hdiutil', 'convert', writable, '-format', 'UDZO', '-o', installer], root);
  await command(['hdiutil', 'verify', installer], root);
  await rm(writable);
}
