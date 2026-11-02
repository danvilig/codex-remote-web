import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { createConnectionLease } from './lease.js';
import { createTerminalSession, resolveTerminalCwd, normalizeTerminalResize } from '../terminal/service.js';
export function attachTransports(context: any) {
  const { server, accessAuth, localAuth, capabilities, clients, sseClients, leases, terminalSessions, browseRoots, defaultCwd, handleClient, isConnected } = context;
const sseKeepalive = setInterval(() => {
  for (const client of sseClients) if (!client.writableEnded && leases.get(client)?.valid() !== false) client.write(": keepalive\n\n");
}, 25_000);
sseKeepalive.unref();

const wss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });
server.on("upgrade", async (req, socket, head) => {
  let pathname = "";
  try { pathname = new URL(req.url || "/", "http://localhost").pathname; }
  catch { socket.destroy(); return; }
  const auth = accessAuth ? await accessAuth(req) : { ok: localAuth!.authorized(req), principal: null, status: 401, code: 'AUTH_REQUIRED' };
  if (socket.destroyed) return;
  if ((pathname !== "/ws" && pathname !== "/terminal") || !auth.ok) {
    const body = JSON.stringify({ error: "Authentication required", code: auth.code || 'AUTH_REQUIRED' });
    socket.end([
      `HTTP/1.1 ${auth.status === 403 ? "403 Forbidden" : "401 Unauthorized"}`,
      "Connection: close",
      ...(accessAuth ? [] : ['WWW-Authenticate: Basic realm="Codex WebUI", charset="UTF-8"']),
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "X-Content-Type-Options: nosniff",
      "",
      body,
    ].join("\r\n"));
    return;
  }
  (req as any).accessPrincipal = auth.principal;
  const target = pathname === "/terminal" ? terminalWss : wss;
  if (pathname === "/terminal" && !capabilities.terminal) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  target.handleUpgrade(req, socket, head, client => target.emit("connection", client, req));
});
function websocketLease(client: WebSocket, req: IncomingMessage, sendEvents = true) {
  const lease = createConnectionLease((req as any).accessPrincipal, code => {
    if (sendEvents && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: code === 'AUTH_REFRESH' ? 'bridge/reconnect' : 'auth/required', code }));
    client.close(code === 'AUTH_REFRESH' ? 4000 : 4001, code);
    const timer = setTimeout(() => client.terminate(), 1000); timer.unref();
  });
  leases.set(client, lease); client.once('close', () => lease.dispose()); return lease;
}
wss.on("connection", (client, req) => {
  const lease = websocketLease(client, req);
  clients.add(client);
  client.send(JSON.stringify({ type: "bridge/status", status: isConnected() ? "connected" : "connecting" }));
  client.on("message", (raw) => {
    if (!lease.valid()) return;
    try { handleClient(client, JSON.parse(String(raw))); }
    catch (error) { client.send(JSON.stringify({ type: "rpc/error", error: String(error) })); }
  });
  client.on("close", () => clients.delete(client));
});
terminalWss.on("connection", (client, req) => {
  const lease = websocketLease(client, req, false);
  let terminal: ReturnType<typeof createTerminalSession> | null = null;
  try {
    const url = new URL(req.url || "/terminal", "http://localhost");
    const cwd = resolveTerminalCwd(url.searchParams.get("cwd"), browseRoots, defaultCwd);
    terminal = createTerminalSession({
      cwd,
      cols: 100,
      rows: 24,
      onData: data => { if (client.readyState === WebSocket.OPEN && lease.valid()) client.send(data); },
      onExit: event => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(`\r\n[Process exited ${event.exitCode}]\r\n`);
          client.close(1000, "Terminal exited");
        }
      },
    });
    terminalSessions.set(client, terminal);
  } catch (error) {
    console.error("[codex-webui] terminal failed", error);
    client.close(1011, "Terminal unavailable");
    return;
  }
  client.on("message", (raw, isBinary) => {
    if (!lease.valid() || !terminal || raw.byteLength > 1_000_000) return;
    if (isBinary) {
      terminal.write(Buffer.from(raw as Buffer).toString("utf8"));
      return;
    }
    try {
      const resize = normalizeTerminalResize(JSON.parse(String(raw)));
      if (resize) terminal.resize(resize.cols, resize.rows);
    } catch { /* Terminal input is sent as binary; ignore malformed control frames. */ }
  });
  client.on("close", () => {
    terminalSessions.delete(client);
    terminal?.kill();
    terminal = null;
  });
  client.on("error", () => client.close());
});

return { close({ terminate = false } = {}) {
  clearInterval(sseKeepalive);
  if (terminate) for (const client of [...wss.clients, ...terminalWss.clients]) {
    leases.get(client)?.dispose(); terminalSessions.get(client)?.kill(); terminalSessions.delete(client); clients.delete(client); client.terminate();
  }
  wss.close(); terminalWss.close();
} };
}
