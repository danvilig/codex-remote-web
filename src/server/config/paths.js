import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both source and release layouts locate assets relative to this module, never the shell cwd.
export function applicationRoot(start = dirname(fileURLToPath(import.meta.url))) {
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
