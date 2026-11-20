// Build native installers from the already-tested portable archive. No user
// data, services, credentials, remote resources or host configuration is copied.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { command, portableTarget, installerGuid } from './distribution.ts';
import { desktopPackage } from './desktop-package.ts';
import { createMacDmg } from './macos-dmg.ts';
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
 let unpacked=join(temp,name);const metadata=await Bun.file(join(unpacked,'release.json')).json();
 if(metadata.platform!==process.platform||metadata.arch!==process.arch||metadata.version!==pkg.version||metadata.dirty)throw new Error('Installer input must be a clean matching native package');
 const desktopOutput=join(temp,'desktop-output'); await mkdir(desktopOutput);
 const desktop=await desktopPackage(unpacked,desktopOutput);
 if(process.platform==='darwin') {
  await createMacDmg(join(desktop,'Codex Remote Web.app'),installer,temp,root);
 } else {
  unpacked=desktop;
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
  await writeFile(wxs,`<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Package Name="Codex Remote Web ${xml(pkg.version)}" Manufacturer="Codex Remote Web" Version="${pkg.version.split('-')[0]}" UpgradeCode="8F8555D4-C0E0-4B2F-9457-3C824076EB40" Scope="perUser"><MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer version is installed."/><MediaTemplate EmbedCab="yes"/><CustomAction Id="StopDesktop" Directory="INSTALLFOLDER" ExeCommand="&quot;[INSTALLFOLDER]Codex Remote Web.exe&quot; --uninstall-background" Execute="immediate" Return="check"/><InstallExecuteSequence><Custom Action="StopDesktop" Before="InstallValidate" Condition="REMOVE~=&quot;ALL&quot;"/></InstallExecuteSequence><Property Id="INSTALLFOLDER"><RegistrySearch Id="SavedInstallLocation" Root="HKCU" Key="Software\\Codex Remote Web\\Installer" Name="InstallLocation" Type="raw"/></Property><StandardDirectory Id="LocalAppDataFolder"><Directory Id="Programs" Name="Programs"><Directory Id="INSTALLFOLDER" Name="Codex Remote Web">${content}</Directory></Directory></StandardDirectory><StandardDirectory Id="ProgramMenuFolder"><Directory Id="MenuFolder" Name="Codex Remote Web"><Component Id="Menu" Guid="*"><Shortcut Id="Launch" Name="Codex Remote Web" Target="[INSTALLFOLDER]Codex Remote Web.exe" WorkingDirectory="INSTALLFOLDER"/><Shortcut Id="OpenWeb" Name="Open WebUI" Target="[INSTALLFOLDER]Codex Remote Web.exe" Arguments="--open-workspace" WorkingDirectory="INSTALLFOLDER"/><RemoveFolder Id="RemoveMenu" On="uninstall"/><RegistryValue Root="HKCU" Key="Software\\Codex Remote Web\\Installer" Name="Menu" Value="1" Type="integer" KeyPath="yes"/></Component></Directory></StandardDirectory><DirectoryRef Id="INSTALLFOLDER"><Component Id="Directories" Guid="*">${directories.map((dir,i)=>`<RemoveFolder Id="RemoveDir${i}" Directory="${dir}" On="uninstall"/>`).join('')}<RegistryValue Root="HKCU" Key="Software\\Codex Remote Web\\Installer" Name="InstallLocation" Value="[INSTALLFOLDER]" Type="string" KeyPath="yes"/></Component></DirectoryRef><Feature Id="Gateway" Title="Codex Remote Web" Level="1">${[...components,'Menu','Directories'].map(key=>`<ComponentRef Id="${key}"/>`).join('')}</Feature></Package></Wix>`);
  await command(['wix','build',wxs,'-arch','x64','-out',installer],root,{stream:true,timeoutMs:240_000});
 }
 const digest=createHash('sha256').update(await readFile(installer)).digest('hex');
 await writeFile(installer+'.sha256',`${digest}  ${basename(installer)}\n`);
 console.log(JSON.stringify({installer,sha256:digest}));
} finally {await rm(temp,{recursive:true,force:true});}
