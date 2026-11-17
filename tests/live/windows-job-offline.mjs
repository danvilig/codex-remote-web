// Explicit portable PowerShell/C# verification. No Windows kernel API, real
// App Server, credentials, model, startup registration or service is used.
// CODEX_WEBUI_TEST_POWERSHELL=/path/to/pwsh bun tests/live/windows-job-offline.mjs
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { windowsIsolatedSource } from '../../src/server/bridge/windows-isolated.js';

const binary = process.env.CODEX_WEBUI_TEST_POWERSHELL || Bun.which('pwsh') || Bun.which('powershell');
assert(binary, 'Set CODEX_WEBUI_TEST_POWERSHELL to an installed portable PowerShell executable');
const node = Bun.which('node');
assert(node, 'Node is required for the independent argument round-trip fixture');
const directory = await mkdtemp(join(tmpdir(), 'crw-job-offline-'));
try {
  const source = join(directory, 'WindowsJob.cs');
  await writeFile(source, windowsIsolatedSource);
  const child = Bun.spawn([binary, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', resolve(import.meta.dir, '../fixtures/windows-job-offline.ps1'), '-Source', source], {
    env: { ...process.env, CODEX_WEBUI_TEST_NODE: node }, stdout: 'inherit', stderr: 'inherit',
  });
  const timeout = setTimeout(() => child.kill(), 30000);
  try { assert.equal(await child.exited, 0, 'C# offline production-source verification failed'); }
  finally { clearTimeout(timeout); }
} finally { await rm(directory, { recursive: true, force: true }); }
