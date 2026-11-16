import { expect, test } from 'bun:test';
import { portableTarget, installerGuid } from '../../scripts/distribution.ts';
import { codexCommand } from '../../src/server/config/codex-command.js';
import { privateWindowsAcl } from '../../src/server/config/private-access.js';
import { join } from 'node:path';

test('native release targets use explicit OS, archive, executable and runtime names', () => {
  expect(portableTarget('darwin', 'arm64')).toMatchObject({ label: 'macos', extension: 'tar.gz', bun: 'bun-darwin-arm64', node: 'node' });
  expect(() => portableTarget('darwin', 'x64')).toThrow();
  expect(portableTarget('win32', 'x64')).toMatchObject({ label: 'windows', extension: 'zip', executable: 'codex-remote-web.exe', node: 'node.exe', bun: 'bun-windows-x64-baseline' });
  expect(() => portableTarget('win32', 'arm64')).toThrow();
  expect(() => portableTarget('linux', 'ia32')).toThrow();
});
test('Windows npm shim uses the bundled Node entry with argv and no shell', () => {
  const entry = join('/npm', 'node_modules/@openai/codex/bin/codex.js');
  expect(codexCommand({ platform: 'win32', binary: '/npm/codex.cmd', node: '/bundle/node.exe', exists: path => path === entry })).toEqual(['/bundle/node.exe', entry]);
  expect(codexCommand({ platform: 'win32', binary: '/native/codex.exe' })).toEqual(['/native/codex.exe']);
  expect(() => codexCommand({ platform: 'win32', binary: '/npm/codex.cmd', exists: () => false })).toThrow(/Cannot resolve/);
});
test('private NTFS access fails closed for other owners, broad or unknown trustees', () => {
  const user = 'S-1-5-21-11-22-33-1001';
  const acl = { user, owner: user, allow: [user, 'S-1-5-18', 'S-1-5-32-544'] };
  expect(privateWindowsAcl(acl)).toBe(true);
  for (const sid of ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-21-11-22-33-1002']) expect(privateWindowsAcl({ ...acl, allow: [...acl.allow, sid] })).toBe(false);
  expect(privateWindowsAcl({ ...acl, owner: 'S-1-5-32-544' })).toBe(true);
  expect(privateWindowsAcl({ ...acl, owner: 'S-1-5-21-11-22-33-1002' })).toBe(false);
  expect(privateWindowsAcl({ ...acl, allow: [] })).toBe(false);
  expect(privateWindowsAcl(null)).toBe(false);
});

test('package commands forward newly selected immutable archive identities', async () => {
  const { command } = await import('../../scripts/distribution.ts');
  const before=process.env.CRW_DISTRIBUTION_FIXTURE;
  process.env.CRW_DISTRIBUTION_FIXTURE='selected-archive';
  try { expect(await command([process.execPath,'--eval','console.log(process.env.CRW_DISTRIBUTION_FIXTURE)'],process.cwd())).toBe('selected-archive'); }
  finally { if(before===undefined)delete process.env.CRW_DISTRIBUTION_FIXTURE;else process.env.CRW_DISTRIBUTION_FIXTURE=before; }
});
test('a hung package subprocess fails with its captured diagnostic instead of blocking CI', async () => {
  const { command } = await import('../../scripts/distribution.ts');
  await expect(command([process.execPath,'--eval','console.error("PACKAGE_HANG_FIXTURE"); setInterval(()=>{},1000)'],process.cwd(),{timeoutMs:2000})).rejects.toThrow(/timed out.*PACKAGE_HANG_FIXTURE/s);
});
test('native payload selection includes only needed Windows addons and repairs macOS helper mode', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, stat, rm }=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {copyPtyNative}=await import('../../scripts/distribution.ts');
  const root=await mkdtemp(join(tmpdir(),'crw-native-payload-'));
  try {
    const source=join(root,'source'),out=join(root,'out'),prebuilt=join(source,'prebuilds',`win32-${process.arch}`);
    await mkdir(prebuilt,{recursive:true});await mkdir(join(source,'build/Release/conpty'),{recursive:true});
    for (const file of ['conpty.node','conpty_console_list.node'])await writeFile(join(prebuilt,file),'test fixture');
    await writeFile(join(source,'build/Release/conpty/conpty.dll'),'test DLL');
    await writeFile(join(source,'build/Release/private.pdb'),'debug file');
    await copyPtyNative(source,out,'win32');
    expect(await readFile(join(out,'build/Release/conpty.node'),'utf8')).toBe('test fixture');
    await expect(stat(join(out,'build/Release/conpty/conpty.dll'))).rejects.toThrow();
    await expect(stat(join(out,'build/Release/private.pdb'))).rejects.toThrow();
    if(process.platform!=='win32') {
      await mkdir(join(source,'prebuilds',`darwin-${process.arch}`),{recursive:true});
      for(const file of ['pty.node','spawn-helper'])await writeFile(join(source,'prebuilds',`darwin-${process.arch}`,file),'fixture',{mode:0o644});
      await copyPtyNative(source,join(root,'mac'),'darwin');
      expect((await stat(join(root,'mac/build/Release/spawn-helper'))).mode & 0o111).toBe(0o111);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('MSI file component identities are stable and path-specific UUIDv5 values', () => {
  expect(installerGuid('runtime/node.exe')).toBe(installerGuid('runtime/node.exe'));
  expect(installerGuid('runtime/node.exe')).not.toBe(installerGuid('codex-remote-web.exe'));
  expect(installerGuid('runtime/node.exe')).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
