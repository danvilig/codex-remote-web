import { accessSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { resolveBrowsePath, isDirectory } from './folders.js';
import { resolveLocalFile } from './download.js';

export const DOCUMENT_MAX_BYTES = 256 * 1024;
const textExtensions = /^(\.(md|markdown|mdown|txt|json|jsonl|ya?ml|toml|ini|cfg|conf|csv|tsv|js|mjs|cjs|jsx|ts|tsx|py|sh|bash|zsh|css|scss|html|xml|svg|sql|rs|go|c|h|cpp|hpp|java|rb|php|vue|svelte|diff|patch)|)$/i;
const revision = data => createHash('sha256').update(data).digest('hex');
const fail = (code, status = 400) => Object.assign(new Error(code), {code,status});

function locate(cwd, path, options) {
  if (typeof cwd !== 'string' || typeof path !== 'string' || !path || path.length > 8192 || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')) throw fail('FILE_UNAVAILABLE');
  const project = realpathSync(resolveBrowsePath(cwd, options.browseRoots, options.home));
  if (!isDirectory(project)) throw fail('FILE_UNAVAILABLE');
  const candidate = resolve(project, path);
  if (['auth.json','management-token.json'].includes(basename(candidate).toLowerCase())) throw fail('FILE_UNAVAILABLE');
  const local = relative(project, candidate);
  if (!local || local.startsWith('..' + sep) || isAbsolute(local)) throw fail('FILE_UNAVAILABLE');
  let current = project;
  for (const part of local.split(sep)) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw fail('FILE_UNAVAILABLE'); }
  const file = resolveLocalFile(pathToFileURL(candidate).href, { allowedRoots:[project], deniedRoots:[options.privateRoot], deniedPaths:options.deniedPaths, maxBytes:DOCUMENT_MAX_BYTES });
  if (!textExtensions.test(extname(file.path))) throw fail('FILE_UNSUPPORTED');
  return file;
}

function read(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > DOCUMENT_MAX_BYTES) throw fail('FILE_UNSUPPORTED');
    const buffer = Buffer.alloc(DOCUMENT_MAX_BYTES+1);let length=0;
    while(length<buffer.length){const bytes=readSync(fd,buffer,length,buffer.length-length,length);if(!bytes)break;length+=bytes;}
    const data=buffer.subarray(0,length);
    if (data.length > DOCUMENT_MAX_BYTES || data.includes(0)) throw fail('FILE_UNSUPPORTED');
    let text;
    try { text = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(data); } catch { throw fail('FILE_UNSUPPORTED'); }
    let writable = Boolean(stat.mode & 0o222) && stat.nlink === 1;
    try { accessSync(path, constants.W_OK); accessSync(dirname(path), constants.W_OK); } catch { writable = false; }
    return {text,revision:revision(data),writable,stat};
  } finally { closeSync(fd); }
}

export function readDocument({cwd,path}, options) {
  const file = locate(cwd,path,options), data = read(file.path);
  return {name:file.filename,text:data.text,revision:data.revision,writable:data.writable};
}

// All work between comparison and rename is synchronous and bounded. A same-dir
// replacement avoids partial files; the original remains intact on failure.
export function saveDocument(payload, options) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key=>!['cwd','path','text','revision'].includes(key)) || typeof payload.text !== 'string' || !/^[a-f0-9]{64}$/.test(payload.revision)) throw fail('FILE_INVALID');
  const data = Buffer.from(payload.text,'utf8');
  if (data.length > DOCUMENT_MAX_BYTES || data.includes(0)) throw fail('FILE_TOO_LARGE',413);
  const file = locate(payload.cwd,payload.path,options), before = read(file.path);
  if (!before.writable) throw fail('FILE_READ_ONLY',403);
  if (before.revision !== payload.revision) throw fail('FILE_CONFLICT',409);
  const temp = join(dirname(file.path),`.codex-remote-edit-${randomUUID()}`);
  let fd;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd,data); fchmodSync(fd,before.stat.mode & 0o777); fsyncSync(fd); closeSync(fd); fd = undefined;
    const verified = locate(payload.cwd,payload.path,options), current = read(verified.path);
    if (!current.writable) throw fail('FILE_READ_ONLY',403);
    if (verified.path !== file.path || current.stat.dev !== before.stat.dev || current.stat.ino !== before.stat.ino || current.revision !== before.revision) throw fail('FILE_CONFLICT',409);
    renameSync(temp,file.path);
    return {ok:true,revision:revision(data)};
  } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
}
