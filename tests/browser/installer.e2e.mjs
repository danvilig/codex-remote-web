import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, access, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { command } from '../../scripts/distribution.ts';
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
  await cp(app,join(destination,'Codex Remote Web.app'),{recursive:true,verbatimSymlinks:true});
  await command(['hdiutil','detach',mount],root);mounted=false;
  const contents=join(destination,'Codex Remote Web.app/Contents');
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
 await command(['bun','tests/browser/desktop-native.e2e.mjs'],root,{stream:true,timeoutMs:240_000});
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
