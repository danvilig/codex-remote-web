// Uses only a disposable workspace and simulated App Server. No cloud or model calls.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { root } from '../helpers/browser-runtime.mjs';
const fixture = await mkdtemp(join(tmpdir(), 'crw-docker-'));
const project = join(fixture, 'project'), name = `crw-release-smoke-${randomUUID()}`;
const token = randomUUID(), image = process.env.CODEX_WEBUI_DOCKER_IMAGE || 'codex-remote-web:verify';
async function docker(args) {
  const command = process.env.CODEX_WEBUI_DOCKER_SUDO === '1' ? ['sudo', '-n', 'docker'] : ['docker'];
  const child = Bun.spawn([...command, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`Docker ${args[0]} failed: ${error.slice(-2000)}`);
  return out.trim();
}
let started = false, ws;
try {
  await mkdir(project); await writeFile(join(project, 'visible.txt'), 'DOCKER_PROJECT_FILE');
  await symlink('/tmp/outside-project', join(project, 'escape'));
  assert.equal(Bun.spawnSync(['git', 'init', '-q', project]).exitCode, 0);
  await docker(['run', '-d', '--rm', '--name', name, '--user', `${process.getuid()}:${process.getgid()}`,
    '-p', '127.0.0.1::8899',
    '--mount', `type=bind,source=${project},target=/workspace`,
    '--mount', `type=bind,source=${join(root, 'tests/fixtures/codex')},target=/usr/local/bin/codex,readonly`,
    '-e', 'HOME=/tmp/crw-home', '-e', 'CODEX_HOME=/tmp/crw-home/.codex',
    '-e', 'CODEX_WEBUI_AUTH_MODE=local', '-e', `CODEX_WEBUI_ACCESS_TOKEN=${token}`,
    '-e', 'CODEX_WEBUI_CWD=/workspace', '-e', 'CODEX_WEBUI_REVIEW_ROOT=/workspace',
    '-e', 'CODEX_WEBUI_ENABLE_TERMINAL=true', '-e', 'SHELL=/bin/bash',
    image, '/bin/sh', '-c', 'mkdir -p /tmp/crw-home/.codex /tmp/outside-project && exec bun run dist/server.js']);
  started = true;
  const mapping = await docker(['port', name, '8899/tcp']);
  const base = `http://${mapping}`, headers = { authorization: `Bearer ${token}`, origin: base };
  for (let i = 0;; i++) {
    try { if ((await (await fetch(base + '/api/health', { headers })).json()).codex) break; } catch {}
    if (i > 120) throw new Error('Docker startup failed: ' + await docker(['logs', '--tail', '30', name]));
    await Bun.sleep(50);
  }
  assert.equal((await fetch(base + '/api/customize')).status, 401);
  for (const path of ['/', '/app.bundle.js', '/workspace.css', '/vendor/katex/katex.min.css', '/api/customize', '/api/workspace/context', '/api/settings/worktrees']) {
    assert.equal((await fetch(base + path, { headers })).status, 200, path);
  }
  const files = await (await fetch(base + '/api/files/search?query=visible', { headers })).json();
  assert.ok(JSON.stringify(files).includes('visible.txt'));
  assert.equal(await (await fetch(base + '/api/files/download?path=/workspace/visible.txt', { headers })).text(), 'DOCKER_PROJECT_FILE');
  assert.equal((await (await fetch(base + '/api/folders?path=/workspace', { headers })).json()).parent, null);
  for (const cwd of ['/', '/tmp/outside-project', '/workspace/escape']) {
    assert.equal((await fetch(base + '/api/workspace/context?cwd=' + encodeURIComponent(cwd), { headers })).status, 400, cwd);
  }
  ws = new WebSocket(base.replace('http:', 'ws:') + '/terminal?cwd=/workspace', { headers });
  let output = ''; ws.on('message', data => output += String(data));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(Buffer.from("printf 'DOCKER_PTY_OK\\n'\npwd\n"));
  for (let i = 0; !/(?:\r|\n)DOCKER_PTY_OK\r?\n/.test(output) || !/(?:\r|\n)\/workspace\r?\n/.test(output); i++) {
    if (i > 150) throw new Error('Container PTY did not run in /workspace'); await Bun.sleep(30);
  }
  console.log('PASS: Docker /workspace outside HOME, isolated App Server, authenticated APIs/static resources, restricted paths and real PTY');
} finally {
  ws?.terminate();
  if (started) await docker(['rm', '-f', name]);
  await rm(fixture, { recursive: true, force: true });
}
