import { readdir, lstat, realpath, readFile } from 'node:fs/promises';
import { resolve, relative, sep, extname } from 'node:path';
import { resolveBrowsePath, isDirectory } from './folders.js';
import { resolveLocalFile } from './download.js';
const inside = (path, root) => path === root || path.startsWith(root + sep);
const privateParts = new Set([
  '.codex',
  '.ssh',
  '.aws',
  '.azure',
  '.kube',
  '.gnupg',
  '.config',
  '.git',
  '.artifacts'
]);
const skipped = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'vendor'
]);
const image = /\.(avif|bmp|gif|jpe?g|png|webp)$/i;
const privateName = (name) =>
  name === '.env' ||
  (name.startsWith('.env.') && name !== '.env.example') ||
  /\.(pem|key|p12|pfx)$/i.test(name) ||
  [
    '.npmrc',
    '.netrc',
    '.pypirc',
    'id_rsa',
    'id_ed25519',
    'id_ecdsa',
    'auth.json',
    'management-token.json'
  ].includes(name);

export async function libraryFiles(
  { cwd, path = '', query = '', images = false, cursor = 0 },
  { browseRoots, fileRoots, privateRoot, home, deniedPaths = [] }
) {
  const project = await realpath(resolveBrowsePath(cwd, browseRoots, home));
  const directory = await realpath(resolve(project, path));
  if (
    !inside(directory, project) ||
    !isDirectory(directory) ||
    directory.split(sep).some((part) => privateParts.has(part)) ||
    (privateRoot &&
      inside(
        directory,
        await realpath(privateRoot).catch(() => resolve(privateRoot))
      ))
  )
    throw new Error('Unavailable directory');
  const needle = String(query).trim().toLocaleLowerCase().slice(0, 200),
    recursive = Boolean(needle || images);
  const queue = [directory],
    items = [];
  let visited = 0,
    partial = false;
  const deadline = Date.now() + 1500;
  while (queue.length && visited < 5000 && Date.now() < deadline) {
    const folder = queue.shift();
    if (
      (await lstat(folder).catch(() => null))?.isSymbolicLink() ||
      !inside(await realpath(folder).catch(() => ''), project)
    )
      continue;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(
      () => []
    )) {
      if (++visited > 5000 || Date.now() >= deadline) {
        partial = true;
        break;
      }
      if (
        entry.isSymbolicLink() ||
        privateParts.has(entry.name) ||
        privateName(entry.name) ||
        (entry.name.startsWith('.') && entry.name !== '.env.example')
      )
        continue;
      const full = resolve(folder, entry.name),
        path = relative(project, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (skipped.has(entry.name)) continue;
        if (recursive) queue.push(full);
        else items.push({ path, name: entry.name, kind: 'folder' });
      } else if (
        entry.isFile() &&
        (!images || image.test(entry.name)) &&
        (!needle || path.toLocaleLowerCase().includes(needle))
      ) {
        const metadata = await lstat(full).catch(() => null);
        if (!metadata?.isFile()) continue;
        let downloadable = false;
        try {
          resolveLocalFile(full, {
            allowedRoots: fileRoots,
            deniedRoots: [privateRoot],
            deniedPaths
          });
          downloadable = true;
        } catch {}
        items.push({
          path,
          name: entry.name,
          kind: 'file',
          bytes: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
          image: image.test(entry.name),
          downloadable
        });
      }
    }
  }
  if (queue.length) partial = true;
  items.sort(
    (a, b) =>
      Number(b.kind === 'folder') - Number(a.kind === 'folder') ||
      a.path.localeCompare(b.path)
  );
  const offset = Math.max(0, Math.min(Number(cursor) || 0, 5000));
  return {
    cwd: project,
    path: relative(project, directory).split(sep).join('/'),
    parent:
      directory === project
        ? null
        : relative(project, resolve(directory, '..')).split(sep).join('/'),
    items: items.slice(offset, offset + 100),
    nextCursor: offset + 100 < items.length ? offset + 100 : null,
    partial
  };
}

export async function libraryPreview(path, options) {
  const file = resolveLocalFile(path, {
    allowedRoots: options.fileRoots,
    deniedRoots: [options.privateRoot],
    deniedPaths: options.deniedPaths,
    maxBytes: 256 * 1024
  });
  if (
    !/^(\.(md|markdown|txt|json|jsonl|ya?ml|toml|ini|cfg|conf|csv|tsv|js|mjs|cjs|jsx|ts|tsx|py|sh|bash|css|html|xml|sql|rs|go|c|h|cpp|java|rb|diff|patch)|)$/i.test(
      extname(file.path)
    )
  )
    throw new Error('Preview not supported');
  const data = await readFile(file.path);
  if (data.includes(0)) throw new Error('Binary file');
  return { name: file.filename, text: data.toString('utf8') };
}
