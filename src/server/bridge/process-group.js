import { readdir, readFile } from 'node:fs/promises';

export async function isProcessGroupRunning(group) {
  try { process.kill(-group, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (process.platform !== 'linux') return true;
  // Container init may leave dead orphans as zombies. They cannot run tools
  // and must not indefinitely prevent a confirmed execution shutdown.
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let stat;
    try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (stat.lastIndexOf(')') < 0 || !/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[2])) throw new Error('Cannot inspect Codex process group');
    if (Number(fields[2]) === group && !['Z', 'X'].includes(fields[0])) return true;
  }
  return false;
}

// A successful kill syscall only queues a signal. Keep the lifecycle pending
// until the OS observes completion, including after force-kill escalation.
export async function reapProcessGroup(group, {
  signal = (name) => process.kill(-group, name),
  isRunning = () => isProcessGroupRunning(group),
  wait = () => new Promise(resolve => setTimeout(resolve, 50)),
  now = Date.now, graceMs = 1500, killMs = 1500,
} = {}) {
  const send = name => {
    try { signal(name); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  if (!send('SIGTERM')) return;
  for (const [duration, force] of [[graceMs, false], [killMs, true]]) {
    if (force && !send('SIGKILL')) return;
    const deadline = now() + duration;
    for (;;) {
      if (!await isRunning()) return;
      if (now() >= deadline) break;
      await wait();
    }
  }
  throw new Error('Codex process group did not exit after SIGKILL');
}
