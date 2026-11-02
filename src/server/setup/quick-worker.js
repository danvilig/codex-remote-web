// A separate Node supervisor keeps the connector tied to its owner's IPC pipe,
// including abrupt owner exits. Raw cloudflared output never leaves this worker.
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
let child, directory, ending = false, timer;
const send = message => { if (process.connected) process.send(message, () => {}); };
async function finish(code = 0) {
  clearTimeout(timer);
  if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  if (process.connected) process.disconnect();
  process.exit(code);
}
function stop() {
  if (ending) return; ending = true;
  if (!child) { void finish(); return; }
  child.kill('SIGTERM');
  timer = setTimeout(() => child.kill('SIGKILL'), 1500);
}
process.on('disconnect', stop);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
process.on('message', message => {
  if (message?.type === 'stop') { stop(); return; }
  if (message?.type !== 'start' || child || ending) return;
  directory = message.directory;
  let buffer = '', protectedMode = false, url = null, connected = false, announced = false;
  const line = value => {
    if (ending) return;
    let text = value, diagnostic = value;
    try { const event=JSON.parse(value);text=typeof event.message==='string'?event.message:'';diagnostic=text+' '+(typeof event.error==='string'?event.error:''); } catch {}
    const code = /flag provided but not defined|Incorrect Usage/i.test(diagnostic) ? 'arguments'
      : /x509:|certificate verify failed|unable to get local issuer certificate/i.test(diagnostic) ? 'tls'
      : /You can't set the --url|invalid ingress|error parsing YAML|error parsing tunnel config/i.test(diagnostic) ? 'configuration'
      : /failed to request quick Tunnel|no such host|network is unreachable/i.test(diagnostic) ? 'network'
      : /quick tunnel provisioning failed|failed to decode quick.tunnel|failed to unmarshal quick.tunnel/i.test(diagnostic) ? 'provisioning' : null;
    if (code) { send({ type:'error',code });stop();return; }
    if (text.includes('Your quick Tunnel has been created!')) { send({ type: 'error', code: 'protection' }); stop(); return; }
    if (text.includes('Your protected quick Tunnel has been created!')) protectedMode = true;
    if (protectedMode) {
      const found = text.match(/https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com(?:[\s|]|$)/);
      if (found) url = `https://${found[1]}.trycloudflare.com`;
    }
    if (text.includes('Registered tunnel connection')) connected = true;
    if (protectedMode && url && connected && !announced && !ending) { announced = true; send({ type: 'ready', publicOrigin: url }); }
  };
  const output = chunk => {
    buffer += chunk;
    for (;;) { const index = buffer.indexOf('\n'); if (index < 0) break; line(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    if (buffer.length > 65536) { send({ type: 'error', code: 'output' }); stop(); }
  };
  try {
    child = spawn(message.binary, message.args, { cwd: directory, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.once('error', () => { send({ type: 'error', code: 'launch' }); void finish(1); });
    child.once('close', () => { if (!ending) send({ type: 'error', code: 'exited' }); void finish(ending ? 0 : 1); });
    // The parent might have disconnected while init was being dispatched.
    if (!process.connected) stop();
  } catch { send({ type: 'error', code: 'launch' }); void finish(1); }
});
