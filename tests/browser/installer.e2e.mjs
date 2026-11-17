import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, access, rm, readFile, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { command } from '../../scripts/distribution.ts';
import { dmgLayout } from '../../scripts/macos-dmg.ts';
const root=resolve(import.meta.dir,'../..'),installer=process.env.CODEX_WEBUI_INSTALLER;
assert.ok(installer,'Test the actual installer, not a replacement build');
const temp=await mkdtemp(join(tmpdir(),'crw-installer-'));
let mounted=false,installed=false;
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
  await mkdir(mount);
  await command(['hdiutil','verify',installer],root);
  await command(['hdiutil','attach','-nobrowse','-readonly','-mountpoint',mount,installer],root);mounted=true;
  const app=join(mount,'Codex Remote Web.app');
  await command(['plutil','-lint',join(app,'Contents/Info.plist')],root);
  await command(['codesign','--verify','--deep','--strict',app],root);
  assert.equal(await readlink(join(mount,'Applications')),'/Applications');
  await access(join(mount,'.DS_Store'));
  await access(join(mount,'.background/installer.png'));
  assert.match(await readFile(join(mount,'Install Guide.html'),'utf8'),/Privacy &amp; Security/);
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
    -- Finder returns a file reference here, not necessarily an alias. Let
    -- Finder resolve its name rather than asking Standard Additions to coerce
    -- that reference across the mounted-image boundary.
    set backgroundName to name of background picture of opts
    return {item 1 of appPosition, item 2 of appPosition, item 1 of targetPosition, item 2 of targetPosition, item 1 of helpPosition, item 2 of helpPosition, icon size of opts, backgroundName}
  end tell`],root); }
  finally { await command(['screencapture','-x',join(root,'.artifacts/macos-installer-native.png')],root); }
  assert.ok(layout.startsWith([...dmgLayout.app,...dmgLayout.applications,...dmgLayout.help,dmgLayout.iconSize].join(', ')),`Final DMG lost Finder positions: ${layout}`);
  assert.ok(layout.endsWith('installer.png'),`Final DMG lost background: ${layout}`);
  await cp(app,join(destination,'Codex Remote Web.app'),{recursive:true,verbatimSymlinks:true});
  await command(['hdiutil','detach',mount],root);mounted=false;
  const contents=join(destination,'Codex Remote Web.app/Contents');
  await command(['codesign','--verify','--deep','--strict',join(destination,'Codex Remote Web.app')],root);
  for(const binary of ['gateway/codex-remote-web','gateway/runtime/node','gateway/node_modules/node-pty/build/Release/pty.node','gateway/node_modules/node-pty/build/Release/spawn-helper']) {
   await command(['codesign','--verify','--strict',join(contents,'Resources',binary)],root);
  }
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
 await command(['node','tests/browser/desktop-native.e2e.mjs'],root,{stream:true,timeoutMs:240_000});
 if(installed) {
  await msi(['/x',installer]);installed=false;
  const uninstallLog=await readFile(join(temp,'uninstall.log'),'utf8');
  await assert.rejects(access(join(destination,'Codex Remote Web.exe')),`Installed executable remained after uninstall: ${uninstallLog}`);
  await assert.rejects(access(join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Codex Remote Web/Codex Remote Web.lnk')),'Start menu shortcut remained after uninstall');
 }
 console.log('PASS: exact native installer, installation into a path with spaces, installed gateway/files/submissions/PTY and MSI uninstall');
} finally {
 if(mounted)await command(['hdiutil','detach',mount],root);
 if(installed)await msi(['/x',installer]);
 await rm(temp,{recursive:true,force:true});
}
