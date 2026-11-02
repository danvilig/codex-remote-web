import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPasswordSession, createStoredPassword, isAuthorizedHttpRequest, isRequestAuthorized, passwordSessionCookie, storedPasswordSessionSecret, verifyStoredPassword } from './local.js';
import { loadStoredPassword, passwordStorePath, saveStoredPassword, type StoredPassword } from './password-store.ts';
import { readJsonBody } from '../http/body.ts';
export function createLocalAuth(host: string) {
const accessToken = process.env.CODEX_WEBUI_ACCESS_TOKEN || null;
const environmentPassword = process.env.CODEX_WEBUI_PASSWORD || null;
const managedPasswordPath = passwordStorePath();
let managedPassword: StoredPassword | null = environmentPassword || accessToken ? null : loadStoredPassword(managedPasswordPath);
let authSecret = environmentPassword || accessToken || storedPasswordSessionSecret(managedPassword);
let passwordSetupInProgress = false;
const localhostOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
function passwordSetupRequired() {
  return !localhostOnly && !authSecret;
}

function browserPasswordConfigured() {
  return Boolean(environmentPassword || managedPassword || accessToken);
}

function requestMatchesSecret(req: IncomingMessage, submittedPassword: string, expectedSecret: string | null) {
  if (!submittedPassword || !expectedSecret) return false;
  return isRequestAuthorized({
    remoteAddress: req.socket.remoteAddress,
    hostHeader: req.headers.host,
    authorization: `Bearer ${submittedPassword}`,
    accessToken: expectedSecret,
    origin: req.headers.origin,
    fetchSite: req.headers["sec-fetch-site"],
    forwardedFor: req.headers["x-forwarded-for"],
    forwarded: req.headers.forwarded,
    realIp: req.headers["x-real-ip"],
    allowLoopback: false,
  });
}

function validBrowserPassword(req: IncomingMessage, submittedPassword: string) {
  if (environmentPassword) return requestMatchesSecret(req, submittedPassword, environmentPassword);
  if (managedPassword) {
    if (!requestMatchesSecret(req, submittedPassword, submittedPassword)) return false;
    return verifyStoredPassword(submittedPassword, managedPassword);
  }
  return requestMatchesSecret(req, submittedPassword, accessToken);
}

function sendAuthError(res: ServerResponse, status: number, error: string, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify({ error }));
}

function issueBrowserSession(req: IncomingMessage, res: ServerResponse) {
  if (!authSecret) throw new Error("Authentication is not configured");
  const session = createPasswordSession(authSecret);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "set-cookie": passwordSessionCookie(session.token, { secure: Boolean((req.socket as any).encrypted) }),
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify({ ok: true }));
}

async function serve(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (url.pathname === "/api/auth/status") {
    const authenticated = isAuthorizedHttpRequest(req, authSecret);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({
      mode: 'local', expiresAt: null,
      setupRequired: passwordSetupRequired() && !authenticated,
      passwordRequired: browserPasswordConfigured(),
      authenticated,
    }));
    return;
  }
  if (url.pathname === "/api/auth/setup") {
    if (req.method !== "POST") {
      sendAuthError(res, 405, "Method not allowed", { allow: "POST" });
      return;
    }
    let payload: any;
    try { payload = await readJsonBody(req, 4096); }
    catch (error) {
      sendAuthError(res, 400, error instanceof Error ? error.message : "Invalid setup request");
      return;
    }
    const submittedPassword = typeof payload?.password === "string" ? payload.password : "";
    if (submittedPassword.length < 12 || submittedPassword.length > 256) {
      sendAuthError(res, 400, "Password must be between 12 and 256 characters");
      return;
    }
    if (!requestMatchesSecret(req, submittedPassword, submittedPassword)) {
      sendAuthError(res, 403, "Password setup request was rejected");
      return;
    }
    if (!passwordSetupRequired() || passwordSetupInProgress) {
      sendAuthError(res, 409, "Password setup is no longer available");
      return;
    }
    passwordSetupInProgress = true;
    try {
      const credential = createStoredPassword(submittedPassword) as StoredPassword;
      saveStoredPassword(managedPasswordPath, credential);
      managedPassword = credential;
      authSecret = storedPasswordSessionSecret(credential);
      issueBrowserSession(req, res);
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        try {
          managedPassword = loadStoredPassword(managedPasswordPath);
          authSecret = storedPasswordSessionSecret(managedPassword);
        } catch { /* Keep the original exclusive-create failure as the response. */ }
        sendAuthError(res, 409, "Password setup is no longer available");
      } else {
        console.error("[codex-webui] password setup failed", error);
        sendAuthError(res, 500, "Unable to save the password");
      }
    } finally {
      passwordSetupInProgress = false;
    }
    return;
  }
  if (url.pathname === "/api/auth/login") {
    if (req.method !== "POST") {
      sendAuthError(res, 405, "Method not allowed", { allow: "POST" });
      return;
    }
    let payload: any;
    try { payload = await readJsonBody(req, 4096); }
    catch {
      sendAuthError(res, 401, "Incorrect password");
      return;
    }
    const submittedPassword = typeof payload?.password === "string" ? payload.password : "";
    if (!validBrowserPassword(req, submittedPassword)) {
      sendAuthError(res, 401, "Incorrect password");
      return;
    }
    issueBrowserSession(req, res);
    return;
  }

}
return {
  authorized: (req: IncomingMessage) => isAuthorizedHttpRequest(req, authSecret),
  setupRequired: passwordSetupRequired,
  async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!['/api/auth/status', '/api/auth/setup', '/api/auth/login'].includes(url.pathname)) return false;
    await serve(req, res, url); return true;
  },
};
}
