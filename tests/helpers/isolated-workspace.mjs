import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { createServer } from 'node:net';
import { root } from './browser-runtime.mjs';

// Offline integration fixture: temporary HOME/project, no credentials, no LLM,
// no Cloudflare changes and no connection to a host App Server.
export async function isolatedWorkspace(extraEnv = {}, { sourceRoot = root, fixtureRoot = root } = {}) {
  const directory = await mkdtemp('/tmp/crw-acceptance-'), home = join(directory, 'home'), project = join(directory, 'project'), log = join(directory, 'native.jsonl');
  await mkdir(home); await mkdir(project); await writeFile(join(project, 'README.md'), '# Fixture project\n');
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-qm', 'fixture']]) {
    const child = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: project, stdout: 'ignore', stderr: 'pipe' });
    if (await child.exited) throw new Error(await new Response(child.stderr).text());
  }
  const port = await new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const base = `http://127.0.0.1:${port}`;
  const server = Bun.spawn(['bun', 'src/server/index.ts'], { cwd: sourceRoot, stdout: 'ignore', stderr: 'pipe', env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), CODEX_AUTH_PATH: join(home, 'missing-auth.json'), HOST: '127.0.0.1', PORT: String(port), CODEX_WEBUI_AUTH_MODE: 'local', CODEX_WEBUI_APP_SERVER_MODE: 'isolated', CODEX_WEBUI_CWD: project, CODEX_WEBUI_REVIEW_ROOT: project, CODEX_WEBUI_ENABLE_TERMINAL: 'false', CODEX_WEBUI_FIXTURE_LOG: log, PATH: join(fixtureRoot, 'tests/fixtures') + delimiter + process.env.PATH, ...extraEnv } });
  const errors = new Response(server.stderr).text();
  try {
    for (let i = 0;; i++) {
      try { if ((await (await fetch(base + '/api/health')).json()).codex) break; } catch {}
      if (i > 160 || server.exitCode !== null) throw new Error('Isolated workspace failed to start');
      await Bun.sleep(50);
    }
  } catch (error) { server.kill('SIGTERM'); await server.exited; await rm(directory, { recursive: true, force: true }); throw new Error(error.message + '\n' + await errors); }
  return { base, project, home, directory, log, async executions() { try { return (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(message => ['turn/start', 'turn/steer'].includes(message.method)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }, async close() { server.kill('SIGTERM'); await server.exited; await errors; await rm(directory, { recursive: true, force: true }); } };
}
