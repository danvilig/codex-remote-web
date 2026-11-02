import { test, expect } from 'bun:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  stat
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  libraryFiles,
  libraryPreview
} from '../../src/server/files/library.js';
import {
  installSkill,
  removeSkill,
  removableSkill
} from '../../src/server/services/skill-files.js';
import { workspaceMutation } from '../../src/server/http/workspace-mutation.js';
import { createCustomizationService } from '../../src/server/services/customization.js';
async function fixture(fn: any) {
  const base = await mkdtemp(join(tmpdir(), 'crw-resources-')),
    home = join(base, 'home'),
    project = join(base, 'project'),
    privateRoot = join(home, '.codex');
  await mkdir(home);
  await mkdir(project);
  await mkdir(privateRoot);
  const options = {
    home,
    privateRoot,
    browseRoots: [home, project],
    fileRoots: [project]
  };
  try {
    await fn({ ...options, options, base, project });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
test('Library browses and previews project files, paginates images and denies private files and symlink escapes', () =>
  fixture(async (e) => {
    await mkdir(join(e.project, 'docs'));
    await writeFile(join(e.project, 'docs/readme.md'), '# safe');
    await writeFile(join(e.project, '.env'), 'secret');
    await writeFile(join(e.project, 'auth.json'), 'secret');
    await writeFile(join(e.project, 'binary.txt'), Buffer.from([0, 1]));
    await symlink(e.home, join(e.project, 'escape'));
    await Promise.all(
      Array.from({ length: 105 }, (_, i) =>
        writeFile(join(e.project, `image-${i}.png`), 'png')
      )
    );
    const listing = await libraryFiles({ cwd: e.project }, e.options);
    expect(listing.items[0].kind).toBe('folder');
    expect(
      listing.items.some((f: any) =>
        ['.env', 'auth.json', 'escape'].includes(f.name)
      )
    ).toBe(false);
    const first = await libraryFiles(
        { cwd: e.project, images: true },
        e.options
      ),
      second = await libraryFiles(
        { cwd: e.project, images: true, cursor: first.nextCursor },
        e.options
      );
    expect(first.items).toHaveLength(100);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBe(null);
    expect(
      (await libraryFiles({ cwd: e.project, query: 'readme' }, e.options))
        .items[0].path
    ).toBe('docs/readme.md');
    expect(
      (await libraryPreview(join(e.project, 'docs/readme.md'), e.options)).text
    ).toBe('# safe');
    await expect(
      libraryFiles({ cwd: e.project, path: '..' }, e.options)
    ).rejects.toThrow();
    await expect(
      libraryFiles({ cwd: e.project, path: 'escape' }, e.options)
    ).rejects.toThrow();
    await expect(
      libraryFiles({ cwd: e.privateRoot }, e.options)
    ).rejects.toThrow();
    await expect(
      libraryPreview(join(e.project, '.env'), e.options)
    ).rejects.toThrow();
    await expect(
      libraryPreview(join(e.project, 'binary.txt'), e.options)
    ).rejects.toThrow();
  }));
test('Local skill installation preserves scripts, excludes secrets, cannot overwrite, and removal is user-scoped', () =>
  fixture(async (e) => {
    const source = join(e.project, 'source');
    await mkdir(source);
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: local-demo\ndescription: Test\n---\nDo the task.'
    );
    await writeFile(join(source, 'run.sh'), 'exit 0', { mode: 0o755 });
    await writeFile(join(source, '.env'), 'secret');
    const installed = await installSkill(source, e.options);
    expect(
      (await readFile(installed.path, 'utf8')).includes('Do the task')
    ).toBe(true);
    expect(
      (await stat(join(e.privateRoot, 'skills/local-demo/run.sh'))).mode & 0o111
    ).toBe(0o100);
    await expect(
      readFile(join(e.privateRoot, 'skills/local-demo/.env'))
    ).rejects.toThrow();
    await expect(installSkill(source, e.options)).rejects.toThrow();
    expect(
      await removableSkill(installed.path, { ...e.options, cwd: e.project })
    ).toBe(true);
    expect(
      await removableSkill(join(source, 'SKILL.md'), {
        ...e.options,
        cwd: e.project
      })
    ).toBe(false);
    await removeSkill(installed.path, { ...e.options, cwd: e.project });
    await expect(readFile(installed.path)).rejects.toThrow();
    await symlink(join(e.project, 'source/SKILL.md'), join(source, 'linked'));
    await expect(installSkill(source, e.options)).rejects.toThrow();
  }));
test('Concurrent skill installs reserve a name once and reject oversized files before publishing', () =>
  fixture(async (e) => {
    const source = join(e.project, 'source');
    await mkdir(source);
    await writeFile(join(source, 'SKILL.md'), '---\nname: parallel\n---\nTest');
    const outcomes = await Promise.allSettled([
      installSkill(source, e.options),
      installSkill(source, e.options)
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: too-large\n---\nTest'
    );
    await writeFile(join(source, 'large'), Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(installSkill(source, e.options)).rejects.toThrow();
    await expect(
      stat(join(e.privateRoot, 'skills/too-large'))
    ).rejects.toThrow();
  }));
test('Workspace mutations require explicit same-origin JSON requests in local and Access modes', () => {
  const headers = {
    origin: 'http://127.0.0.1:8888',
    host: '127.0.0.1:8888',
    'content-type': 'application/json',
    'x-workspace-request': '1'
  };
  expect(workspaceMutation({ headers }, { mode: 'local' })).toBe(true);
  for (const overrides of [
    { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'x-workspace-request': undefined },
    { 'content-type': 'text/plain' },
    { origin: undefined }
  ])
    expect(
      workspaceMutation(
        { headers: { ...headers, ...overrides } },
        { mode: 'local' }
      )
    ).toBe(false);
  expect(
    workspaceMutation(
      { headers: { ...headers, origin: 'https://workspace.example' } },
      { mode: 'cloudflare-access', publicOrigin: 'https://workspace.example' }
    )
  ).toBe(true);
  expect(
    workspaceMutation(
      { headers },
      { mode: 'cloudflare-access', publicOrigin: 'https://workspace.example' }
    )
  ).toBe(false);
});
test('Customization uses opaque catalog identities, native versioned plugin toggles, and refuses stale/unconfirmed/policy-blocked actions', () =>
  fixture(async (e) => {
    const calls: any[] = [];
    let exists = true,
      installed = true,
      enabled = true,
      blocked = false;
    const plugin = { id: 'docs@test.market', name: 'docs', installed, enabled };
    const request = async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'skills/list') return { data: [] };
      if (method === 'plugin/list')
        return {
          marketplaces: [
            {
              name: 'Test',
              path: '/private/market',
              plugins: exists
                ? [
                    {
                      ...plugin,
                      installed,
                      enabled,
                      installPolicy: blocked ? 'NOT_AVAILABLE' : 'AVAILABLE'
                    }
                  ]
                : []
            }
          ]
        };
      if (method === 'config/read')
        return {
          config: {},
          layers: [{ name: { type: 'user' }, version: 'v1', config: {} }]
        };
      if (method === 'config/batchWrite') enabled = params.edits[0].value;
      if (method === 'plugin/uninstall') installed = false;
      if (method === 'plugin/install') installed = true;
      return {};
    };
    const api = createCustomizationService(request, e.options);
    let catalog = await api.read(e.project);
    expect(JSON.stringify(catalog)).not.toContain('/private');
    const id = catalog.plugins[0].id;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    await expect(
      api.write(e.project, { kind: 'plugin', id, action: 'disable' })
    ).rejects.toThrow();
    await api.write(e.project, {
      kind: 'plugin',
      id,
      action: 'disable',
      confirmed: true
    });
    expect(
      calls.find((c) => c.method === 'config/batchWrite').params
    ).toMatchObject({
      expectedVersion: 'v1',
      edits: [{ keyPath: 'plugins."docs@test.market".enabled', value: false }]
    });
    await api.write(e.project, {
      kind: 'plugin',
      id,
      action: 'uninstall',
      confirmed: true
    });
    blocked = true;
    await expect(
      api.write(e.project, {
        kind: 'plugin',
        id,
        action: 'install',
        confirmed: true
      })
    ).rejects.toThrow();
    blocked = false;
    await api.write(e.project, {
      kind: 'plugin',
      id,
      action: 'install',
      confirmed: true
    });
    expect(
      calls.find((c) => c.method === 'plugin/install').params.marketplacePath
    ).toBe('/private/market');
    exists = false;
    await expect(
      api.write(e.project, {
        kind: 'plugin',
        id,
        action: 'enable',
        confirmed: true
      })
    ).rejects.toThrow();
  }));
