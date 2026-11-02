import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const checks = process.argv.includes('--check');
for (const [entry, output, target] of [['public/app.js', checks ? '.artifacts/check/app.js' : 'public/app.bundle.js', 'browser'], ['scripts/setup.ts', checks ? '.artifacts/check/setup.js' : 'dist/setup.js', 'bun'], ['public/setup.js', checks ? '.artifacts/check/setup.bundle.js' : 'public/setup.bundle.js', 'browser'], ['src/server/index.ts', checks ? '.artifacts/check/server.js' : 'dist/server.js', 'bun']]) {
  const result = await Bun.build({ entrypoints: [resolve(root, entry)], naming: output.split('/').at(-1), outdir: resolve(root, output, '..'), target: target as 'browser' | 'bun', packages: target === 'bun' ? 'external' : 'bundle' });
  if (!result.success) throw new Error(result.logs.join('\n'));
}
if (!checks) {
  await mkdir(resolve(root, 'dist'), { recursive: true });
  await cp(resolve(root, 'src/server/terminal/worker.js'), resolve(root, 'dist/terminal-worker.js'));
  await cp(resolve(root, 'src/server/setup/quick-worker.js'), resolve(root, 'dist/quick-worker.js'));
}
