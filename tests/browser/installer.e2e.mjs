import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, access, rm, readFile, readlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { command } from '../../scripts/distribution.ts';
import { macAppSize } from '../../scripts/macos-size.ts';
import { dmgLayout } from '../../scripts/macos-dmg.ts';
import { macOSValidationSystem, macosMinimumVersion } from '../../scripts/macos-validation.ts';
const root=resolve(import.meta.dir,'../..'),installer=process.env.CODEX_WEBUI_INSTALLER;
assert.ok(installer,'Test the actual installer, not a replacement build');
const temp=await mkdtemp(join(tmpdir(),'crw-installer-'));
let mounted=false,installed=false;
let evidence;
const mount=join(temp,'mount'),destination=join(temp,'Installed application with spaces');
async function msi(args) {
 console.error(`Verifying msiexec ${args[0]}`);
 const log=join(temp,args[0]==='/i'?'install.log':'uninstall.log');
 args=[...args,'/l*v',log];
 // msiexec parses PROPERTY="value with spaces", not the CRT-style quoted
 // whole argument "PROPERTY=value with spaces". Preserve its native grammar.
 const quote=value=>`"${value.replaceAll('"','""')}"`;
 const nativeArgs=args.map(arg=>arg.startsWith('INSTALLFOLDER=')?`INSTALLFOLDER=${quote(arg.slice('INSTALLFOLDER='.length))}`:arg.startsWith('/')?arg:quote(arg));
 const child=Bun.spawn(['msiexec.exe',...nativeArgs,'/qn','/norestart'],{windowsVerbatimArguments:true,stdout:'ignore',stderr:'ignore'});
 let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},120_000);
 let code;try {code=await child.exited;}finally{clearTimeout(timer);}
 assert.equal(timedOut,false,`msiexec ${args[0]} timed out; installer log: ${await readFile(log,'utf8').catch(()=>'(unavailable)')}`);
 assert.ok([0,3010].includes(code),`msiexec failed ${code}; installer log: ${await readFile(log,'utf8').catch(()=>'(unavailable)')}`);
}
try {
 if(process.platform==='darwin') {
  evidence={format:1,status:'running',system:await macOSValidationSystem(),installer:basename(installer),sha256:createHash('sha256').update(await readFile(installer)).digest('hex'),sourceCommit:await command(['git','rev-parse','HEAD'],root),checks:{},manualAcceptance:['Safari download quarantine','Gatekeeper manual approval','real login/logout session']};
  console.log('macOS installer validation:',JSON.stringify(evidence));
  await mkdir(mount);
  await command(['hdiutil','verify',installer],root);
  await command(['hdiutil','attach','-nobrowse','-readonly','-mountpoint',mount,installer],root);mounted=true;
  const app=join(mount,'Codex Remote Web.app');
  evidence.checks.dmgIntegrityAndMount=true;
  await command(['plutil','-lint',join(app,'Contents/Info.plist')],root);
  const minimum=await command(['plutil','-extract','LSMinimumSystemVersion','raw','-o','-',join(app,'Contents/Info.plist')],root);
  assert.equal(minimum,macosMinimumVersion,'New-system testing must not raise the macOS 15 minimum');
  evidence.checks.minimumSystemVersion=minimum;
  await command(['codesign','--verify','--deep','--strict',app],root);
  assert.equal(await readlink(join(mount,'Applications')),'/Applications');
  await access(join(mount,'.DS_Store'));
  await access(join(mount,'.background/installer.tiff'));
  assert.match(await readFile(join(mount,'Install Guide.html'),'utf8'),/Privacy & Security/);
  const representations=JSON.parse(await command(['swift','-e',`import AppKit
    let image = NSImage(contentsOfFile: CommandLine.arguments[1])!
    let sizes = image.representations.map { [$0.pixelsWide, $0.pixelsHigh] }.sorted { $0[0] < $1[0] }
    let result: [String: Any] = ["points": [Int(image.size.width), Int(image.size.height)], "pixels": sizes]
    print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
  `,join(mount,'.background/installer.tiff')],root,{timeoutMs:60_000}));
  assert.deepEqual(representations,{points:[680,480],pixels:[[680,480],[1360,960]]},'Finder needs a real Retina representation without doubling the layout');
  const finderInfo=Buffer.from((await command(['xattr','-px','com.apple.FinderInfo',join(mount,'Install Guide.html')],root)).replace(/\s/g,''),'hex');
  assert.ok((finderInfo.readUInt16BE(8)&0x0400)!==0,'Guide must retain the Finder custom-icon flag after compression');
  const resourceFork=Buffer.from((await command(['xattr','-px','com.apple.ResourceFork',join(mount,'Install Guide.html')],root)).replace(/\s/g,''),'hex');
  assert.ok(resourceFork.length>1024,'Guide icon resource fork must survive remounting');
  evidence.checks.retinaBackground=representations;
  evidence.checks.guideCustomIcon={finderFlag:true,resourceBytes:resourceFork.length};
  // Read the layout from the final compressed image after remounting. A
  // background PNG alone is insufficient: Finder must restore its positions.
  const quoted='"'+mount.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
  let layout;
  try { layout=await command(['osascript','-e',`tell application "Finder"
    activate
    set folderAlias to POSIX file ${quoted} as alias
    open folderAlias
    delay 2
    set w to container window of folderAlias
    set opts to icon view options of w
    set appPosition to position of item "Codex Remote Web.app" of folderAlias
    set targetPosition to position of item "Applications" of folderAlias
    set helpPosition to position of item "Install Guide.html" of folderAlias
    return {item 1 of appPosition, item 2 of appPosition, item 1 of targetPosition, item 2 of targetPosition, item 1 of helpPosition, item 2 of helpPosition, icon size of opts}
  end tell`],root); }
  finally { await command(['screencapture','-x',join(root,'.artifacts/macos-installer-native.png')],root); }
  assert.equal(layout,[...dmgLayout.app,...dmgLayout.applications,...dmgLayout.help,dmgLayout.iconSize].join(', '),`Final DMG lost Finder positions: ${layout}`);
  // Finder's background-picture getter throws -1728 on a read-only image
  // even when it renders correctly (retained native screenshots reproduce
  // this). Check the actual rendered background instead of that getter.
  const screenshot=join(root,'.artifacts/macos-installer-native.png');
  const pixel=await command(['swift','-e',`import AppKit
    let bitmap = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))!
    let color = bitmap.colorAt(x: 150, y: 480)!.usingColorSpace(.deviceRGB)!
    print(Int((color.redComponent * 255).rounded()), Int((color.greenComponent * 255).rounded()), Int((color.blueComponent * 255).rounded()))
  `,screenshot],root,{timeoutMs:60_000});
  const [red,green,blue]=pixel.split(/\s+/).map(Number);
  assert.ok(red>=240&&red<=250&&Math.abs(red-green)<=1&&blue>red,`Final DMG background was not rendered: ${pixel}`);
  evidence.checks.finderLayoutAndBackground={positions:layout,backgroundPixel:[red,green,blue],screenshot:'macos-installer-native.png'};
  evidence.checks.mountedSize=await macAppSize(app);
  assert.ok(evidence.checks.mountedSize.allocatedBytes<evidence.checks.mountedSize.logicalBytes*0.8,'Installed payload must actually use transparent filesystem compression');
  await mkdir(destination);
  const applePath=value=>'\"'+value.replaceAll('\\','\\\\').replaceAll('\"','\\\"')+'\"';
  // Exercise Finder's real copy path, as used by drag-to-install. A ditto
  // invocation forcing compression preservation would not prove user behavior.
  await command(['osascript','-e',`tell application \"Finder\" to duplicate (POSIX file ${applePath(app)} as alias) to (POSIX file ${applePath(destination)} as alias)`],root,{timeoutMs:120_000});
  evidence.checks.installedSize=await macAppSize(join(destination,'Codex Remote Web.app'));
  assert.ok(evidence.checks.installedSize.allocatedBytes<evidence.checks.installedSize.logicalBytes*0.8,'Copying out of DMG must preserve the reduced disk allocation');
  await command(['hdiutil','detach',mount],root);mounted=false;
  const contents=join(destination,'Codex Remote Web.app/Contents');
  await command(['codesign','--verify','--deep','--strict',join(destination,'Codex Remote Web.app')],root);
  for(const binary of ['Resources/gateway/codex-remote-web','Helpers/Background.app']) {
   await command(['codesign','--verify','--strict',join(contents,binary)],root);
  }
  evidence.checks.relocatedApplicationAndRuntimeSignatures=true;
  await assert.rejects(access(join(contents,'Frameworks/Electron Framework.framework')),'Native macOS application must not bundle Chromium');
  await assert.rejects(access(join(contents,'Resources/gateway/runtime/node')),'macOS DMG must not bundle a second JS runtime');
  await assert.rejects(access(join(contents,'Resources/gateway/node_modules/node-pty')));
  assert.ok(evidence.checks.installedSize.logicalBytes<122_000_000,'Compact native payload budget');
  assert.ok(evidence.checks.installedSize.allocatedBytes<62_000_000,'Compact native disk budget');
  evidence.checks.desktopRuntime='system AppKit/WebKit';
  process.env.CODEX_WEBUI_DESKTOP_EXECUTABLE=join(contents,'MacOS/Codex Remote Web');
  process.env.CODEX_WEBUI_INSTALLED_DIRECTORY=join(contents,'Resources/gateway');
 } else if(process.platform==='win32') {
  await msi(['/i',installer,`INSTALLFOLDER=${destination}`]);installed=true;
  await access(join(destination,'Codex Remote Web.exe'));
  await access(join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Codex Remote Web/Codex Remote Web.lnk'));
  process.env.CODEX_WEBUI_INSTALLED_DIRECTORY=join(destination,'resources/gateway');
  process.env.CODEX_WEBUI_DESKTOP_EXECUTABLE=join(destination,'Codex Remote Web.exe');
 } else throw new Error('Native installer test requires macOS or Windows');
 await command(['bun','run','test:portable'],root,{stream:true,timeoutMs:240_000});
 if(evidence)evidence.checks.installedGatewayAndPty=true;
 await command(['node',process.platform==='darwin'?'tests/browser/macos-native.e2e.mjs':'tests/browser/desktop-native.e2e.mjs'],root,{stream:true,timeoutMs:300_000});
 if(evidence) {
  for(const file of ['macos-desktop-overview.png','macos-desktop-settings-light.png','macos-desktop-settings-dark.png'])await access(join(root,'.artifacts',file));
  evidence.checks.installedDesktopLaunchUiAndLifecycle=true;
  evidence.status='passed';
 }
 if(installed) {
  await msi(['/x',installer]);installed=false;
  const uninstallLog=await readFile(join(temp,'uninstall.log'),'utf8');
  await assert.rejects(access(join(destination,'Codex Remote Web.exe')),`Installed executable remained after uninstall: ${uninstallLog}`);
  await assert.rejects(access(join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Codex Remote Web/Codex Remote Web.lnk')),'Start menu shortcut remained after uninstall');
 }
 console.log('PASS: exact native installer, installation into a path with spaces, installed gateway/files/submissions/PTY and MSI uninstall');
} finally {
 if(evidence) {
  if(evidence.status!=='passed')evidence.status='failed';
  await mkdir(join(root,'.artifacts'),{recursive:true});
  await writeFile(join(root,'.artifacts/macos-installation-check.json'),JSON.stringify(evidence,null,2)+'\n');
 }
 if(mounted)await command(['hdiutil','detach',mount],root);
 if(installed)await msi(['/x',installer]);
 await rm(temp,{recursive:true,force:true});
}
