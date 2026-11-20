import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanDesktopState, assertDesktopCleanup } from '../../src/server/desktop/cleanup.js';
import { writePrivate } from '../../src/server/desktop/private-store.js';
import { acquirePrivateLock } from '../../src/server/services/private-lock.js';
import { removeAppData } from '../../desktop/cleanup.js';

async function fixture(fn) {
  const home = await mkdtemp(join(tmpdir(), 'desktop-cleanup-')), directory = join(home, 'desktop');
  await mkdir(directory,{mode:0o700});
  try { await fn({home,directory}); } finally { await rm(home,{recursive:true,force:true}); }
}
test('clean uninstall removes exact app settings and credentials, preserving projects, account and stable locks', async () => fixture(async ({home,directory}) => {
  await mkdir(join(home,'.codex')); await writeFile(join(home,'.codex/auth.json'),'fixture account');
  await writeFile(join(home,'project.txt'),'project'); await writeFile(join(directory,'unknown.txt'),'unrelated');
  await writePrivate(join(directory,'config.json'),{language:'zh'});
  await writePrivate(join(directory,'management-token.json'),{token:'fixture'});
  await writePrivate(join(directory,'setup-state.json'),{phase:'removed'});
  const release = await acquirePrivateLock(join(directory,'agent-lock')); await release();
  const inode = (await stat(join(directory,'agent-lock.sqlite'))).ino;
  await cleanDesktopState(directory);
  expect(await readFile(join(directory,'config.json'),'utf8').catch(error=>error.code)).toBe('ENOENT');
  expect(await readFile(join(directory,'management-token.json'),'utf8').catch(error=>error.code)).toBe('ENOENT');
  expect(await readFile(join(directory,'unknown.txt'),'utf8')).toBe('unrelated');
  expect(await readFile(join(home,'project.txt'),'utf8')).toBe('project');
  expect(await readFile(join(home,'.codex/auth.json'),'utf8')).toBe('fixture account');
  expect((await stat(join(directory,'agent-lock.sqlite'))).ino).toBe(inode);
  await cleanDesktopState(directory);
}));
test('cleanup refuses active/uncertain deployments and registration before deleting anything', async () => fixture(async ({directory}) => {
  await writePrivate(join(directory,'config.json'),{safe:true});
  for (const phase of ['complete','applying','failed','unknown']) {
    await writePrivate(join(directory,'setup-state.json'),{phase});
    await expect(assertDesktopCleanup(directory)).rejects.toThrow('Remove the remote deployment');
  }
  await rm(join(directory,'setup-state.json'));
  for (const name of ['session.json','session-windows-pending.json','protected-gateway.json','agent.json']) {
    await writePrivate(join(directory,name),{owner:'foreign'});
    await expect(cleanDesktopState(directory)).rejects.toThrow(); await rm(join(directory,name));
    expect(JSON.parse(await readFile(join(directory,'config.json'),'utf8'))).toEqual({safe:true});
  }
}));
(process.platform === 'win32' ? test.skip : test)('cleanup rejects linked settings and redirected app data without touching targets', async () => fixture(async ({home,directory}) => {
  await writeFile(join(home,'keep.json'),'{}'); await symlink(join(home,'keep.json'),join(directory,'config.json'));
  await expect(cleanDesktopState(directory)).rejects.toThrow();
  await symlink(directory,join(home,'linked'));
  await expect(removeAppData(join(home,'linked'))).rejects.toThrow('unsafe');
  expect(await readFile(join(home,'keep.json'),'utf8')).toBe('{}');
}));
