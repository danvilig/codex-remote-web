import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, stat, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquirePrivateLock } from '../../src/server/services/private-lock.js';
import { scheduleOwner, scheduleOwnerAlive } from '../../src/server/services/schedule-store.js';

const roots: string[] = [], children: ReturnType<typeof spawn>[] = [];
async function fixture() { const root = await mkdtemp('/tmp/crw-private-lock-'); roots.push(root); return root; }
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 300; attempt++) { if (await predicate()) return; await Bun.sleep(5); }
  throw Error('Lock worker timed out');
}
function worker(root: string, name: string, hold = false) {
  const module = pathToFileURL(join(import.meta.dir, '../../src/server/services/private-lock.js')).href;
  const owner = pathToFileURL(join(import.meta.dir, '../../src/server/services/schedule-store.js')).href;
  const code = `import {acquirePrivateLock} from ${JSON.stringify(module)};
    import {scheduleOwnerAlive} from ${JSON.stringify(owner)};
    import {appendFile,access} from 'node:fs/promises';
    const root=${JSON.stringify(root)},name=${JSON.stringify(name)};
    console.log('ready');
    while(true){try{await access(root+'/go');break}catch{await Bun.sleep(5)}}
    const release=await acquirePrivateLock(root+'/write.lock',{legacyOwnerAlive:scheduleOwnerAlive});
    await appendFile(root+'/events',name+':start\\n');console.log('acquired');
    ${hold ? 'await new Promise(()=>setInterval(()=>{},1000));' : 'await Bun.sleep(60);'}
    await appendFile(root+'/events',name+':end\\n');await release();`;
  const child = spawn(process.execPath, ['--eval', code], {stdio: ['ignore','pipe','pipe']}); children.push(child);
  let output = '', errors = ''; child.stdout!.on('data', chunk => {output += chunk;}); child.stderr!.on('data', chunk => {errors += chunk;});
  const done = new Promise<number | null>((resolve, reject) => child.on('close', code => code === 0 || child.signalCode === 'SIGKILL' ? resolve(code) : reject(new Error(errors))));
  return {child, done, output: () => output};
}

test('two simultaneous stale-marker recovery contenders serialize without unlinking any inode', async () => {
  const root = await fixture(), lock = join(root, 'write.lock');
  const marker = JSON.stringify({token:'stale-owner',owner:{pid:2147483647,host:'dead-machine'}});
  await writeFile(lock, marker, {mode:0o600}); const original = await stat(lock);
  const a = worker(root,'a'), b = worker(root,'b');
  await until(() => a.output().includes('ready') && b.output().includes('ready'));
  await writeFile(join(root,'go'),'go'); await Promise.all([a.done,b.done]);
  const events = (await readFile(join(root,'events'),'utf8')).trim().split('\n');
  expect(events.map(value => value.split(':')[1])).toEqual(['start','end','start','end']);
  expect((await stat(lock)).ino).toBe(original.ino); expect(await readFile(lock,'utf8')).toBe(marker);
  expect((await stat(lock+'.sqlite')).mode & 0o077).toBe(0);
});

test('SIGKILL releases the OS lock for two recovery contenders without deleting the lock database', async () => {
  const root = await fixture(); await writeFile(join(root,'go'),'go');
  const holder = worker(root,'holder',true); await until(() => holder.output().includes('acquired'));
  const inode = (await stat(join(root,'write.lock.sqlite'))).ino;
  const a = worker(root,'a'), b = worker(root,'b');
  await until(() => a.output().includes('ready') && b.output().includes('ready'));
  await Bun.sleep(30); expect(a.output()).not.toContain('acquired'); expect(b.output()).not.toContain('acquired');
  holder.child.kill('SIGKILL'); await holder.done; await Promise.all([a.done,b.done]);
  const events = (await readFile(join(root,'events'),'utf8')).trim().split('\n');
  expect(events[0]).toBe('holder:start'); expect(events.slice(1).map(value => value.split(':')[1])).toEqual(['start','end','start','end']);
  expect((await stat(join(root,'write.lock.sqlite'))).ino).toBe(inode);
});

test('live legacy ownership, busy locks and unsafe SQLite paths fail closed', async () => {
  const root = await fixture(), path = join(root,'write.lock');
  await writeFile(path,JSON.stringify({owner:scheduleOwner()}),{mode:0o600});
  await expect(acquirePrivateLock(path,{legacyOwnerAlive:scheduleOwnerAlive})).rejects.toMatchObject({code:'PRIVATE_LOCK_LEGACY_BUSY'});
  const release = await acquirePrivateLock(join(root,'other.lock'));
  try { await expect(acquirePrivateLock(join(root,'other.lock'),{timeoutMs:20})).rejects.toMatchObject({code:'PRIVATE_LOCK_BUSY'}); }
  finally { await release(); }
  await symlink(join(root,'other.lock.sqlite'),join(root,'unsafe.lock.sqlite'));
  await expect(acquirePrivateLock(join(root,'unsafe.lock'))).rejects.toThrow();
});

test('a same-process contender cannot release the OS lock by opening and closing its safety descriptor', async () => {
  const root = await fixture(), path = join(root,'write.lock');
  await writeFile(join(root,'go'),'go');
  const release = await acquirePrivateLock(path);
  const external = worker(root,'external');
  try {
    await until(() => external.output().includes('ready'));
    await expect(acquirePrivateLock(path,{timeoutMs:30})).rejects.toMatchObject({code:'PRIVATE_LOCK_BUSY'});
    await Bun.sleep(30);
    expect(external.output()).not.toContain('acquired');
  } finally { await release(); }
  await external.done;
  expect(external.output()).toContain('acquired');
});

test('parent directory aliases share the local mutex and hard-linked SQLite lock files are refused', async () => {
  const root = await fixture(), path = join(root,'write.lock');
  await writeFile(join(root,'go'),'go');
  await symlink(root,join(root,'alias'),'dir');
  const release = await acquirePrivateLock(path), external = worker(root,'external');
  try {
    await until(() => external.output().includes('ready'));
    await expect(acquirePrivateLock(join(root,'alias/write.lock'),{timeoutMs:30})).rejects.toMatchObject({code:'PRIVATE_LOCK_BUSY'});
    await Bun.sleep(30); expect(external.output()).not.toContain('acquired');
  } finally { await release(); }
  await external.done;
  await link(path+'.sqlite',join(root,'hardlinked.lock.sqlite'));
  await expect(acquirePrivateLock(join(root,'hardlinked.lock'))).rejects.toMatchObject({code:'PRIVATE_LOCK_UNSAFE'});
});
