import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { applicationRoot } from '../config/paths.js';
import { SetupService } from './service.js';
import { QuickTunnel } from './quick.js';
import { SetupError } from './cloudflare.js';
import { readJsonBody } from '../http/body.ts';
const secret = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function localSetupRequest(req, mutation = false) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  let origin;
  try { origin = new URL(`http://${req.headers.host}`); } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password) return false;
  const forwarded = Object.keys(req.headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('cf-'));
  if (forwarded || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return false;
  if (req.headers.origin && req.headers.origin !== origin.origin) return false;
  if (mutation && (req.headers.origin !== origin.origin || req.headers['x-setup-request'] !== '1' || !req.headers['content-type']?.startsWith('application/json'))) return false;
  return true;
}
export function createSetupHandler({ service = new SetupService(), quick = new QuickTunnel(), root = applicationRoot(), readiness, probeToken, now = Date.now } = {}) {
  let bootstrap = null, session = null, requestBusy = false;
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' };
  const json = (res, status, data, extra = {}) => { res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(data)); };
  const issue = () => { bootstrap = { key: secret(), expiresAt: now() + 300000 }; return bootstrap.key; };
  const expire = () => { if (session && session.expiresAt < now() && !service.busy && !requestBusy) { session = null; service.disconnect(); } };
  const timer = setInterval(expire, 30000); timer.unref();
  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
    const assets = { '/setup': ['public/setup.html', 'text/html'], '/setup.bundle.js': ['public/setup.bundle.js', 'text/javascript'], '/setup-assets/style.css': ['public/style.css', 'text/css'], '/setup-assets/workspace.css': ['public/workspace.css', 'text/css'], '/setup-assets/remote-access.css': ['public/remote-access.css', 'text/css'], '/setup-assets/favicon.svg': ['public/favicon.svg', 'image/svg+xml'] };
    if (!url.pathname.startsWith('/api/setup/') && !assets[url.pathname]) return false;
    expire();
    if (!localSetupRequest(req, req.method !== 'GET')) { json(res, 403, { error: 'Open setup on this machine using its loopback address.', code: 'SETUP_LOCAL_ONLY' }); return true; }
    if (assets[url.pathname]) {
      if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed' }); return true; }
      try { const [file, type] = assets[url.pathname]; res.writeHead(200, { ...headers, 'content-type': `${type}; charset=utf-8`, 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); res.end(await readFile(join(root, file))); }
      catch { json(res, 503, { error: 'Setup assets are missing. Run the production build.' }); }
      return true;
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/setup/ready') {
        if (!probeToken || !equal(req.headers['x-setup-probe'], probeToken) || !readiness) throw new SetupError('Setup readiness is not authorized.', 403);
        json(res, 200, readiness()); return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/setup/launch') {
        // Local same-origin activation supplies a single-use credential, never a management token.
        json(res, 200, { key: issue() }); return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/setup/session') {
        const body = await readJsonBody(req, 2048);
        if (!bootstrap || bootstrap.expiresAt <= now() || !equal(body.key, bootstrap.key)) throw new SetupError('The setup link expired or was already used. Open a new setup link.', 403);
        if (service.busy) throw new SetupError('A setup operation is already running.', 409);
        bootstrap = null; service.disconnect();
        session = { id: secret(), csrf: secret(), expiresAt: now() + 1800000 };
        json(res, 200, { csrf: session.csrf }, { 'set-cookie': `crw_setup_session=${session.id}; HttpOnly; SameSite=Strict; Path=/api/setup; Max-Age=1800` }); return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/setup/session' && !session) { json(res, 200, { unlocked: false }); return true; }
      const cookies = String(req.headers.cookie || '').split(';').map(value => value.trim());
      if (!session || !cookies.some(value => equal(value, `crw_setup_session=${session.id}`))) throw new SetupError('Unlock setup on this machine to continue.', 401);
      if (req.method === 'GET' && url.pathname === '/api/setup/session') { json(res, 200, { csrf: session.csrf, unlocked: true }); return true; }
      if (!equal(req.headers['x-setup-csrf'], session.csrf)) throw new SetupError('Setup authorization is missing. Reopen setup.', 403);
      session.expiresAt = now() + 1800000;
      if (req.method === 'GET' && url.pathname === '/api/setup/quick/status') { json(res,200,quick.status());return true; }
      if (req.method === 'GET' && url.pathname === '/api/setup/status') { await service.resume(); const receipt = await service.receipt(); json(res, 200, { ...service.status(), deployment: receipt ? { phase: receipt.phase, input: receipt.input, identityRecovery: !!receipt.identityChange, configurationRecovery: !!receipt.configurationChange } : null }); return true; }
      if (requestBusy) throw new SetupError('Wait for the current setup request to finish.', 409);
      requestBusy = true;
      try {
        if (req.method === 'GET' && url.pathname === '/api/setup/resources') json(res, 200, await service.discover(url.searchParams.get('accountId')));
        else if (req.method === 'POST') {
          const body = await readJsonBody(req, 8192);
          switch (url.pathname) {
            case '/api/setup/quick/start': quick.start(body.email);json(res,202,quick.status());break;
            case '/api/setup/quick/stop': void quick.stop();json(res,202,quick.status());break;
            case '/api/setup/credential/forget': await service.forgetCredential(); json(res, 200, { forgotten: true }); break;
            case '/api/setup/credential/retry': service.restoreAttempted = false; await service.resume(); json(res, 200, service.status()); break;
            case '/api/setup/connect': json(res, 200, { accounts: await service.connect(body.token) }); break;
            case '/api/setup/change/preview': json(res, 200, await service.previewConfiguration(body)); break;
            case '/api/setup/change/recover': service.startIdentityRecovery(); json(res, 202, service.status()); break;
            case '/api/setup/preview': json(res, 200, await service.preview(body)); break;
            case '/api/setup/apply': service.startApply(body.id); json(res, 202, service.status()); break;
            case '/api/setup/remove': service.startRemove(); json(res, 202, service.status()); break;
            case '/api/setup/doctor': json(res, 200, await service.diagnose()); break;
            case '/api/setup/lock': service.disconnect(); session = null; json(res, 200, { locked: true }, { 'set-cookie': 'crw_setup_session=; HttpOnly; SameSite=Strict; Path=/api/setup; Max-Age=0' }); break;
            default: json(res, 404, { error: 'Unknown setup endpoint' });
          }
        } else json(res, 405, { error: 'Method not allowed' });
      } finally { requestBusy = false; expire(); }
    } catch (error) { json(res, error instanceof SetupError ? error.status : 500, { error: error instanceof SetupError ? error.message : 'Setup request failed. Check the local installation and try again.', ...(error instanceof SetupError && error.details ? { details: error.details } : {}) }); }
    return true;
  }
  return { handle, issue, service, quick, close() { clearInterval(timer); if (!service.busy) service.disconnect(); return quick.stop(); } };
}
export async function startSetupServer({ port = 0, ...options } = {}) {
  const handler = createSetupHandler(options);
  const server = createServer(async (req, res) => { if (req.url === '/' || req.url?.startsWith('/#')) req.url = '/setup'; if (!await handler.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/setup#setup=${handler.issue()}`;
  server.on('close', () => handler.close());
  return { server, handler, url };
}
