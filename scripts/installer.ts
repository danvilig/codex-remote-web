// Build native installers from the already-tested portable archive. No user
// data, services, credentials, remote resources or host configuration is copied.
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { command, portableTarget, installerGuid } from './distribution.ts';
const root=resolve(import.meta.dir,'..'),target=portableTarget();
if (!['darwin','win32'].includes(process.platform)) throw new Error('Native installers require macOS or Windows');
const pkg=await Bun.file(join(root,'package.json')).json(),name=`${pkg.name}-${pkg.version}`;
const output=join(root,'.artifacts/release'),archive=process.env.CODEX_WEBUI_PORTABLE_ARCHIVE;
if(!archive)throw new Error('Build and verify the portable archive first');
const temp=await mkdtemp(join(output,'.installer-'));
const extension=process.platform==='darwin'?'dmg':'msi',installer=join(output,`${name}-${target.label}-${process.arch}.${extension}`);
if(await Bun.file(installer).exists())throw new Error('Refusing to replace an existing installer');
try {
 await command(['tar','-xf',archive,'-C',temp],root);
 const unpacked=join(temp,name),metadata=await Bun.file(join(unpacked,'release.json')).json();
 if(metadata.platform!==process.platform||metadata.arch!==process.arch||metadata.version!==pkg.version||metadata.dirty)throw new Error('Installer input must be a clean matching native package');
 if(process.platform==='darwin') {
  const image=join(temp,'image'),app=join(image,'Codex Remote Web.app'),contents=join(app,'Contents');
  await mkdir(join(contents,'MacOS'),{recursive:true});await mkdir(join(contents,'Resources'),{recursive:true});
  await cp(unpacked,join(contents,'Resources/gateway'),{recursive:true});
  await writeFile(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.github.danvilig.codex-remote-web</string><key>CFBundleName</key><string>Codex Remote Web</string><key>CFBundleExecutable</key><string>launch</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${pkg.version.split('-')[0]}</string><key>CFBundleVersion</key><string>${pkg.version.split('-')[0].split('.').slice(0,2).concat(pkg.version.split('.').at(-1).replace(/\D/g,'') || '0').join('.')}</string><key>LSMinimumSystemVersion</key><string>15.0</string><key>LSArchitecturePriority</key><array><string>arm64</string></array><key>NSHighResolutionCapable</key><true/></dict></plist>\n`);
  await writeFile(join(contents,'MacOS/launch'),`#!/bin/sh
set -eu
gateway="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources/gateway" && pwd -P)"
/usr/bin/osascript - "$gateway" "${'${CODEX_WEBUI_CWD:-$HOME}'}" <<'APPLESCRIPT'
on run argv
  set gateway to item 1 of argv
  set project to item 2 of argv
  tell application "Terminal"
    activate
    do script ("export CODEX_WEBUI_CWD=" & quoted form of project & "; cd " & quoted form of gateway & " && ./codex-remote-web")
  end tell
end run
APPLESCRIPT
# Wait for the gateway before opening the browser; Terminal retains the log and
# Ctrl+C stops the gateway. Do not install launchd jobs or start a Tunnel.
for attempt in 1 2 3 4 5 6 7 8 9 10; do
 if /usr/bin/curl --silent --fail http://127.0.0.1:8899/api/health >/dev/null; then /usr/bin/open http://127.0.0.1:8899; exit 0; fi
 /bin/sleep 1
done
`,{mode:0o755});
  await symlink('/Applications',join(image,'Applications'));
  await command(['plutil','-lint',join(contents,'Info.plist')],root);
  await command(['hdiutil','create','-volname','Codex Remote Web','-srcfolder',image,'-ov','-format','UDZO',installer],root);
 } else {
  const launcher='Start Codex Remote Web.cmd';
  await writeFile(join(unpacked,launcher),'@echo off\r\nif not defined CODEX_WEBUI_CWD set "CODEX_WEBUI_CWD=%USERPROFILE%"\r\n"%~dp0codex-remote-web.exe"\r\n');
  await writeFile(join(unpacked,'Open WebUI.url'),'[InternetShortcut]\r\nURL=http://127.0.0.1:8899/\r\n');
  const xml=(v:string)=>v.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const id=(v:string)=>'C'+createHash('sha256').update(v).digest('hex').slice(0,24);
  const components:string[]=[],directories:string[]=[];
  async function tree(folder:string,relative='',directory='INSTALLFOLDER'):Promise<string> {
   directories.push(directory);let result='';
   for(const item of (await readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const local=relative?`${relative}/${item.name}`:item.name;
    if(item.isDirectory()) result+=`<Directory Id="${id('dir:'+local)}" Name="${xml(item.name)}">${await tree(join(folder,item.name),local,id('dir:'+local))}</Directory>`;
    else {const key=id('file:'+local);components.push(key);result+=`<Component Id="${key}" Guid="${installerGuid(local)}"><File Source="${xml(join(folder,item.name))}" Name="${xml(item.name)}" KeyPath="no"/><RegistryValue Root="HKCU" Key="Software\\Codex Remote Web\\Installer" Name="${key}" Type="integer" Value="1" KeyPath="yes"/></Component>`;}
   }
   return result;
  }
  const content=await tree(unpacked);
  const wxs=join(temp,'installer.wxs');
  await writeFile(wxs,`<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Package Name="Codex Remote Web ${xml(pkg.version)}" Manufacturer="Codex Remote Web" Version="${pkg.version.split('-')[0]}" UpgradeCode="8F8555D4-C0E0-4B2F-9457-3C824076EB40" Scope="perUser"><MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer version is installed."/><MediaTemplate EmbedCab="yes"/><StandardDirectory Id="LocalAppDataFolder"><Directory Id="Programs" Name="Programs"><Directory Id="INSTALLFOLDER" Name="Codex Remote Web">${content}</Directory></Directory></StandardDirectory><StandardDirectory Id="ProgramMenuFolder"><Directory Id="MenuFolder" Name="Codex Remote Web"><Component Id="Menu" Guid="*"><Shortcut Id="Launch" Name="Codex Remote Web" Target="[SystemFolder]cmd.exe" Arguments="/K &quot;&quot;[INSTALLFOLDER]${launcher}&quot;&quot;" WorkingDirectory="INSTALLFOLDER"/><Shortcut Id="OpenWeb" Name="Open WebUI" Target="[INSTALLFOLDER]Open WebUI.url" WorkingDirectory="INSTALLFOLDER"/><RemoveFolder Id="RemoveMenu" On="uninstall"/><RegistryValue Root="HKCU" Key="Software\\Codex Remote Web\\Installer" Name="Menu" Value="1" Type="integer" KeyPath="yes"/></Component></Directory></StandardDirectory><DirectoryRef Id="INSTALLFOLDER"><Component Id="Directories" Guid="*">${directories.map((dir,i)=>`<RemoveFolder Id="RemoveDir${i}" Directory="${dir}" On="uninstall"/>`).join('')}<RegistryValue Root="HKCU" Key="Software\\Codex Remote Web\\Installer" Name="Directories" Value="1" Type="integer" KeyPath="yes"/></Component></DirectoryRef><Feature Id="Gateway" Title="Codex Remote Web" Level="1">${[...components,'Menu','Directories'].map(key=>`<ComponentRef Id="${key}"/>`).join('')}</Feature></Package></Wix>`);
  await command(['wix','build',wxs,'-arch','x64','-out',installer],root);
 }
 const digest=createHash('sha256').update(await readFile(installer)).digest('hex');
 await writeFile(installer+'.sha256',`${digest}  ${basename(installer)}\n`);
 console.log(JSON.stringify({installer,sha256:digest}));
} finally {await rm(temp,{recursive:true,force:true});}
