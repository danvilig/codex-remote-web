package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type requestAuthKey struct{}

func workspaceMutationAllowed(r *http.Request) bool {
	return typedMutationAllowed(r, "application/json")
}

func typedMutationAllowed(r *http.Request, contentType string) bool {
	a, _ := r.Context().Value(requestAuthKey{}).(authResult)
	actual, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return a.ok && a.origin != "" && r.Header.Get("Origin") == a.origin && r.Header.Get("X-Workspace-Request") == "1" && r.Header.Get("Sec-Fetch-Site") != "cross-site" && err == nil && actual == contentType
}

type eventsHub struct {
	mu      sync.Mutex
	next    uint64
	clients map[uint64]chan []byte
}

func (h *eventsHub) subscribe() (<-chan []byte, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.clients == nil {
		h.clients = make(map[uint64]chan []byte)
	}
	h.next++
	id := h.next
	ch := make(chan []byte, 64)
	h.clients[id] = ch
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.clients[id] != nil {
			delete(h.clients, id)
			close(ch)
		}
	}
}

func (h *eventsHub) publish(payload any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, ch := range h.clients {
		select {
		case ch <- raw:
		default:
			delete(h.clients, id)
			close(ch)
		}
	}
}

type gatewayApp struct {
	bridge          *bridge
	root            *os.Root
	local           *localAuthenticator
	access          *accessAuthenticator
	setup           *setupHTTP
	version         string
	config          map[string]any
	dispatch        func(context.Context, browserRequest) any
	terminalDir     func(string) string
	activeTerminals atomic.Int64
	terminalGate    sync.RWMutex
	events          eventsHub
	mux             *http.ServeMux
}

func (a *gatewayApp) status() map[string]string {
	status := "connecting"
	if a.bridge.current() != nil {
		status = "connected"
	}
	return map[string]string{"type": "bridge/status", "status": status}
}

func (a *gatewayApp) registerCore() {
	m := a.mux
	m.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		jsonReply(w, 200, map[string]any{"ok": true, "codex": a.bridge.current() != nil, "name": "codex-remote-web", "version": a.version, "runtime": "native-go"})
	})
	m.HandleFunc("GET /api/config", func(w http.ResponseWriter, _ *http.Request) { jsonReply(w, 200, a.config) })
	m.HandleFunc("POST /api/rpc", func(w http.ResponseWriter, r *http.Request) {
		var message browserRequest
		if decodeOne(http.MaxBytesReader(w, r.Body, 256_000), &message) != nil {
			jsonReply(w, 400, map[string]string{"error": "Invalid RPC request"})
			return
		}
		message.Type = "rpc"
		jsonReply(w, 200, a.dispatch(r.Context(), message))
	})
	m.HandleFunc("POST /api/codex/respond", func(w http.ResponseWriter, r *http.Request) {
		var message browserRequest
		if decodeOne(http.MaxBytesReader(w, r.Body, maxBrowserMessage), &message) != nil {
			jsonReply(w, 400, map[string]string{"error": "Invalid Codex response"})
			return
		}
		message.Type = "codex/response"
		if len(message.Error) != 0 && string(message.Error) != "null" {
			message.Type = "codex/error"
		}
		result := a.dispatch(r.Context(), message)
		if response, ok := result.(browserResponse); ok && response.Type == "rpc/error" {
			status := http.StatusBadRequest
			if response.Code == "REQUEST_STALE" || response.Code == "REQUEST_NOT_PENDING" {
				status = http.StatusConflict
			}
			jsonReply(w, status, response)
			return
		}
		jsonReply(w, 200, result)
	})
	m.HandleFunc("GET /api/events", a.serveEvents)
	m.HandleFunc("GET /ws", a.serveSocket)
	m.HandleFunc("GET /terminal", func(w http.ResponseWriter, r *http.Request) {
		if a.terminalDir == nil {
			jsonReply(w, 403, map[string]string{"error": "Terminal is disabled"})
			return
		}
		a.terminalGate.RLock()
		defer a.terminalGate.RUnlock()
		a.activeTerminals.Add(1)
		defer a.activeTerminals.Add(-1)
		serveTerminal(w, r, a.terminalDir(r.URL.Query().Get("cwd")))
	})
	m.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.NotFound(w, r)
			return
		}
		a.asset(w, r, false)
	})
}

var publicFiles = map[string]bool{"/index.html": true, "/style.css": true, "/workspace.css": true, "/remote-access.css": true, "/favicon.svg": true, "/auth-bootstrap.js": true, "/access-session.js": true, "/i18n.js": true, "/codex-brand.js": true, "/app.bundle.js": false}

func (a *gatewayApp) asset(w http.ResponseWriter, r *http.Request, loginOnly bool) {
	path := r.URL.Path
	if path == "/" || settingsPage.MatchString(path) {
		path = "/index.html"
	}
	login, allowed := publicFiles[path]
	file := "public" + path
	for prefix, dir := range map[string]string{"/vendor/katex/": "node_modules/katex/dist/", "/vendor/xterm/": "node_modules/@xterm/xterm/css/"} {
		if !strings.HasPrefix(path, prefix) {
			continue
		}
		rel := strings.TrimPrefix(path, prefix)
		if (prefix == "/vendor/xterm/" && rel == "xterm.css") || (prefix == "/vendor/katex/" && (rel == "katex.min.css" || (strings.HasPrefix(rel, "fonts/") && (strings.HasSuffix(rel, ".woff2") || strings.HasSuffix(rel, ".woff") || strings.HasSuffix(rel, ".ttf"))))) {
			file, allowed = dir+rel, true
		}
	}
	if !allowed || (loginOnly && !login) || a.root == nil || !fs.ValidPath(file) || strings.Contains(file, "\\") {
		http.NotFound(w, r)
		return
	}
	info, err := a.root.Lstat(file)
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	f, err := a.root.Open(file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	if strings.HasPrefix(path, "/vendor/") {
		w.Header().Set("Cache-Control", "public, max-age=86400")
	}
	if typ := mime.TypeByExtension(filepath.Ext(file)); typ != "" {
		w.Header().Set("Content-Type", typ)
	}
	http.ServeContent(w, r, filepath.Base(file), info.ModTime(), f)
}

func (a *gatewayApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if a.setup != nil && a.setup.handle(w, r) {
		return
	}
	mode, published, authenticator := "local", "", a.local.authenticate
	if a.access != nil {
		mode, published, authenticator = "cloudflare-access", a.access.origin, a.access.authenticate
	}
	a.serveAuthenticated(w, r, mode, published, authenticator)
}

// Only a separate listener owned by the protected connector uses this handler.
func (a *gatewayApp) quickHandler(origin func() string, email, privateHost string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		published := origin()
		u, valid := exactHTTPSOrigin(published)
		if !valid || strings.HasPrefix(r.URL.Path, "/api/setup") || strings.HasPrefix(r.URL.Path, "/setup") {
			http.NotFound(w, r)
			return
		}
		if privateHost != "" {
			if !equalSecret(r.Host, privateHost) || !peerLoopback(r) {
				http.NotFound(w, r)
				return
			}
			r.Host = u.Host
		}
		a.serveAuthenticated(w, r, "quick-tunnel", published, func(r *http.Request) authResult {
			if !remoteOriginAllowed(r, u.Host, published) {
				return authResult{status: 403, code: "AUTH_FORBIDDEN"}
			}
			return authResult{ok: true, origin: published, email: email, expires: time.Now().Add(24 * time.Hour)}
		})
	})
}

func (a *gatewayApp) serveAuthenticated(w http.ResponseWriter, r *http.Request, mode, published string, authenticate func(*http.Request) authResult) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
	w.Header().Set("Cache-Control", "no-store")
	if strings.HasPrefix(r.URL.Path, "/api/auth/") {
		if mode == "local" && (r.URL.Path == "/api/auth/status" || r.URL.Path == "/api/auth/setup" || r.URL.Path == "/api/auth/login") {
			a.local.http(w, r)
			return
		}
		if mode != "local" && r.URL.Path == "/api/auth/status" {
			auth := authenticate(r)
			var identity, expires any
			if auth.email != "" {
				identity = map[string]string{"email": auth.email}
			}
			if !auth.expires.IsZero() && mode != "quick-tunnel" {
				expires = auth.expires.UnixMilli()
			}
			out := map[string]any{"mode": mode, "authenticated": auth.ok, "passwordRequired": false, "setupRequired": false, "expiresAt": expires, "identity": identity, "loginUrl": published + "/"}
			if mode == "quick-tunnel" {
				out["temporary"] = true
				out["transports"] = map[string]bool{"websocket": true, "sse": false}
			}
			status := 200
			if !auth.ok {
				status = auth.status
				out["code"] = auth.code
			}
			jsonReply(w, status, out)
			return
		}
		http.NotFound(w, r)
		return
	}
	auth := authenticate(r)
	if !auth.ok {
		path := r.URL.Path
		if mode == "local" && (r.Method == "GET" || r.Method == "HEAD") && (path == "/" || publicFiles[path] || settingsPage.MatchString(path)) {
			a.asset(w, r, true)
			return
		}
		if mode == "local" && auth.status == 401 {
			w.Header().Set("WWW-Authenticate", `Basic realm="Codex WebUI", charset="UTF-8"`)
		}
		jsonReply(w, auth.status, map[string]string{"error": "Authentication required", "code": auth.code})
		return
	}
	if mode == "quick-tunnel" && r.URL.Path == "/api/events" {
		jsonReply(w, 409, map[string]string{"error": "Temporary access requires WebSocket. SSE is unavailable.", "code": "TRANSPORT_UNAVAILABLE"})
		return
	}
	// Mutating routes use the origin verified by the authenticator.
	r = r.WithContext(context.WithValue(r.Context(), requestAuthKey{}, auth))
	a.mux.ServeHTTP(w, r)
}

func authenticatedUpgrade(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	u := websocket.Upgrader{HandshakeTimeout: 5 * time.Second, CheckOrigin: func(req *http.Request) bool {
		a, _ := req.Context().Value(requestAuthKey{}).(authResult)
		return a.ok && sameOrigin(req, a.origin)
	}}
	return u.Upgrade(w, r, nil)
}

func lease(ctx context.Context) (<-chan time.Time, func(), string) {
	a, _ := ctx.Value(requestAuthKey{}).(authResult)
	if a.expires.IsZero() {
		return nil, func() {}, ""
	}
	delay, code := time.Until(a.expires), "AUTH_EXPIRED"
	if delay > 5*time.Minute {
		delay, code = 5*time.Minute, "AUTH_REFRESH"
	}
	t := time.NewTimer(delay)
	return t.C, func() { t.Stop() }, code
}

func leaseEvent(code string) map[string]string {
	typ := "auth/required"
	if code == "AUTH_REFRESH" {
		typ = "bridge/reconnect"
	}
	return map[string]string{"type": typ, "code": code}
}

func closeForLease(ws *websocket.Conn, code string) {
	status := 4001
	if code == "AUTH_REFRESH" {
		status = 4000
	}
	_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(status, code), time.Now().Add(writeTimeout))
}

func (a *gatewayApp) serveSocket(w http.ResponseWriter, r *http.Request) {
	ws, err := authenticatedUpgrade(w, r)
	if err != nil {
		return
	}
	defer ws.Close()
	ws.SetReadLimit(2<<20 + 4096)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	updates, unsubscribe := a.events.subscribe()
	defer unsubscribe()
	due, stop, code := lease(ctx)
	defer stop()
	requests := make(chan browserRequest, 8)
	replies := make(chan any, 8)
	go func() {
		defer cancel()
		for {
			var req browserRequest
			if ws.ReadJSON(&req) != nil {
				return
			}
			select {
			case requests <- req:
			case <-ctx.Done():
				return
			default:
				return
			}
		}
	}()
	// Limit in-flight work per connection and leave the writer free for events.
	for range 4 {
		go func() {
			dispatchCtx, release := cancellableLeaseContext(ctx)
			defer release()
			for {
				select {
				case <-dispatchCtx.Done():
					return
				case req := <-requests:
					if dispatchCtx.Err() != nil {
						return
					}
					response := a.dispatch(dispatchCtx, req)
					select {
					case replies <- response:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}
	write := func(value any) bool {
		return ws.SetWriteDeadline(time.Now().Add(writeTimeout)) == nil && ws.WriteJSON(value) == nil
	}
	if !write(a.status()) {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-due:
			_ = write(leaseEvent(code))
			closeForLease(ws, code)
			return
		case raw, ok := <-updates:
			if !ok || ws.SetWriteDeadline(time.Now().Add(writeTimeout)) != nil || ws.WriteMessage(websocket.TextMessage, raw) != nil {
				return
			}
		case response := <-replies:
			if !write(response) {
				return
			}
		}
	}
}

func cancellableLeaseContext(parent context.Context) (context.Context, context.CancelFunc) {
	a, _ := parent.Value(requestAuthKey{}).(authResult)
	if a.expires.IsZero() {
		return context.WithCancel(parent)
	}
	deadline := time.Now().Add(5 * time.Minute)
	if a.expires.Before(deadline) {
		deadline = a.expires
	}
	return context.WithDeadline(parent, deadline)
}

func (a *gatewayApp) serveEvents(w http.ResponseWriter, r *http.Request) {
	updates, unsubscribe := a.events.subscribe()
	defer unsubscribe()
	due, stop, code := lease(r.Context())
	defer stop()
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	control := http.NewResponseController(w)
	write := func(data string) bool {
		_ = control.SetWriteDeadline(time.Now().Add(writeTimeout))
		_, err := io.WriteString(w, data)
		return err == nil && control.Flush() == nil
	}
	initial, _ := json.Marshal(a.status())
	if !write(fmt.Sprintf("retry: 1000\n\ndata: %s\n\n", initial)) {
		return
	}
	tick := time.NewTicker(25 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-due:
			raw, _ := json.Marshal(leaseEvent(code))
			_ = write("data: " + string(raw) + "\n\n")
			return
		case <-tick.C:
			if !write(": keepalive\n\n") {
				return
			}
		case raw, ok := <-updates:
			if !ok || !write("data: "+string(raw)+"\n\n") {
				return
			}
		}
	}
}
