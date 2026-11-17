import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { sessionDefinition } from '../../desktop/session.js';
import { readPrivate, writePrivate } from '../../src/server/desktop/private-store.js';

(process.platform === 'win32' ? test.skip : test)('Node settings client executes the locked Bun transaction and refuses a stale restore', async () => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-session-helper-')), directory = join(home, 'desktop');
  const A = sessionDefinition({ platform: 'linux', home, executable: '/fixture/A', env: {} });
  const B = sessionDefinition({ platform: 'linux', home, executable: '/fixture/B', env: {} });
  const wants = join(dirname(A.path), 'graphical-session.target.wants'), link = join(wants, 'codex-remote-web-desktop.service');
  try {
    await mkdir(wants, { recursive: true }); await writeFile(A.path, A.content); await symlink('../codex-remote-web-desktop.service', link);
    await writePrivate(join(directory, 'session.json'), A);
    const code = `import {configureSession} from ${JSON.stringify(resolve(import.meta.dir, '../../desktop/session.js'))};
      import {writeFile} from 'node:fs/promises';
      const restore=await configureSession(false,{directory:${JSON.stringify(directory)},executable:'/fixture/A',command:${JSON.stringify([process.execPath, resolve(import.meta.dir, '../../src/server/cli.ts')])}});
      if(restore.snapshot.current!==null)throw Error('startup was not removed');
      await writeFile(${JSON.stringify(B.path)},${JSON.stringify(B.content)});
      await writeFile(${JSON.stringify(join(directory, 'session.json'))},${JSON.stringify(JSON.stringify(B))},{mode:0o600});
      try{await restore();throw Error('stale rollback succeeded')}catch(error){if(error.code!=='SESSION_CHANGED')throw error}
      console.log('PASS');`;
    const child = Bun.spawn([Bun.which('node'), '--input-type=module', '--eval', code], { env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: join(home, 'no-runtime') }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ stdout, stderr, exit }).toEqual({ stdout: 'PASS\n', stderr: '', exit: 0 });
    expect(await readPrivate(join(directory, 'session.json'))).toEqual(B); expect(await Bun.file(B.path).text()).toBe(B.content);
    await expect(readlink(link)).rejects.toMatchObject({ code: 'ENOENT' }); // stale rollback did not re-enable A
  } finally { await rm(home, { recursive: true, force: true }); }
});
