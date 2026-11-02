import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, utimes, access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDeveloperTools } from '../../src/server/services/developer-tools.js';
import { createAttachmentService } from '../../src/server/services/attachments.js';
import { acquirePrivateLock } from '../../src/server/services/private-lock.js';
import { Readable } from 'node:stream';

const git = async (cwd, ...args) => { const child = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' }); const out = await new Response(child.stdout).text(), error = await new Response(child.stderr).text(); if (await child.exited) throw new Error(error); return out.trim(); };
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'crw-developer-')), project = join(root, 'project'), privateRoot = join(root, 'private');
  await mkdir(project); await mkdir(privateRoot, { mode: 0o700 });
  await git(project, 'init', '-q'); await git(project, 'config', 'user.email', 'fixture@example.invalid'); await git(project, 'config', 'user.name', 'Fixture');
  await writeFile(join(project, 'example.txt'), 'base\n'); await git(project, 'add', '.'); await git(project, 'commit', '-qm', 'initial');
  let busy = false, protectedIds = [];
  const options = { privateRoot, browseRoots: [project], home: root, request: async () => ({ data: [] }), isWorktreeBusy: async () => busy, protectedAttachmentIds: async () => protectedIds };
  const service = createDeveloperTools(options), action = (name, input = {}) => service.action({ action: name, cwd: project, ...input });
  try { await fn({ root, project, privateRoot, options, service, action, busy: value => busy = value, protect: value => protectedIds = value }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('project AGENTS preview creates exclusively, detects revisions and consumes confirmations', async () => fixture(async ({ project, action }) => {
  expect(await action('agents.read')).toMatchObject({ exists: false, revision: 'missing', text: '' });
  const preview = await action('agents.preview', { revision: 'missing', text: '# Project\nUse tests.\n' });
  expect(preview.creating).toBe(true); expect(preview.before).toBe('');
  const saved = await action('agents.save', preview); expect(saved.text).toContain('Use tests.');
  await expect(action('agents.save', preview)).rejects.toMatchObject({ status: 409 });
  const next = await action('agents.preview', { revision: saved.revision, text: 'changed' });
  await writeFile(join(project, 'AGENTS.md'), 'externally changed');
  await expect(action('agents.save', next)).rejects.toMatchObject({ code: 'TOOLS_FILE_CONFLICT', status: 409 });
  expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toBe('externally changed');
  await expect(action('agents.preview', { revision: saved.revision, text: 'no' })).rejects.toMatchObject({ status: 409 });
}));

test('AGENTS rejects project escape, symlinks and binary text', async () => fixture(async ({ root, project, action }) => {
  await expect(action('agents.read', { cwd: root })).rejects.toThrow();
  await writeFile(join(root, 'outside'), 'protected'); await symlink(join(root, 'outside'), join(project, 'AGENTS.md'));
  await expect(action('agents.read')).rejects.toThrow();
  await rm(join(project, 'AGENTS.md'));
  await expect(action('agents.preview', { revision: 'missing', text: 'zero\0byte' })).rejects.toThrow();
}));

test('managed worktrees are isolated, exclude local files, require clean and unoccupied state, preserve branches', async () => fixture(async ({ project, action, busy }) => {
  const created = await action('worktrees.create'), item = created.item;
  expect(item.path).toBe(join(project, '.codex-remote-web', 'worktrees', item.id)); expect(item.branch.startsWith('codex/')).toBe(true);
  expect(await git(project, 'status', '--porcelain')).toBe('');
  expect((await action('worktrees.list')).worktrees.find(tree => tree.id === item.id).managed).toBe(true);
  await expect(action('worktrees.preview-remove', { id: randomUUID() })).rejects.toMatchObject({ status: 403 });
  await writeFile(join(item.path, 'untracked.txt'), 'work');
  await expect(action('worktrees.preview-remove', { id: item.id })).rejects.toMatchObject({ code: 'TOOLS_WORKTREE_DIRTY' });
  await rm(join(item.path, 'untracked.txt')); busy(true);
  await expect(action('worktrees.preview-remove', { id: item.id })).rejects.toMatchObject({ code: 'TOOLS_WORKTREE_BUSY' });
  busy(false); const preview = await action('worktrees.preview-remove', { id: item.id });
  await writeFile(join(item.path, 'ignored.local'), 'private ignored content');
  const exclude = await git(project, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
  await writeFile(exclude, '\nignored.local\n', { flag: 'a' });
  await expect(action('worktrees.remove', preview)).rejects.toMatchObject({ code: 'TOOLS_WORKTREE_DIRTY' });
  await rm(join(item.path, 'ignored.local'));
  const lockedPreview = await action('worktrees.preview-remove', { id: item.id });
  await git(project, 'worktree', 'lock', item.path);
  await expect(action('worktrees.remove', lockedPreview)).rejects.toMatchObject({ code: 'TOOLS_WORKTREE_CHANGED' });
  await git(project, 'worktree', 'unlock', item.path);
  const valid = await action('worktrees.preview-remove', { id: item.id }); await action('worktrees.remove', valid);
  await expect(access(item.path)).rejects.toThrow(); expect(await git(project, 'rev-parse', '--verify', item.branch)).toBe(await git(project, 'rev-parse', 'HEAD'));
}));

async function attachment(privateRoot, { bound = false, recent = false } = {}) {
  const id = randomUUID(), path = join(privateRoot, 'remote-web-attachments', id); await mkdir(path, { recursive: true, mode: 0o700 });
  const when = new Date(Date.now() - (recent ? 1000 : 2 * 86400000));
  await writeFile(join(path, 'metadata.json'), JSON.stringify({ id, format: 1, name: 'old.txt', createdAt: when.toISOString() }), { mode: 0o600 });
  await writeFile(join(path, 'content.txt'), 'unused', { mode: 0o600 });
  for (const name of ['metadata.json', 'content.txt']) await utimes(join(path, name), when, when);
  if (bound) await writeFile(join(path, 'thread-binding.json'), '{}', { mode: 0o600 });
  return { id, path };
}

test('cleanup deletes only previewed old unbound unqueued app attachments, never native data', async () => fixture(async ({ privateRoot, action, protect }) => {
  const unbound = await attachment(privateRoot), bound = await attachment(privateRoot, { bound: true }), queued = await attachment(privateRoot), recent = await attachment(privateRoot, { recent: true });
  protect([queued.id]); await writeFile(join(privateRoot, 'auth.json'), 'KEEP');
  const preview = await action('cleanup.preview'); expect(preview.items.map(item => item.id)).toEqual([unbound.id]);
  expect((await action('cleanup.execute', preview)).removed).toBe(1);
  await expect(access(unbound.path)).rejects.toThrow();
  for (const item of [bound, queued, recent]) await access(item.path);
  expect(await readFile(join(privateRoot, 'auth.json'), 'utf8')).toBe('KEEP');
}));

test('cleanup revalidates references and contents; missing protection provider fails closed', async () => fixture(async ({ privateRoot, options, action, protect }) => {
  const file = await attachment(privateRoot), preview = await action('cleanup.preview'); protect([file.id]);
  await expect(action('cleanup.execute', preview)).rejects.toMatchObject({ code: 'TOOLS_CLEANUP_CHANGED' });
  protect([]); const changed = await action('cleanup.preview'); await writeFile(join(file.path, 'content.txt'), 'new');
  await expect(action('cleanup.execute', changed)).rejects.toMatchObject({ status: 409 });
  const noProtection = createDeveloperTools({ ...options, protectedAttachmentIds: undefined });
  expect((await noProtection.action({ action: 'cleanup.preview' })).items).toEqual([]);
}));

test('MCP inventory paginates native status without revealing URI tokens/config or allowing mutation', async () => fixture(async ({ options, project }) => {
  const calls = [], service = createDeveloperTools({ ...options, request: async (method, params) => { calls.push([method, params]); return { data: [{ name: 'fixture', authStatus: 'oAuth', runtimeStatus: 'connected', secret: 'TOKEN', tools: { hello: { name: 'hello', description: 'A tool', inputSchema: { secret: 'TOKEN' } } }, resources: [{ name: 'example', uri: 'https://invalid/?token=TOKEN' }], resourceTemplates: [] }], nextCursor: params.cursor ? null : 'next' }; } });
  const result = await service.action({ action: 'mcp.inventory', cwd: project });
  expect(result.servers).toHaveLength(2); expect(result.readOnly).toBe(true); expect(JSON.stringify(result)).not.toContain('TOKEN');
  expect(calls.every(([method]) => method === 'mcpServerStatus/list')).toBe(true);
  await expect(service.action({ action: 'mcp.oauth' })).rejects.toMatchObject({ code: 'TOOLS_INVALID_ACTION' });
}));

test('cleanup and attachment upload/binding share the stable private lock without removing its inode', async () => fixture(async ({ project, privateRoot, options }) => {
  const attachments=createAttachmentService(options);
  const item=await attachments.upload(Readable.from([Buffer.from('keep')]),{cwd:project,name:'keep.txt'});
  const lockPath=join(privateRoot,'remote-web-attachments','upload.lock.sqlite'),before=await stat(lockPath);
  let releaseScan,enteredScan;
  const entered=new Promise(resolve=>enteredScan=resolve),gate=new Promise(resolve=>releaseScan=resolve);
  const tools=createDeveloperTools({...options,protectedAttachmentIds:async()=>{enteredScan();await gate;return [];}});
  const scanning=tools.action({action:'cleanup.preview'});await entered;
  try{
    await expect(attachments.upload(Readable.from([Buffer.from('blocked')]),{cwd:project,name:'blocked.txt'})).rejects.toMatchObject({status:409});
    await expect(attachments.resolveInput({ids:[item.id],cwd:project,threadId:'thread-A',bind:true})).rejects.toMatchObject({status:409});
    expect((await stat(lockPath)).ino).toBe(before.ino);
  }finally{releaseScan();await scanning;}
  await attachments.resolveInput({ids:[item.id],cwd:project,threadId:'thread-A',bind:true});
  const next=await attachments.upload(Readable.from([Buffer.from('next')]),{cwd:project,name:'next.txt'});expect(next.name).toBe('next.txt');
  expect((await stat(lockPath)).ino).toBe(before.ino);
  await expect(access(join(privateRoot,'remote-web-attachments','upload.lock'))).rejects.toThrow();
}));

test('active upload blocks cleanup and stable mutation lock blocks another tools service without deleting locks', async () => fixture(async ({ project, privateRoot, options }) => {
  const attachments=createAttachmentService(options);let releaseUpload,enteredUpload;
  const entered=new Promise(resolve=>enteredUpload=resolve),gate=new Promise(resolve=>releaseUpload=resolve);
  const stream=Readable.from((async function*(){enteredUpload();yield Buffer.from('start');await gate;yield Buffer.from('finish');})());
  const uploading=attachments.upload(stream,{cwd:project,name:'pending.txt'});await entered;
  const tools=createDeveloperTools(options);
  try{await expect(tools.action({action:'cleanup.preview'})).rejects.toMatchObject({status:409});}finally{releaseUpload();await uploading;}
  // Initializing the tools directory does not replace the attachment database.
  await tools.action({action:'cleanup.preview'});
  const preview=await tools.action({action:'agents.preview',cwd:project,revision:'missing',text:'New instructions'});
  const mutationPath=join(privateRoot,'remote-web-developer-tools','mutation.lock');
  const release=await acquirePrivateLock(mutationPath,{timeoutMs:0}),before=await stat(mutationPath+'.sqlite');
  try{await expect(tools.action({action:'agents.save',previewToken:preview.previewToken})).rejects.toMatchObject({status:409});}finally{await release();}
  await tools.action({action:'agents.save',previewToken:preview.previewToken});
  expect((await stat(mutationPath+'.sqlite')).ino).toBe(before.ino);
  await expect(access(mutationPath)).rejects.toThrow();
}));
