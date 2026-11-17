// Native Node worker: IPC closure ties a connector to its owning agent even
// after an abrupt agent crash. It never forwards raw connector output.
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
let child, ending = false, timer, tokenFile;
async function finish(code) { clearTimeout(timer); if (tokenFile) await rm(tokenFile, { force: true }).catch(() => {}); process.exit(code); }
const send = message => { if (process.connected) process.send(message, () => {}); };
function stop() {
  if (ending) return; ending = true;
  if (!child) return process.exit(0);
  child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 2000);
}
process.on('disconnect', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('message', message => {
  if (message?.type === 'stop') return stop();
  if (child || ending || !message?.binary || !Array.isArray(message.args)) return;
  tokenFile = message.tokenFile;
  child = spawn(message.binary, message.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  const consume = chunk => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n'); if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      const id = line.match(/Generated Connector ID:\s*([a-f0-9-]{36})/i)?.[1]; if (id) send({ type: 'connector-id', id });
      if (line.includes('Registered tunnel connection')) send({ type: 'ready' });
    }
    if (buffer.length > 65536) stop();
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', consume); child.stderr.on('data', consume);
  child.once('error', () => void finish(1)); child.once('exit', code => void finish(ending ? 0 : code || 1));
  if (!process.connected) stop();
});
