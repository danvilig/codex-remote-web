import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nodeRuntime } from './paths.js';

// npm installs codex.cmd on Windows; spawning that shim with shell:true would
// route the command through cmd.exe. Invoke its JS entry using bundled Node
// instead, preserving argv/stdio without shell expansion or a host Node.
export function codexCommand({ platform = process.platform, binary = platform === 'win32' ? Bun.which('codex', { PATH: process.env.PATH }) || 'codex' : 'codex', node = nodeRuntime(), exists = existsSync } = {}) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(binary)) return [binary];
  const base = dirname(binary);
  for (const entry of [join(base, 'node_modules/@openai/codex/bin/codex.js'), join(base, '../@openai/codex/bin/codex.js')]) {
    if (exists(entry) && node) return [node, entry];
  }
  throw new Error('Cannot resolve the npm Codex CLI entry. Install @openai/codex or place codex.exe on PATH.');
}
