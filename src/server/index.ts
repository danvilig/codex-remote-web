import { createSideChatService } from './services/side-chats.js';
import { createSubmissionService, submissionResult } from './services/submissions.js';
import { createDeliveryQueue } from './services/delivery-queue.js';
import { createDeveloperTools } from './services/developer-tools.js';
import { createWorktreeUsageCheck } from './services/worktree-usage.js';
import { createAttachmentService } from './services/attachments.js';
import { randomUUID } from 'node:crypto';
import { QuickTunnel } from './setup/quick.js';
import { createScheduler } from './services/scheduler.js';
import { openQuickOrigin } from './setup/quick-origin.js';
import { createSetupHandler } from './setup/http.js';
import { attachTransports } from './realtime/transports.ts';
import { createHttpHandler } from './http/router.ts';
import { applicationRoot } from "./config/paths.js";
import { name as packageName, version as packageVersion } from "../../package.json";
import { existsSync } from "node:fs";
import { join, relative, resolve, delimiter } from "node:path";
import { createAppServerBridge } from "./bridge/app-server.ts";
import { createServer, type ServerResponse } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { WebSocket } from "ws";
import { defaultBrowseRoots, resolveBrowsePath, isDirectory } from "./files/folders.js";
import { ReviewDiffStore } from "./review/state.js";
import { unifiedDiffFromFileChanges } from "../shared/codex-surfaces.js";
import { rpcErrorPayload } from "../shared/bridge-errors.js";
import { createTerminalSession } from "./terminal/service.js";
import { LiveSessionStore } from "./bridge/live-sessions.js";
import { ServerRequestStore } from "./bridge/server-requests.js";
import { runtimeCapabilities } from "./config/capabilities.js";
import { isAllowedBrowserRpcMethod, resolveSafeRegularFile } from './auth/local.js';
import { passwordStorePath } from './auth/password-store.ts';
import { createLocalAuth } from './auth/local-routes.ts';
import { accessConfiguration } from './config/access.js';
import { createAccessAuthenticator } from './auth/access.js';
import { createConnectionLease } from './realtime/lease.js';
import {
  createAccountIdentityLoader,
  resolveAccountIdentity,
} from "./services/profile.ts";

const host = process.env.HOST || "127.0.0.1";
const capabilities = runtimeCapabilities();
const port = Number(process.env.PORT || 8899);
const localhostOnly = ['127.0.0.1', '::1', 'localhost'].includes(host);
const authConfig = accessConfiguration();
const localAuth = authConfig.mode === 'local' ? createLocalAuth(host) : null;
const accessAuth = authConfig.mode === 'cloudflare-access' ? createAccessAuthenticator(authConfig) : null;
const managedPasswordPath = passwordStorePath();
const appRoot = applicationRoot();
const publicDir = resolve(appRoot, "public");
const homeDir = process.env.HOME || process.cwd();
const projectless = process.env.CODEX_WEBUI_PROJECTLESS === "true";
const configuredReviewRoot = process.env.CODEX_WEBUI_REVIEW_ROOT || null;
const ntfyTopic = process.env.CODEX_WEBUI_NTFY_TOPIC || null;
const ntfyUrl = (process.env.CODEX_WEBUI_NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
if (projectless && !configuredReviewRoot) {
  throw new Error("CODEX_WEBUI_REVIEW_ROOT is required when CODEX_WEBUI_PROJECTLESS=true");
}
const defaultCwd = resolve(process.env.CODEX_WEBUI_CWD || (projectless ? homeDir : appRoot));
const browseRoots = defaultBrowseRoots(homeDir, defaultCwd);
const imageRoots = [...new Set([...browseRoots, resolve(tmpdir()), resolve("/tmp")])];
const fileRoots = [...new Set([...browseRoots, ...(process.env.CODEX_WEBUI_DOWNLOAD_ROOTS || "").split(delimiter).filter(Boolean).map(path => resolve(path))])];
const privateCodexRoot = resolve(process.env.CODEX_HOME || join(homeDir, ".codex"));
const reviewRoots = [resolve(configuredReviewRoot || defaultCwd)];
const clients = new Set<WebSocket>();
const sseClients = new Set<ServerResponse>();
const leases = new WeakMap<object, ReturnType<typeof createConnectionLease>>();
const terminalSessions = new Map<WebSocket, ReturnType<typeof createTerminalSession>>();
const reviewDiffs = new ReviewDiffStore();
const liveSessions = new LiveSessionStore();
const serverRequests = new ServerRequestStore({ requireEpoch: true });
const threadPaths = new Map<string, string>();
let codexSessionsRoot = resolve(homeDir, ".codex", "sessions");
let connected = false;
let shuttingDown = false;
const bridge = createAppServerBridge({
  cwd: defaultCwd,
  clientInfo: { name: packageName, title: 'Codex Remote Web', version: packageVersion },
  onMessage: handleCodex,
  onHome: (path: string) => { codexSessionsRoot = resolve(path, 'sessions'); },
  onStatus: (status: any) => {
    connected = status.status === 'connected';
    if (!connected) { sideChats.clear(); accountLoader.invalidate(); reviewDiffs.clear(); serverRequests.clear(); void scheduler.disconnected().catch(()=>{}); void deliveryQueue.disconnected().catch(()=>{}); }
    else { scheduler.start(); void deliveryQueue.start().catch(error=>console.error('Queue startup failed:', error.message)); }
    broadcast({ type: 'bridge/status', ...status });
  },
});
const request = bridge.request, sendRaw = bridge.send;
const sideChats = createSideChatService({request,resolveCwd:(value: string) => { const cwd=resolveBrowsePath(value||defaultCwd,browseRoots,homeDir); if(!isDirectory(cwd))throw new Error('Invalid project'); return cwd; }});
const scheduler = createScheduler({ request, privateRoot: privateCodexRoot, browseRoots, home: homeDir, connected: () => connected });
const submissions = createSubmissionService({ privateRoot: privateCodexRoot, request, connected: () => connected, onChange: receipt => broadcast({ type: 'submission/changed', receipt: { id: receipt.id, threadId: receipt.threadId, status: receipt.status, updatedAt: receipt.updatedAt } }) });
const queueAttachments = createAttachmentService({ privateRoot: privateCodexRoot, home: homeDir, browseRoots });
const deliveryQueue = createDeliveryQueue({ privateRoot: privateCodexRoot, submissions, request, connected: () => connected, onChange: broadcast, resolveCwd: (value: string) => { const cwd = resolveBrowsePath(value, browseRoots, homeDir); if (!isDirectory(cwd)) throw new Error('Invalid project'); return cwd; } });
const developerTools = createDeveloperTools({ privateRoot: privateCodexRoot, browseRoots, home: homeDir, request, protectedAttachmentIds: () => deliveryQueue.protectedAttachmentIds(), isWorktreeBusy: createWorktreeUsageCheck({ connected: () => connected, terminalCount: () => terminalSessions.size, queue: deliveryQueue, scheduler, request }) });
const accountLoader = createAccountIdentityLoader(async (refresh) => {
  const account = await request("account/read", { refreshToken: refresh });
  return resolveAccountIdentity(account);
});

function handleCodex(message: any) {
  sideChats.notify(message);
  void scheduler.notification(message).catch(()=>{});
  void deliveryQueue.notification(message).catch(()=>{});
  if (message.id !== undefined && message.method) {
    const pending = serverRequests.add(message);
    broadcast({ type: "codex/request", payload: pending });
    return;
  }
  if (message.method) {
    if (message.method === "serverRequest/resolved") serverRequests.remove(message.params?.requestId);
    if (message.method === "account/updated") accountLoader.invalidate();
    if (message.method === "turn/diff/updated") reviewDiffs.record(message.params || {});
    if (message.method === "item/fileChange/patchUpdated") recordFileChangeDiff(message.params || {});
    if (message.method === "item/completed" && message.params?.item?.type === "fileChange") {
      recordFileChangeDiff({ ...message.params, changes: message.params.item.changes });
    }
    if (message.method === "turn/completed") notifyNtfyTurnCompleted(message.params || {});
    broadcast({ type: "codex/notification", payload: message });
  }
}

async function notifyNtfyTurnCompleted(params: any) {
  if (!ntfyTopic) return;
  const turnId = typeof params?.turn?.id === "string" ? params.turn.id : "";
  const threadId = typeof params?.threadId === "string" ? params.threadId : "";
  const body = `Codex task completed${threadId ? ` (thread ${threadId.slice(0, 8)})` : ""}`;
  try {
    await fetch(`${ntfyUrl}/${encodeURIComponent(ntfyTopic)}`, {
      method: "POST",
      headers: { Title: "Codex task completed", Tags: "white_check_mark", ...(turnId ? { "X-Turn-Id": turnId } : {}) },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error("ntfy notification failed:", error instanceof Error ? error.message : error);
  }
}

function recordFileChangeDiff({ threadId, turnId, changes }: any) {
  const diff = unifiedDiffFromFileChanges(Array.isArray(changes) ? changes : []);
  if (diff) reviewDiffs.record({ threadId, turnId, diff });
}

function recordReviewDiffsFromRpc(method: string, params: any, result: any) {
  if (!["thread/read", "thread/resume", "thread/turns/list"].includes(method)) return;
  const threadId = result?.thread?.id || params?.threadId;
  const turns = result?.thread?.turns || result?.data || [];
  if (typeof threadId !== "string" || !Array.isArray(turns)) return;
  for (const turn of turns) {
    const changes = (turn?.items || []).flatMap((item: any) => item?.type === "fileChange" && Array.isArray(item.changes) ? item.changes : []);
    const diff = unifiedDiffFromFileChanges(changes);
    if (typeof turn?.id === "string" && diff) reviewDiffs.record({ threadId, turnId: turn.id, diff });
  }
}

function recordThreadPathsFromRpc(result: any) {
  const threads = [result?.thread, ...(Array.isArray(result?.data) ? result.data : [])].filter(Boolean);
  for (const thread of threads) {
    if (typeof thread?.id === "string" && typeof thread?.path === "string") threadPaths.set(thread.id, thread.path);
  }
}

async function readLiveThread(threadId: unknown) {
  if (typeof threadId !== "string" || !threadId) throw new Error("Invalid thread id");
  let path = threadPaths.get(threadId);
  if (!path) {
    const result = await request("thread/read", { threadId, includeTurns: false });
    recordThreadPathsFromRpc(result);
    path = threadPaths.get(threadId);
  }
  if (!path) return { active: false, turn: null, lastEventAt: null };
  const child = relative(codexSessionsRoot, resolve(path));
  const safePath = child && !child.startsWith("..") ? resolveSafeRegularFile(codexSessionsRoot, child) : null;
  if (!safePath) throw new Error("Thread rollout is outside the Codex sessions directory");
  return liveSessions.read(safePath);
}

function broadcast(data: any) {
  const text = JSON.stringify(data);
  for (const client of clients) if (client.readyState === WebSocket.OPEN && leases.get(client)?.valid() !== false) client.send(text);
  for (const client of sseClients) if (!client.writableEnded && leases.get(client)?.valid() !== false) client.write(`data: ${text}\n\n`);
}

async function dispatchBrowserMessage(message: any) {
  const id = message?.id;
  if (message?.type === "rpc") {
    try {
      if (!isAllowedBrowserRpcMethod(message.method)) throw new Error("RPC method is not available to browser clients");
      const params = message.params || {};
      let result;
      if (message.method === 'host/requests/list') result = { data: serverRequests.list() };
      else if (message.method === 'host/thread/live') result = await readLiveThread(params.threadId);
      else if (message.method === 'host/delivery/list') result = await deliveryQueue.list(params.threadId);
      else if (message.method === 'host/delivery/mutate') {
        if (params.action === 'enqueue') {
          const entry = params.payload;
          const ids = new Set<string>((entry?.mentions || []).filter((mention: any) => mention.source === 'attachment').map((mention: any) => mention.id));
          for (const input of entry?.params?.input || []) {
            if (input.type !== 'localImage' || typeof input.path !== 'string') continue;
            const child = relative(join(privateCodexRoot, 'remote-web-attachments'), resolve(input.path));
            if (!child.startsWith('..') && child.split('/').length === 2) ids.add(child.split('/')[0]);
          }
          if (ids.size) {
            const cwd = entry.params?.cwd || (await request('thread/read', { threadId: entry.threadId, includeTurns: false })).thread?.cwd;
            // Binding is serialized with cleanup before queue persistence. The
            // permanent thread link protects the upload even across gateways.
            await queueAttachments.resolveInput({ ids: [...ids], cwd, threadId: entry.threadId, bind: true });
          }
        }
        result = await deliveryQueue.mutate(params.action, params.payload);
      }
      else if (message.method === 'host/submissions/get') result = await submissions.get(params.id);
      else if (message.method === 'host/submissions/list') result = { data: (await submissions.list({ threadId: params.threadId })).filter((receipt: any) => ['prepared', 'dispatching', 'unknown'].includes(receipt.status)) };
      else if (message.method === 'host/submissions/reconcile') result = await submissions.reconcile(params.id);
      else if (['turn/start', 'turn/steer'].includes(message.method) && !sideChats.owns(params.threadId)) {
        const receipt = await submissions.submit({ id: params.clientUserMessageId || randomUUID(), method: message.method, params });
        result = submissionResult(receipt);
      } else result = message.method === 'turn/start' ? await sideChats.startTurn(params, () => request(message.method, params)) : await request(message.method, params);
      recordThreadPathsFromRpc(result);
      recordReviewDiffsFromRpc(message.method, params, result);
      return { type: "rpc/result", id, result };
    } catch (error) {
      return rpcErrorPayload(id, error);
    }
  }
  if (message?.type === "codex/response" || message?.type === "codex/error") {
    const params = serverRequests.respond(message.requestId, message.result, message.type === "codex/error" ? message.error : null, sendRaw, message.requestEpoch);
    broadcast({ type: "codex/notification", payload: { method: "serverRequest/resolved", params } });
    return { type: "ack" };
  }
  if (message?.type === "ping") return { type: "pong" };
  throw new Error("Unsupported browser bridge message");
}

async function handleClient(client: WebSocket, message: any) {
  try { const result = await dispatchBrowserMessage(message); if (client.readyState === WebSocket.OPEN && leases.get(client)?.valid() !== false) client.send(JSON.stringify(result)); }
  catch (error) { if (client.readyState === WebSocket.OPEN && leases.get(client)?.valid() !== false) client.send(JSON.stringify(rpcErrorPayload(message?.id, error))); }
}



const workspaceContext = { request, scheduler, sideChats, submissions, deliveryQueue, developerTools, appRoot, publicDir, authConfig, localAuth, accessAuth, managedPasswordPath, defaultCwd, browseRoots, homeDir, imageRoots, fileRoots, privateCodexRoot, reviewRoots, capabilities, projectless, dispatchBrowserMessage, reviewDiffs, accountLoader, sseClients, leases, clients, terminalSessions, handleClient, isConnected: () => connected };
const gatewayHandler = createHttpHandler(workspaceContext);
const quick = new QuickTunnel({ workspace: options => openQuickOrigin({ ...options, context:workspaceContext }) });
const setupHandler = createSetupHandler({ quick, probeToken: process.env.CODEX_WEBUI_SETUP_PROBE, readiness: () => ({ mode: authConfig.mode, publicOrigin: authConfig.publicOrigin, audience: authConfig.audience, allowedEmail: authConfig.allowedEmail }) });
const server = createServer(async (req, res) => {
  if (!await setupHandler.handle(req, res)) await gatewayHandler(req, res);
});

const transports = attachTransports({ server, accessAuth, localAuth, capabilities, clients, sseClients, leases, terminalSessions, browseRoots, defaultCwd, handleClient, isConnected: () => connected });

if (import.meta.dir !== resolve(appRoot, 'dist')) {
  const frontendBuild = await Bun.build({ entrypoints: [resolve(publicDir, 'app.js')], outdir: publicDir, naming: 'app.bundle.js', target: 'browser', minify: false });
  if (!frontendBuild.success) throw new Error(`Frontend build failed: ${frontendBuild.logs.join('\n')}`);
  const setupBuild = await Bun.build({ entrypoints: [resolve(publicDir, 'setup.js')], outdir: publicDir, naming: 'setup.bundle.js', target: 'browser' });
  if (!setupBuild.success) throw new Error('Setup frontend build failed');
} else if (!existsSync(resolve(publicDir, 'app.bundle.js'))) throw new Error('Missing production frontend bundle; run bun run build');

await submissions.recover();
bridge.start();
server.listen(port, host, () => {
  console.log(`Codex Remote Web listening on http://${host}:${port}`);
  if (localAuth?.setupRequired()) console.warn(`[codex-webui] LAN password setup is required; the first LAN visitor will create it in ${managedPasswordPath}`);
  if (!localhostOnly) {
    const addresses = Object.values(networkInterfaces()).flat().filter((entry): entry is NonNullable<typeof entry> => !!entry && entry.family === "IPv4" && !entry.internal);
    for (const entry of addresses) console.log(`LAN: http://${entry.address}:${port} (authentication required)`);
  }
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; connected = false;

  for (const client of clients) client.terminate(); clients.clear();
  for (const client of sseClients) client.end(); sseClients.clear();
  for (const [client, terminal] of terminalSessions) { terminal.kill(); client.terminate(); } terminalSessions.clear();
  transports.close(); const setupClosed = setupHandler.close();
  server.close(); server.closeAllConnections?.();
  void Promise.allSettled([scheduler.stop(), deliveryQueue.stop(), submissions.close(), sideChats.stop(), bridge.stop(), setupClosed]).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
