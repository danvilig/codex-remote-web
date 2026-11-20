import { test, expect } from 'bun:test';
import { mkdtemp, rm, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { macOperation } from '../../desktop/macos/operations.js';
import { writePrivate } from '../../src/server/desktop/private-store.js';

test('native helper rejects renderer-defined commands and foreign installations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-helper-'));
  const directory = join(home, 'desktop');
  try {
    await expect(macOperation('relative', 'status', null, { directory })).rejects.toThrow('Invalid desktop installation');
    await expect(macOperation('/Applications/Test.app/Contents/MacOS/Test', 'exec', { command: 'anything' }, { directory })).rejects.toThrow('Unsupported');
    await writePrivate(join(directory, 'agent.json'), { version: 1, port: 1234, token: 'a'.repeat(43), installation: '/Applications/Other.app/Contents/MacOS/Other' });
    for (const action of ['status', 'language', 'config', 'cleanUninstall']) {
      await expect(macOperation('/Applications/Test.app/Contents/MacOS/Test', action, { language: 'zh' }, { directory })).rejects.toThrow('another installation');
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('native UI preparation preserves private directory and rejects redirected roots', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-private-'));
  try {
    const directory = join(home, 'desktop');
    await macOperation('/Applications/Test.app/Contents/MacOS/Test', 'prepare', null, { directory });
    expect((await lstat(directory)).mode & 0o077).toBe(0);
    await symlink(directory, join(home, 'redirected'));
    await expect(macOperation('/Applications/Test.app/Contents/MacOS/Test', 'prepare', null, { directory: join(home, 'redirected') })).rejects.toThrow();
  } finally { await rm(home, { recursive: true, force: true }); }
});


test('native bridge restores omitted-body semantics for optional WebKit arguments', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-body-'));
  const directory = join(home, 'desktop'), installation = '/Applications/Test.app/Contents/MacOS/Test';
  let received: any;
  const server = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    received = JSON.parse(input);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ checked: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await writePrivate(join(directory, 'agent.json'), { version: 1, port: (server.address() as any).port, token: 'a'.repeat(43), installation });
    expect(await macOperation(installation, 'dependencies', null, { directory })).toEqual({ checked: true });
    expect(received).toEqual({ action: 'dependencies' });
    expect(Object.hasOwn(received, 'body')).toBe(false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});
