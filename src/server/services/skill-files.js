import {
  lstat,
  mkdir,
  readdir,
  writeFile,
  rm,
  rename,
  realpath,
  open
} from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolveBrowsePath } from '../files/folders.js';
const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
export async function removableSkill(path, { privateRoot, home, cwd }) {
  if (typeof path !== 'string' || basename(path) !== 'SKILL.md') return false;
  const directory = dirname(path);
  if (!slug.test(basename(directory))) return false;
  const roots = [
    join(privateRoot, 'skills'),
    join(home, '.agents/skills'),
    join(cwd, '.agents/skills')
  ];
  for (const root of roots) {
    try {
      if (
        (await realpath(dirname(directory))) === (await realpath(root)) &&
        !(await lstat(directory)).isSymbolicLink() &&
        (await lstat(path)).isFile() &&
        !(await lstat(path)).isSymbolicLink()
      )
        return true;
    } catch {}
  }
  return false;
}
export async function removeSkill(path, options) {
  if (!(await removableSkill(path, options)))
    throw new Error('This skill is managed by its plugin or administrator');
  const directory = dirname(path),
    tombstone = join(dirname(directory), `.crw-removed-${randomUUID()}`);
  await rename(directory, tombstone);
  await rm(tombstone, { recursive: true, force: true });
}
export async function installSkill(source, { privateRoot, home, browseRoots }) {
  if (typeof source !== 'string' || source.length > 4096)
    throw new Error('Choose a local skill folder');
  const directory = resolveBrowsePath(source, browseRoots, home);
  const manifest = join(directory, 'SKILL.md');
  if (
    (await lstat(directory)).isSymbolicLink() ||
    !(await lstat(manifest)).isFile() ||
    (await lstat(manifest)).isSymbolicLink() ||
    (await lstat(manifest)).size > 65536
  )
    throw new Error('Invalid skill');
  const markdown = (await safeRead(manifest, 65536)).toString('utf8');
  const frontmatter = markdown.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
  )?.[1];
  const name = frontmatter?.match(/^name:\s*["']?([a-z0-9-]+)["']?\s*$/m)?.[1];
  if (!name || !slug.test(name)) throw new Error('SKILL.md needs a valid name');
  const root = join(privateRoot, 'skills');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink())
    throw new Error('Skill root cannot be a link');
  const destination = join(root, name),
    stage = join(root, `.crw-install-${randomUUID()}`);
  try {
    await lstat(destination);
    throw new Error('A skill with this name already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(stage, { mode: 0o700 });
  let entries = 0,
    bytes = 0,
    reserved = false;
  async function copy(from, to) {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (++entries > 500) throw new Error('Skill contains too many files');
      if (
        entry.name.startsWith('.') ||
        /\.(pem|key|p12|pfx)$/i.test(entry.name) ||
        /^(auth|management-token)\.json$/.test(entry.name)
      )
        continue;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new Error('Skill links and special files are not supported');
      const input = join(from, entry.name),
        output = join(to, entry.name);
      if (entry.isDirectory()) {
        if ((await realpath(input)) !== resolve(input))
          throw new Error('Skill links are not supported');
        await mkdir(output, { mode: 0o700 });
        await copy(input, output);
      } else {
        const metadata = await lstat(input);
        const data = await safeRead(input, 10 * 1024 * 1024 - bytes);
        bytes += data.byteLength;
        await writeFile(output, data, {
          mode: metadata.mode & 0o111 ? 0o700 : 0o600,
          flag: 'wx'
        });
      }
    }
  }
  try {
    await copy(directory, stage);
    // Reserve exclusively across gateways; publish the discovery manifest last.
    await mkdir(destination, { mode: 0o700 });
    reserved = true;
    for (const entry of await readdir(stage))
      if (entry !== 'SKILL.md')
        await rename(join(stage, entry), join(destination, entry));
    await rename(join(stage, 'SKILL.md'), join(destination, 'SKILL.md'));
    reserved = false;
    return { name, path: join(destination, 'SKILL.md') };
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (reserved) await rm(destination, { recursive: true, force: true });
  }
}

async function safeRead(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error('Skill exceeds the size limit');
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        null
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error('Skill exceeds the size limit');
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}
