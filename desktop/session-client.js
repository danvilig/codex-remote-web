import { spawn } from 'node:child_process';

// Node/Electron cannot open Bun's SQLite locks. Execute the complete locked
// transaction in the shipped CLI, using JSON pipes rather than shell arguments.
export async function remoteSession(enabled, options) {
  const { command } = options;
  const payload = {};
  for (const key of ['directory', 'executable', 'args', 'definition', 'expectedInstallation', 'expectedRegistration', 'expectedGeneration']) {
    if (Object.hasOwn(options, key)) payload[key] = options[key];
  }
  const snapshot = await new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), 'session-configure'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', overflow = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 524288) { overflow = true; child.kill(); } });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut || overflow) return reject(new Error('Background registration helper did not complete'));
      try {
        const result = JSON.parse(output);
        if (code || result.error) throw Object.assign(new Error(result.error || 'Background registration failed'), { code: result.code });
        resolve(result.snapshot);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ enabled, options: payload }));
  });
  const restore = snapshot.skipped ? async () => {} : () => remoteSession(!!snapshot.previous, { ...options, definition: snapshot.previous || undefined, expectedInstallation: undefined, expectedRegistration: snapshot.current, expectedGeneration: snapshot.generation });
  restore.snapshot = snapshot;
  return restore;
}
