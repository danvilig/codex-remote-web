import { applicationRoot } from '../src/server/config/paths.js';
import { resolve } from 'node:path';
import { startSetupServer } from '../src/server/setup/http.js';
const root = applicationRoot();
if (import.meta.dir === resolve(root, 'scripts')) {
  const result = await Bun.build({ entrypoints: [resolve(root, 'public/setup.js')], target: 'browser', outdir: resolve(root, 'public'), naming: 'setup.bundle.js' });
  if (!result.success) throw new Error('Setup frontend build failed');
}
const { server } = await startSetupServer().then(result => {
  console.log(`Codex Remote Web — remote access setup\n${result.url}\nOpen this single-use link on this machine. Keep this process running until setup finishes.`);
  return result;
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
