import { expect, test } from 'bun:test';
import { portableTarget } from '../../scripts/distribution.ts';
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
