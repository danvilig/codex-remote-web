import { createAttachmentService } from '../services/attachments.js';
import { createConversationTools } from '../services/conversation-tools.js';
import { name as packageName, version as packageVersion } from '../../../package.json';
import { createReadStream, readFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { listFolders, resolveBrowsePath, isDirectory } from '../files/folders.js';
import { applyReviewPatch } from '../review/service.js';
import { parseReviewPatchRequest } from '../review/state.js';
import { searchWorkspaceFiles } from '../files/search.js';
import { libraryFiles, libraryPreview } from '../files/library.js';
import { readDocument, saveDocument } from '../files/documents.js';
import { resolveLocalFile } from '../files/download.js';
import { resolveLocalImage } from '../files/images.js';
import { readWorkspaceContext } from '../services/workspace-context.js';
import { createCustomizationService } from '../services/customization.js';
import { workspaceMutation } from './workspace-mutation.js';
import { storageUsage, listWorktrees } from '../services/storage.js';
import { createSettingsService } from '../services/settings.js';
import { resolvePublicAsset, resolveSafeRegularFile, unauthorizedResponse } from '../auth/local.js';
import { fetchProfileAvatar, isLocalAccountRequest, toPublicAccountIdentity, resolveAccountIdentity } from '../services/profile.ts';
import { authError } from '../auth/access.js';
import { createConnectionLease } from '../realtime/lease.js';
import { readJsonBody } from './body.ts';
import { remoteAccessStatus } from '../services/remote-access.js';
import { localSetupRequest } from '../setup/http.js';
function encodeContentDispositionFilename(filename: string) {
  return encodeURIComponent(filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

export function createHttpHandler(context: any) {
  const { request, sideChats, appRoot, publicDir, authConfig, localAuth, accessAuth, managedPasswordPath, defaultCwd, browseRoots, homeDir, imageRoots, fileRoots, privateCodexRoot, reviewRoots, capabilities, projectless, dispatchBrowserMessage, reviewDiffs, accountLoader, sseClients, leases, isConnected } = context;
  const attachments = createAttachmentService({privateRoot:privateCodexRoot,home:homeDir,browseRoots});
  const settingsService = createSettingsService(request);
  const customization = createCustomizationService(request, { privateRoot: privateCodexRoot, home: homeDir, browseRoots });
  const conversationTools = createConversationTools(request);
  let storagePending: Promise<unknown> | null = null;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const connected = isConnected();
  let url: URL;
  try { url = new URL(req.url || "/", "http://localhost"); }
  catch {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({ error: "Invalid request URL" }));
    return;
  }
  const appRoute = req.method === "GET" && (url.pathname === "/" || /^\/settings(?:\/[^/]+)?\/?$/.test(url.pathname));
  const loginAssets = new Set(["/", "/index.html", "/style.css", "/workspace.css", "/remote-access.css", "/favicon.svg", "/auth-bootstrap.js", "/access-session.js", "/i18n.js", "/codex-brand.js"]);
  const auth = accessAuth ? await accessAuth(req) : { ok: localAuth!.authorized(req), principal: null, code: 'AUTH_REQUIRED', status: 401 };
  if (accessAuth && url.pathname.startsWith('/api/auth/')) {
    if (url.pathname !== '/api/auth/status') { res.writeHead(404); res.end(); return; }
    res.writeHead(auth.ok ? 200 : auth.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ mode: authConfig.mode, ...(authConfig.mode === 'quick-tunnel' ? { transports: { websocket: true, sse: false }, temporary: true } : {}), authenticated: auth.ok, setupRequired: false, passwordRequired: false, expiresAt: authConfig.mode === 'quick-tunnel' ? null : auth.principal?.expiresAt || null, identity: auth.ok && auth.principal ? { email: auth.principal.email } : null, loginUrl: authConfig.publicOrigin + '/', ...(auth.ok ? {} : { code: auth.code }) })); return;
  }
  if (localAuth && await localAuth.handle(req, res, url)) return;
  if (!auth.ok) {
    if (accessAuth) { authError(res, auth); return; }
    if (appRoute || loginAssets.has(url.pathname)) {
      const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
      if (file) {
        res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
        res.end(readFileSync(file));
        return;
      }
    }
    unauthorizedResponse(res);
    return;
  }
  if (url.pathname === '/api/remote-access/status') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
    try { res.end(JSON.stringify({ ...await remoteAccessStatus(authConfig, homeDir, auth.principal), canManage: localSetupRequest(req) })); }
    catch { res.writeHead(503); res.end(JSON.stringify({ error: 'Remote access status is unavailable. Try again.' })); }
    return;
  }
  if (authConfig.mode === 'quick-tunnel' && url.pathname === '/api/events') {
    res.writeHead(409, {'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({error:'Temporary access requires WebSocket. SSE is unavailable.',code:'TRANSPORT_UNAVAILABLE'}));return;
  }
  if (url.pathname === "/api/events") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.flushHeaders?.();
    res.write("retry: 1000\n\n");
    sseClients.add(res);
    leases.set(res, createConnectionLease(auth.principal, code => {
      if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ type: code === 'AUTH_REFRESH' ? 'bridge/reconnect' : 'auth/required', code })}\n\n`); res.end(); }
      sseClients.delete(res);
    }));
    res.write(`data: ${JSON.stringify({ type: "bridge/status", status: connected ? "connected" : "connecting" })}\n\n`);
    res.on("close", () => { leases.get(res)?.dispose(); sseClients.delete(res); });
    return;
  }
  if (url.pathname === "/api/rpc" || url.pathname === "/api/codex/respond") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const payload = await readJsonBody(req);
      if (auth.principal && auth.principal.expiresAt <= Date.now()) { authError(res, { code: 'AUTH_EXPIRED', status: 401 }); return; }
      const message = url.pathname === "/api/rpc"
        ? { type: "rpc", id: payload.id, method: payload.method, params: payload.params || {} }
        : { type: payload.error ? "codex/error" : "codex/response", requestId: payload.requestId, requestEpoch: payload.requestEpoch, result: payload.result, error: payload.error };
      const reply = await dispatchBrowserMessage(message);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(reply));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, codex: connected, name: packageName, version: packageVersion }));
    return;
  }
  if (url.pathname === "/api/config") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ home: homeDir, defaultCwd, reviewRoot: reviewRoots[0], projectless, capabilities }));
    return;
  }
  if (url.pathname === '/api/conversation/side-chat') {
    res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    if(!workspaceMutation(req,authConfig)){res.writeHead(403);res.end(JSON.stringify({error:'A same-origin workspace request is required.'}));return;}
    try { res.end(JSON.stringify(await sideChats.handle(await readJsonBody(req,16384)))); }
    catch { res.writeHead(400); res.end(JSON.stringify({error:'Temporary side chat is unavailable or expired. Your draft was kept.'})); }
    return;
  }
  if (['/api/conversation/fork','/api/conversation/goal','/api/composer/tools'].includes(url.pathname)) {
    res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');
    if(!['GET','POST'].includes(req.method||'') || (url.pathname.endsWith('/fork')&&req.method!=='POST')) {res.writeHead(405);res.end();return;}
    if(req.method==='POST'&&!workspaceMutation(req,authConfig)){res.writeHead(403);res.end(JSON.stringify({error:'A same-origin workspace request is required.'}));return;}
    try {
      let result;
      if(url.pathname==='/api/composer/tools') {
        const cwd=resolveBrowsePath(url.searchParams.get('cwd')||defaultCwd,browseRoots,homeDir);
        if(!isDirectory(cwd))throw new Error('Invalid project');
        result=req.method==='GET'?await customization.composerTools(cwd):await customization.resolveComposerTools(cwd,await readJsonBody(req,16384));
      } else if(url.pathname.endsWith('/fork'))result=await conversationTools.fork(await readJsonBody(req,16384));
      else result=await conversationTools.goal(req.method==='GET'?{threadId:url.searchParams.get('threadId'),action:'get'}:await readJsonBody(req,20000));
      res.end(JSON.stringify(result));
    }catch{res.writeHead(400);res.end(JSON.stringify({error:'This action is unavailable. Check the Codex connection and feature support.'}));}
    return;
  }
  if (url.pathname.startsWith('/api/attachments')) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const path = url.pathname;
    const binary = path === '/api/attachments/upload';
    const routes = ['/api/attachments', '/api/attachments/upload', '/api/attachments/resolve', '/api/attachments/file', '/api/attachments/preview'];
    if (!routes.includes(path)) { res.writeHead(404); res.end(); return; }
    const expected = binary || path === '/api/attachments/resolve' ? 'POST' : 'GET';
    if (req.method !== expected) { res.writeHead(405, {allow: expected}); res.end(); return; }
    if (expected === 'POST' && !workspaceMutation(req, authConfig, binary ? 'application/octet-stream' : 'application/json')) {
      res.writeHead(403, {'content-type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify({error: 'A same-origin workspace request is required.'}));
      return;
    }
    try {
      if (path === '/api/attachments/file') {
        const opened = await attachments.file(url.searchParams.get('id'));
        const inline = url.searchParams.get('view') === 'image' && opened.item.image;
        const types = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'};
        res.writeHead(200, {
          'content-type': inline ? types[extname(opened.item.name).toLowerCase()] : 'application/octet-stream',
          'content-length': opened.item.bytes,
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeContentDispositionFilename(opened.item.name)}`,
          'content-security-policy': "default-src 'none'; sandbox"
        });
        const stream = opened.fd.createReadStream();
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
      let result;
      if (binary) result = await attachments.upload(req, {cwd: url.searchParams.get('cwd'), name: url.searchParams.get('name')});
      else if (path === '/api/attachments/resolve') result = await attachments.resolveInput(await readJsonBody(req, 16384));
      else if (path === '/api/attachments/preview') result = await attachments.preview(url.searchParams.get('id'));
      else result = await attachments.list({
        cwd: url.searchParams.get('cwd') || defaultCwd,
        threadId: url.searchParams.get('threadId'),
        scope: url.searchParams.get('scope') || 'project',
        query: url.searchParams.get('query') || ''
      });
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify(result));
    } catch (error) {
      if (binary) req.resume();
      res.writeHead(error.status === 413 ? 413 : error.status === 409 ? 409 : 400, {'content-type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify({error: error.status === 413 ? 'File exceeds the upload or storage limit.' : 'Attachment unavailable. Check the file, project and storage permissions.'}));
    }
    return;
  }
  if (url.pathname === "/api/customize") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    if (!['GET','POST'].includes(req.method || '')) { res.writeHead(405, { allow: "GET, POST" }); res.end(JSON.stringify({ error: "Method not allowed" })); return; }
    if (req.method === 'POST' && !workspaceMutation(req,authConfig)) { res.writeHead(403); res.end(JSON.stringify({error:'A same-origin workspace request is required.'})); return; }
    try {
      const cwd = resolveBrowsePath(url.searchParams.get("cwd") || defaultCwd, browseRoots, homeDir);
      if (!isDirectory(cwd)) throw new Error("Invalid project");
      res.end(JSON.stringify(req.method === 'GET' ? await customization.read(cwd) : await customization.write(cwd,await readJsonBody(req,65536))));
    } catch (error) {
      res.writeHead(error.status === 409 ? 409 : 400); res.end(JSON.stringify({ error: "Unable to apply this customization change. Reload the catalog and check permissions and resource ownership." }));
    }
    return;
  }
  if (url.pathname === '/api/files/document') {
    res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store');
    if (!['GET','POST'].includes(req.method || '')) { res.writeHead(405,{allow:'GET, POST'}); res.end(JSON.stringify({error:'Method not allowed'})); return; }
    if (req.method === 'POST' && !workspaceMutation(req,authConfig)) { res.writeHead(403); res.end(JSON.stringify({error:'A same-origin workspace request is required.',code:'FILE_ORIGIN_REQUIRED'})); return; }
    try {
      const options = {browseRoots,home:homeDir,privateRoot:privateCodexRoot,deniedPaths:[managedPasswordPath]};
      const result = req.method === 'GET' ? readDocument({cwd:url.searchParams.get('cwd'),path:url.searchParams.get('path')},options) : saveDocument(await readJsonBody(req,2*1024*1024),options);
      res.end(JSON.stringify(result));
    } catch (error) {
      const known = ['FILE_INVALID','FILE_CONFLICT','FILE_READ_ONLY','FILE_TOO_LARGE','FILE_UNSUPPORTED'].includes(error.code);
      res.writeHead(known ? error.status || 400 : 400); res.end(JSON.stringify({error:'Unable to read or save this project file.',code:known ? error.code : 'FILE_UNAVAILABLE'}));
    }
    return;
  }
  if (url.pathname === '/api/library' || url.pathname === '/api/library/preview') {
    res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
    try {
      const options = { browseRoots, fileRoots, privateRoot: privateCodexRoot, home: homeDir, deniedPaths: [managedPasswordPath] };
      const result = url.pathname.endsWith('/preview') ? await libraryPreview(url.searchParams.get('path'), options) : await libraryFiles({ cwd: url.searchParams.get('cwd') || defaultCwd, path: url.searchParams.get('path') || '', query: url.searchParams.get('query') || '', images: url.searchParams.get('images') === 'true', cursor: url.searchParams.get('cursor') }, options);
      res.end(JSON.stringify(result));
    } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Files are unavailable for this project.' })); }
    return;
  }
  if (url.pathname === '/api/schedules') {
    res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');
    if(!['GET','POST'].includes(req.method || '')){res.writeHead(405,{allow:'GET, POST'});res.end(JSON.stringify({error:'Method not allowed'}));return;}
    if(req.method==='POST'&&!workspaceMutation(req,authConfig)){res.writeHead(403);res.end(JSON.stringify({error:'A same-origin workspace request is required.'}));return;}
    try{res.end(JSON.stringify(req.method==='GET'?await context.scheduler.list():await context.scheduler.mutate(await readJsonBody(req,65536))));}
    catch(error){res.writeHead(error.status===409?409:400);res.end(JSON.stringify({error:error.status===409?'Schedule changed or already running. Reload before trying again.':req.method==='GET'?'Unable to load schedules. Check the server connection and scheduler storage permissions.':'Unable to save this schedule. Check the project, time, permissions and Codex connection.'}));}
    return;
  }
  if (url.pathname === '/api/settings/developer-tools') {
    res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
    if (!workspaceMutation(req, authConfig)) { res.writeHead(403); res.end(JSON.stringify({ error: 'A same-origin workspace request is required.' })); return; }
    try { res.end(JSON.stringify(await context.developerTools.action(await readJsonBody(req, 512 * 1024)))); }
    catch (error) { res.writeHead(error.status || 400); res.end(JSON.stringify({ error: error.message || 'Developer tools unavailable.', code: error.code || 'DEVELOPER_TOOLS_UNAVAILABLE' })); }
    return;
  }
  if (url.pathname === '/api/settings/storage' || url.pathname === '/api/settings/worktrees') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
    try {
      let result;
      if (url.pathname.endsWith('/storage')) {
        storagePending ||= storageUsage(privateCodexRoot).finally(() => { storagePending = null; });
        result = await storagePending;
      } else {
        const cwd = resolveBrowsePath(url.searchParams.get('cwd') || defaultCwd, browseRoots, homeDir);
        result = await listWorktrees(cwd);
      }
      res.end(JSON.stringify(result));
    } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Storage or worktree information is unavailable.' })); }
    return;
  }
  if (url.pathname === "/api/settings") {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", allow: "GET, PUT" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET" && req.method !== "PUT") { respond(405, { error: "Method not allowed" }); return; }
    try {
      const result = req.method === "GET" ? await settingsService.read() : await settingsService.write(await readJsonBody(req, 65536));
      respond(200, result);
    } catch (error) {
      const conflict = (error as any)?.status === 409 || /version|conflict/i.test((error as Error).message);
      // Native config errors may contain private config contents; keep them server-side.
      respond(conflict ? 409 : 400, { error: conflict ? "Settings changed. Reload before saving." : "Unable to read or save Codex settings. Check the supported values and server connection." });
    }
    return;
  }
  if (url.pathname === "/api/workspace/context") {
    try {
      const context = readWorkspaceContext(url.searchParams.get("cwd") || defaultCwd, browseRoots);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(context));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/files/search") {
    try {
      const cwd = url.searchParams.get("cwd") || defaultCwd;
      const query = url.searchParams.get("query") || "";
      const items = await searchWorkspaceFiles(cwd, query, { allowedRoots: browseRoots, limit: 30 });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ cwd, query, items }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/files/download") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const file = resolveLocalFile(url.searchParams.get("path"), {
        cwd: url.searchParams.get("cwd") || defaultCwd,
        home: homeDir,
        allowedRoots: fileRoots,
        deniedRoots: [privateCodexRoot],
        deniedPaths: [process.env.CODEX_AUTH_PATH || join(privateCodexRoot, "auth.json"), managedPasswordPath],
      });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeContentDispositionFilename(file.filename)}`,
        "cache-control": "no-store",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      });
      const stream = createReadStream(file.path);
      stream.on("error", () => res.destroy());
      req.on("aborted", () => stream.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: "File unavailable" }));
    }
    return;
  }
  if (url.pathname === "/api/images/local") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const image = resolveLocalImage(url.searchParams.get("path"), {
        cwd: url.searchParams.get("cwd") || defaultCwd,
        home: homeDir,
        allowedRoots: imageRoots,
      });
      res.writeHead(200, {
        "content-type": image.contentType,
        "content-length": String(image.size),
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(image.filename)}`,
        "cache-control": "private, max-age=60",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      });
      res.end(readFileSync(image.path));
    } catch {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: "Image unavailable" }));
    }
    return;
  }
  if (url.pathname === "/api/account" || url.pathname === "/api/account/avatar") {
    const proxied = Boolean(req.headers["x-forwarded-for"] || req.headers.forwarded || req.headers["x-real-ip"]);
    if (proxied || !isLocalAccountRequest(req.socket.remoteAddress, req.headers.host, req.headers["sec-fetch-site"] as string | undefined)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Account identity is available only on localhost" }));
      return;
    }
    try {
      const account = await accountLoader.get(url.searchParams.get("refresh") === "1");
      if (url.pathname === "/api/account") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(JSON.stringify(toPublicAccountIdentity(account)));
        return;
      }
      if (!account.imageUrl) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "No profile avatar" }));
        return;
      }
      const avatar = await fetchProfileAvatar(account.imageUrl);
      res.writeHead(200, {
        "content-type": avatar.contentType,
        "content-length": String(avatar.body.byteLength),
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      });
      res.end(avatar.body);
    } catch (error) {
      console.warn("[codex-webui] account request failed:", error instanceof Error ? error.message : String(error));
      if (url.pathname === "/api/account/avatar") {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "Profile avatar unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(toPublicAccountIdentity(await resolveAccountIdentity({ account: null, requiresOpenaiAuth: true }))));
    }
    return;
  }
  if (url.pathname === "/api/folders") {
    try {
      const path = resolveBrowsePath(url.searchParams.get("path") || "~", browseRoots, homeDir);
      if (!isDirectory(path)) throw new Error("Directory not found");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(listFolders(path, browseRoots)));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/review/patch") {
    if (!capabilities.reviewWrite) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Review writes are disabled by the server" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy(new Error("Review patch payload too large"));
    });
    req.on("end", async () => {
      let requestPayload: ReturnType<typeof parseReviewPatchRequest> | null = null;
      let operationStarted = false;
      let success = false;
      try {
        const payload = JSON.parse(body || "{}");
        requestPayload = parseReviewPatchRequest(payload);
        const stored = reviewDiffs.begin(requestPayload.threadId, requestPayload.turnId, requestPayload.action);
        operationStarted = true;
        const threadResult = await request("thread/read", { threadId: requestPayload.threadId, includeTurns: false });
        const cwd = threadResult?.thread?.cwd;
        if (typeof cwd !== "string" || !cwd) throw new Error("Thread working directory is unavailable");
        const result = await applyReviewPatch({ cwd, diff: stored.diff, action: requestPayload.action }, reviewRoots);
        success = true;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (operationStarted && requestPayload) reviewDiffs.finish(requestPayload.threadId, requestPayload.turnId, requestPayload.action, success);
      }
    });
    return;
  }
  if (url.pathname.startsWith("/vendor/katex/")) {
    let relative;
    try { relative = decodeURIComponent(url.pathname.slice("/vendor/katex/".length)); }
    catch { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return; }
    const katexDir = resolve(appRoot, "node_modules/katex/dist");
    const file = resolveSafeRegularFile(katexDir, relative);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
    }
    res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "public, max-age=86400" });
    res.end(readFileSync(file));
    return;
  }
  if (url.pathname === "/vendor/xterm/xterm.css") {
    const xtermDir = resolve(appRoot, "node_modules/@xterm/xterm/css");
    const file = resolveSafeRegularFile(xtermDir, "xterm.css");
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
    }
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=86400" });
    res.end(readFileSync(file));
    return;
  }
  const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
  }
  res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    try { await handle(req, res); }
    catch { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: 'Request failed' })); } else res.destroy(); }
  };
}
