import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Replaced only by the portable build. Source and JS-archive execution keep
// their existing paths; compiled modules live in Bun's virtual filesystem.
export const standalone = typeof CODEX_REMOTE_WEB_COMPILED !== 'undefined' && CODEX_REMOTE_WEB_COMPILED;

// Both source and release layouts locate assets relative to this module, never the shell cwd.
export function applicationRoot(start = standalone ? dirname(process.execPath) : dirname(fileURLToPath(import.meta.url))) {
  let current = resolve(start);
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')).name === 'codex-remote-web' && existsSync(join(current, 'public/index.html'))) return current;
    } catch { /* Continue towards the package root. */ }
    const parent = dirname(current);
    if (parent === current) throw new Error('Cannot locate Codex Remote Web application root');
    current = parent;
  }
}
export function nodeRuntime(env = process.env) {
  return env.CODEX_WEBUI_NODE || (standalone ? join(applicationRoot(), 'runtime/node') : Bun.which('node', { PATH: env.PATH }));
}
export function gatewayCommand(root = applicationRoot(), executable = process.execPath, compiled = standalone) {
  return compiled ? [executable] : [executable, 'run', join(root, 'dist/server.js')];
}
export function terminalWorkerPath() {
  const root = applicationRoot();
  const source = join(root, 'src/server/terminal/worker.js');
  return existsSync(source) ? source : join(root, 'dist/terminal-worker.js');
}

export function quickWorkerPath() {
  const root = applicationRoot();
  const source = join(root, 'src/server/setup/quick-worker.js');
  return existsSync(source) ? source : join(root, 'dist/quick-worker.js');
}
