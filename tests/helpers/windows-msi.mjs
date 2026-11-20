import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function runMsi(operation, installer, log, { destination, ownShutdown = false, removeGateway = false } = {}) {
  assert.ok(operation === '/i' || operation === '/x');
  assert.ok(!removeGateway || operation === '/i');
  console.error(`Verifying msiexec ${operation}${removeGateway ? ' REMOVE=Gateway' : ''}`);
  // msiexec expects PROPERTY="value with spaces", not a quoted whole argument.
  const quote = value => `"${value.replaceAll('"', '""')}"`;
  const args = [operation, quote(installer), ...(destination ? [`INSTALLFOLDER=${quote(destination)}`] : []), ...(removeGateway ? ['REMOVE=Gateway'] : []), ...(ownShutdown ? ['MSIRESTARTMANAGERCONTROL=Disable'] : []), '/l*v', quote(log), '/qn', '/norestart'];
  const child = Bun.spawn(['msiexec.exe', ...args], { windowsVerbatimArguments: true, stdout: 'ignore', stderr: 'ignore' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
  let code;
  try { code = await child.exited; } finally { clearTimeout(timer); }
  if (timedOut || ![0, 3010].includes(code)) {
    throw new Error(`msiexec ${operation} ${timedOut ? 'timed out' : `failed (${code})`}: ${await readFile(log, 'utf8').catch(() => '(log unavailable)')}`);
  }
  return code;
}

if (import.meta.main) {
  const [installer, log, mode, destination] = process.argv.slice(2);
  assert.ok(installer && log);
  assert.ok(['product', 'feature', 'reinstall'].includes(mode));
  if (mode === 'reinstall') assert.ok(destination);
  const code = await runMsi(mode === 'product' ? '/x' : '/i', installer, log, { destination, ownShutdown: mode !== 'reinstall', removeGateway: mode === 'feature' });
  assert.equal(code, 0, `MSI ${mode} must complete without a reboot: exit ${code}`);
}
