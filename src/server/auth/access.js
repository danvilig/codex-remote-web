import { createRemoteJWKSet, jwtVerify } from 'jose';
import { isLocalInspectionRequest } from './loopback.js';

export function createAccessAuthenticator(config, { keySet, currentDate } = {}) {
  const keys = keySet || createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000, cooldownDuration: 1000, cacheMaxAge: 600000 });
  return async function authenticate(req) {
    const fail = (code = 'AUTH_REQUIRED', status = 401) => ({ ok: false, code, status });
    if (isLocalInspectionRequest(req, config)) return { ok: true, principal: null };
    // Host and Origin use configured public values, never arbitrary forwarded headers.
    // Access sign-in can return from another site. Only allow a top-level,
    // read-only page navigation through this guard; JWT verification still runs.
    const page = (req.url || '/').split('?')[0];
    const navigation = req.method === 'GET' && !req.headers.upgrade && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document' && (page === '/' || page === '/index.html' || /^\/settings(?:\/[^/]+)?\/?$/.test(page));
    if (req.headers.host?.toLowerCase() !== new URL(config.publicOrigin).host.toLowerCase() || (req.headers['sec-fetch-site'] === 'cross-site' && !navigation)) return fail('AUTH_FORBIDDEN', 403);
    if (req.headers.origin && req.headers.origin !== config.publicOrigin) return fail('AUTH_FORBIDDEN', 403);
    const token = req.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || token.length > 16384) return fail();
    try {
      const { payload } = await jwtVerify(token, keys, { algorithms: ['RS256'], issuer: config.issuer, audience: config.audience, requiredClaims: ['exp', 'iat', 'sub', 'email'], ...(currentDate ? { currentDate: currentDate() } : {}) });
      if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.email !== 'string' || payload.email.toLowerCase() !== config.allowedEmail) return fail('AUTH_FORBIDDEN', 403);
      return { ok: true, principal: { sub: payload.sub, email: payload.email, expiresAt: payload.exp * 1000 } };
    } catch (error) { return fail(error?.code === 'ERR_JWT_EXPIRED' ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED'); }
  };
}
export function authError(res, result) {
  res.writeHead(result.status || 401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify({ error: 'Authentication required', code: result.code || 'AUTH_REQUIRED' }));
}
