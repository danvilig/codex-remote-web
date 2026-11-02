import { expect, test } from 'bun:test';
import { createLocalJWKSet, createRemoteJWKSet, customFetch, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { accessConfiguration } from '../../src/server/config/access.js';
import { createAccessAuthenticator } from '../../src/server/auth/access.js';
import { createConnectionLease, MAX_CONNECTION_MS } from '../../src/server/realtime/lease.js';
import { saveAccessDraft, takeAccessDraft } from '../../public/access-session.js';
import { workspaceMutation } from '../../src/server/http/workspace-mutation.js';

const env = { CODEX_WEBUI_AUTH_MODE: 'cloudflare-access', CODEX_WEBUI_PUBLIC_ORIGIN: 'https://workspace.example.test', CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN: 'example-team.cloudflareaccess.com', CODEX_WEBUI_CF_ACCESS_AUD: 'test-audience', CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL: 'owner@example.test' };
const config = accessConfiguration(env);
const first = await generateKeyPair('RS256'), second = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(first.publicKey), kid: 'first', alg: 'RS256' };
const req = (token?: string, extra: any = {}) => ({ headers: { host: 'workspace.example.test', origin: config.publicOrigin, ...(token ? { 'cf-access-jwt-assertion': token } : {}), ...extra } });
const now = Math.floor(Date.now() / 1000);
async function sign(overrides: any = {}, key = first.privateKey, kid = 'first') { return new SignJWT({ sub: 'owner-id', email: env.CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL, ...overrides }).setProtectedHeader({ alg: 'RS256', kid }).setIssuer(config.issuer).setAudience(config.audience).setIssuedAt(now).setExpirationTime(now + 120).sign(key); }
const authenticate = createAccessAuthenticator(config, { keySet: createLocalJWKSet({ keys: [jwk] }) });

test('Access configuration is explicit, complete, HTTPS-only and bound to loopback', () => {
  expect(accessConfiguration({})).toEqual({ mode: 'local' });
  expect(() => accessConfiguration({ CODEX_WEBUI_AUTH_MODE: 'typo' })).toThrow();
  for (const key of Object.keys(env).filter(k => k !== 'CODEX_WEBUI_AUTH_MODE')) expect(() => accessConfiguration({ ...env, [key]: '' })).toThrow();
  for (const value of ['http://workspace.example.test', 'https://workspace.example.test/path', 'https://a:b@workspace.example.test']) expect(() => accessConfiguration({ ...env, CODEX_WEBUI_PUBLIC_ORIGIN: value })).toThrow();
  expect(() => accessConfiguration({ ...env, CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN: '127.0.0.1:1234' })).toThrow();
  expect(() => accessConfiguration({ ...env, HOST: '0.0.0.0' })).toThrow();
});

test('optional local inspection accepts only loopback localhost requests', async () => {
  const localConfig = accessConfiguration({ ...env, CODEX_WEBUI_ALLOW_LOCAL_LOOPBACK: 'true' });
  const localAuth = createAccessAuthenticator(localConfig, { keySet: createLocalJWKSet({ keys: [jwk] }) });
  expect(await localAuth({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:51701' } })).toEqual({ ok: true, principal: null });
  expect(await localAuth({ socket: { remoteAddress: '::1' }, headers: { host: '127.0.0.1:51701' } })).toEqual({ ok: true, principal: null });
  expect(await localAuth({ socket: { remoteAddress: '192.168.1.5' }, headers: { host: 'localhost:51701' } })).toMatchObject({ ok: false, code: 'AUTH_FORBIDDEN', status: 403 });
  expect(await localAuth({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'workspace.example.test' } })).toMatchObject({ ok: false, code: 'AUTH_REQUIRED', status: 401 });
  for (const host of ['localhost:51701', '127.0.0.1:8900', '[::1]:8900']) {
    const headers = { host, origin: `http://${host}`, 'content-type': 'application/json', 'x-workspace-request': '1' };
    const request = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers };
    expect((await localAuth(request)).ok).toBe(true);
    expect(workspaceMutation(request, localConfig)).toBe(true);
    for (const extra of [{ origin: 'https://evil.test' }, { origin: 'null' }, { origin: 'http://localhost:9999' }, { 'sec-fetch-site': 'cross-site' }, { 'cf-connecting-ip': '203.0.113.1' }, { 'x-forwarded-for': '127.0.0.1' }, { forwarded: 'for=127.0.0.1' }, { 'x-real-ip': '127.0.0.1' }]) {
      const bad = { ...request, headers: { ...headers, ...extra } };
      expect((await localAuth(bad)).ok).toBe(false);
      expect(workspaceMutation(bad, localConfig)).toBe(false);
    }
  }
  expect((await authenticate({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:8900' } })).ok).toBe(false);
});

test('Access accepts only the configured identity and keeps tokens private', async () => {
  const token = await sign();
  const result = await authenticate(req(token));
  expect(result).toMatchObject({ ok: true, principal: { email: env.CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL, sub: 'owner-id' } });
  expect(JSON.stringify(result)).not.toContain(token);
  expect(await authenticate(req(await sign({ email: 'other@example.test' })))).toMatchObject({ ok: false, status: 403 });
  expect(await authenticate(req(undefined, { 'cf-access-authenticated-user-email': env.CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL, authorization: 'Bearer fake', 'x-forwarded-for': '127.0.0.1' }))).toMatchObject({ ok: false, status: 401 });
  for (const extra of [{ origin: 'https://evil.test' }, { host: 'localhost' }, { 'sec-fetch-site': 'cross-site' }]) expect(await authenticate(req(token, extra))).toMatchObject({ ok: false, status: 403 });
});

test('Access login returns allow document navigation while still requiring JWT and rejecting cross-site operations', async () => {
  const token = await sign();
  const navigation = { origin: undefined, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const request = (jwt = token, url = '/', method = 'GET', extra = {}) => ({ ...req(jwt, { ...navigation, ...extra }), url, method });
  for (const path of ['/', '/index.html', '/settings/general-settings']) expect((await authenticate(request(token, path))).ok).toBe(true);
  expect(await authenticate(request('not-a-jwt'))).toMatchObject({ ok: false, code: 'AUTH_REQUIRED' });
  expect(await authenticate(request(await sign({ email: 'other@example.test' })))).toMatchObject({ ok: false, status: 403 });
  for (const r of [request(token, '/api/config'), request(token, '/', 'POST'), request(token, '/', 'GET', { upgrade: 'websocket' }), request(token, '/', 'GET', { 'sec-fetch-dest': 'iframe' }), request(token, '/', 'GET', { 'sec-fetch-mode': 'cors' }), request(token, '/', 'GET', { origin: 'https://evil.test' }), request(token, '/', 'GET', { host: 'wrong.test' })]) expect(await authenticate(r)).toMatchObject({ ok: false, status: 403 });
});

test('Access rejects forged, expired, not-yet-valid, wrong issuer/audience and incomplete JWTs', async () => {
  const invalid = [
    await sign({}, second.privateKey),
    await new SignJWT({ sub: 'owner-id', email: config.allowedEmail }).setProtectedHeader({ alg: 'RS256', kid: 'first' }).setIssuer('https://other.cloudflareaccess.com').setAudience(config.audience).setIssuedAt(now).setExpirationTime(now + 100).sign(first.privateKey),
    await new SignJWT({ sub: 'owner-id', email: config.allowedEmail }).setProtectedHeader({ alg: 'RS256', kid: 'first' }).setIssuer(config.issuer).setAudience('wrong-audience').setIssuedAt(now).setExpirationTime(now + 100).sign(first.privateKey),
    await sign({ nbf: now + 500 }), await sign({ sub: '' }), await sign({ email: null }),
    await new SignJWT({ sub: 'owner-id', email: config.allowedEmail }).setProtectedHeader({ alg: 'RS256', kid: 'first' }).setIssuer(config.issuer).setAudience(config.audience).setIssuedAt(now).sign(first.privateKey), 'not-a-jwt',
  ];
  for (const token of invalid) expect(await authenticate(req(token))).toMatchObject({ ok: false });
  const expired = await new SignJWT({ sub: 'owner-id', email: config.allowedEmail }).setProtectedHeader({ alg: 'RS256', kid: 'first' }).setIssuer(config.issuer).setAudience(config.audience).setIssuedAt(now - 100).setExpirationTime(now - 1).sign(first.privateKey);
  expect(await authenticate(req(expired))).toMatchObject({ ok: false, code: 'AUTH_EXPIRED' });
});

test('JWKS is cached, refreshes on key rotation and fails closed on fetch failure', async () => {
  let requests = 0;
  let keys = [jwk];
  const remote = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), { cooldownDuration: 0, [customFetch]: async url => { expect(String(url)).toBe(`${config.issuer}/cdn-cgi/access/certs`); requests++; return Response.json({ keys }); } });
  const auth = createAccessAuthenticator(config, { keySet: remote });
  expect((await auth(req(await sign()))).ok).toBe(true); expect((await auth(req(await sign()))).ok).toBe(true); expect(requests).toBe(1);
  keys = [{ ...await exportJWK(second.publicKey), kid: 'second', alg: 'RS256' }];
  expect((await auth(req(await sign({}, second.privateKey, 'second')))).ok).toBe(true); expect(requests).toBe(2);
  const unavailable = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), { [customFetch]: async () => { throw new Error('private upstream failure'); } });
  expect(await createAccessAuthenticator(config, { keySet: unavailable })(req(await sign()))).toEqual({ ok: false, code: 'AUTH_REQUIRED', status: 401 });
});

test('leases stop at token expiry or five minutes, reject further messages and clean up once', () => {
  let time = 1000; const ended: string[] = [];
  const lease = createConnectionLease({ expiresAt: 2000 }, reason => ended.push(reason), { now: () => time });
  expect(lease.valid()).toBe(true); time = 2000; expect(lease.valid()).toBe(false); expect(lease.valid()).toBe(false); expect(ended).toEqual(['AUTH_EXPIRED']);
  const refresh = createConnectionLease({ expiresAt: 9999999 }, reason => ended.push(reason), { now: () => time });
  time += MAX_CONNECTION_MS; expect(refresh.valid()).toBe(false); expect(ended).toEqual(['AUTH_EXPIRED', 'AUTH_REFRESH']); refresh.dispose();
  const disposed = createConnectionLease({ expiresAt: time + 1000 }, () => { throw new Error('disposed lease ran'); }, { now: () => time }); disposed.dispose();
});

test('tab drafts are restored only to their original conversation/project and consumed once', () => {
  const values = new Map(); const storage = { getItem: (k: string) => values.get(k), setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) };
  saveAccessDraft(storage, { text: 'Do not resend automatically', threadId: 'thread-a', cwd: '/project' });
  expect(takeAccessDraft(storage, { threadId: 'thread-b' })).toBeNull();
  expect(takeAccessDraft(storage, { threadId: 'thread-a' })).toBe('Do not resend automatically');
  expect(takeAccessDraft(storage, { threadId: 'thread-a' })).toBeNull();
  saveAccessDraft(storage, { text: 'new chat', cwd: '/project' });
  expect(takeAccessDraft(storage, { cwd: '/other' })).toBeNull(); expect(takeAccessDraft(storage, { cwd: '/project' })).toBe('new chat');
});
