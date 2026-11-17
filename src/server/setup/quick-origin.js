import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createHttpHandler } from '../http/router.ts';
import { attachTransports } from '../realtime/transports.ts';
// This authenticator is used only on an owner-private Unix socket reached by
// cloudflared AFTER its protected Quick Tunnel authorizer. It never trusts a
// client email header, nor applies to the normal TCP workspace listener.
export function quickAuthenticator(config) {
  return async req => {
    const fail = () => ({ ok:false, status:403, code:'AUTH_FORBIDDEN' });
    if (!config.publicOrigin || req.headers.host?.toLowerCase() !== new URL(config.publicOrigin).host) return fail();
    const path = (req.url || '/').split('?')[0];
    const navigation = req.method === 'GET' && !req.headers.upgrade && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document' && (path === '/' || path === '/index.html' || /^\/settings(?:\/[^/]+)?\/?$/.test(path));
    if (req.headers.origin && req.headers.origin !== config.publicOrigin) return fail();
    if (req.headers['sec-fetch-site'] === 'cross-site' && !navigation) return fail();
    return { ok:true, principal:{ sub:'quick-tunnel-owner', email:config.allowedEmail, expiresAt:Number.MAX_SAFE_INTEGER } };
  };
}
export function privateQuickAuthenticator(config, privateHost) {
  const baseAuth = quickAuthenticator(config);
  return async req => {
    if (privateHost) {
      const supplied = req.headers.host;
      if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(privateHost) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(privateHost)) || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return { ok: false, status: 403, code: 'AUTH_FORBIDDEN' };
      // Only the protected connector knows this per-run capability. Restore the
      // public Host for existing auth, Origin and WebSocket boundary checks.
      const previous = req.headers.host;
      req.headers.host = config.publicOrigin ? new URL(config.publicOrigin).host : '';
      try { return await baseAuth(req); } finally { req.headers.host = previous; }
    }
    return baseAuth(req);
  };
}
export async function openQuickOrigin({ socketPath, privateHost, email, context }) {
  const config = { mode:'quick-tunnel', publicOrigin:null, allowedEmail:email };
  const accessAuth = privateQuickAuthenticator(config, privateHost), sockets = new Set();
  const handler = createHttpHandler({ ...context, authConfig:config, localAuth:null, accessAuth });
  const server = createServer(async (req,res) => {
    if (/^\/(?:api\/setup(?:\/|$)|setup(?:\/|$)|setup\.bundle\.js)/.test(req.url || '')) { res.writeHead(404);res.end();return; }
    await handler(req,res);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  // This listener has no SSE clients; do not duplicate the TCP listener's keepalives.
  const transports = attachTransports({ ...context, server, accessAuth, localAuth:null, sseClients:new Set() });
  try { await new Promise((resolve,reject) => { server.once('error',reject); if (privateHost) server.listen(0, '127.0.0.1', resolve); else server.listen(socketPath,resolve); }); }
  catch(error) { transports.close({terminate:true});throw error; }
  let closed;
  return {
    ...(privateHost ? { port: server.address().port } : {}),
    activate(publicOrigin) { config.publicOrigin = publicOrigin; },
    close() { return closed ||= (async () => {
      config.publicOrigin=null;transports.close({terminate:true});
      const done = new Promise(resolve => server.close(resolve));
      for(const socket of sockets) socket.destroy();
      await done;
    })(); },
  };
}
