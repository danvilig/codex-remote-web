// No Codex, credentials or external network. Exercise the actual supervisor's
// process/IPC/HTTP lifecycle on every native runner.
import { createServer } from 'node:http';
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/setup/ready' && req.headers['x-setup-probe'] === process.env.CODEX_WEBUI_SETUP_PROBE) res.end(JSON.stringify({ mode: process.env.CODEX_WEBUI_AUTH_MODE, publicOrigin: process.env.CODEX_WEBUI_PUBLIC_ORIGIN, audience: process.env.CODEX_WEBUI_CF_ACCESS_AUD, allowedEmail: process.env.CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL }));
  else res.end(JSON.stringify({ fixture: true, pid: process.pid, appServerMode: process.env.CODEX_WEBUI_APP_SERVER_MODE || null, appServerSocket: process.env.CODEX_WEBUI_APP_SERVER_SOCKET || null }));
});
server.listen(Number(process.env.PORT), '127.0.0.1', () => process.send?.({ type: 'desktop-ready' }));
const stop = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
process.on('disconnect', stop); process.on('SIGTERM', stop);
process.on('message', message => {
  if (message.action === 'shutdown') return stop();
  process.send?.({ type: 'desktop-result', id: message.id, result: { available: true, running: false, phase: 'stopped' } });
});
