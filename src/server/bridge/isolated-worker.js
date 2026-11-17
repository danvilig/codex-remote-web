// Unix desktop gateways can be killed as a process group. Keep this supervisor
// outside that group and watch the private IPC pipe so owned native tools are
// reaped even after SIGKILL, without ever supervising a shared daemon.
import { spawn } from 'node:child_process';
let child, ending = false;
function stop() {
  if (ending) return;
  ending = true;
  if (!child) return process.exit(0);
  // This worker is the detached group leader. Its native child inherits that
  // group, so the bridge's force-kill fallback also covers every owned tool.
  process.kill(-process.pid, 'SIGTERM');
  setTimeout(() => process.kill(-process.pid, 'SIGKILL'), 1500);
}
process.on('disconnect', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.stdout.on('error', stop); process.stderr.on('error', stop);
process.stdin.on('end', stop);
process.on('message', message => {
  if (child || ending || message?.type !== 'start' || !Array.isArray(message.command) || !message.command.length) return;
  const [binary, ...args] = message.command;
  child = spawn(binary, args, { cwd: message.cwd, env: process.env, detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.stdin.on('error', stop);
  child.stdout.on('error', stop); child.stderr.on('error', stop);
  child.once('error', stop);
  child.once('exit', stop);
  // Always retain the escalation timer: descendants can close stdio and still
  // keep running. Only this worker's owned native process group is signalled.
  if (!process.connected) stop();
});
