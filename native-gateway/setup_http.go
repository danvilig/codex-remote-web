package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

var setupAssets = map[string]string{"/setup": "public/setup.html", "/setup.bundle.js": "public/setup.bundle.js", "/setup-assets/style.css": "public/style.css", "/setup-assets/workspace.css": "public/workspace.css", "/setup-assets/remote-access.css": "public/remote-access.css", "/setup-assets/favicon.svg": "public/favicon.svg"}

type setupHTTP struct {
	mu                     sync.Mutex
	root                   *os.Root
	access                 *accessAuthenticator
	quick                  *quickTunnel
	desktop                bool
	standalone             bool
	managed                *desktopAgent
	key, id, csrf          string
	keyUntil, sessionUntil time.Time
}

func localSetupAllowed(r *http.Request, mutation bool) bool {
	site := r.Header.Get("Sec-Fetch-Site")
	origin := requestOrigin(r)
	if !directLoopback(r) || (site != "" && site != "same-origin" && site != "none") || !sameOrigin(r, origin) {
		return false
	}
	if !mutation {
		return true
	}
	typ, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && typ == "application/json" && r.Header.Get("Origin") == origin && r.Header.Get("X-Setup-Request") == "1"
}

func (s *setupHTTP) issue() string {
	s.key, s.keyUntil = randomSecret(32), time.Now().Add(5*time.Minute)
	return s.key
}

func setupError(w http.ResponseWriter, status int, message string) {
	jsonReply(w, status, map[string]string{"error": message})
}

func (s *setupHTTP) handle(w http.ResponseWriter, r *http.Request) bool {
	path := r.URL.Path
	if s.standalone && path == "/" {
		path = "/setup"
	}
	asset := setupAssets[path]
	if !strings.HasPrefix(path, "/api/setup/") && asset == "" {
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	if !localSetupAllowed(r, r.Method != "GET") {
		jsonReply(w, 403, map[string]string{"error": "Open setup on this machine using its loopback address.", "code": "SETUP_LOCAL_ONLY"})
		return true
	}
	if asset != "" {
		if r.Method != "GET" {
			setupError(w, 405, "Method not allowed")
			return true
		}
		file, err := s.root.Open(asset)
		if err != nil {
			setupError(w, 503, "Setup assets are missing. Run the production build.")
			return true
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return true
		}
		http.ServeContent(w, r, filepath.Base(asset), info.ModTime(), file)
		return true
	}
	if path == "/api/setup/ready" {
		secret := os.Getenv("CODEX_WEBUI_SETUP_PROBE")
		if r.Method != "GET" || s.access == nil || secret == "" || !equalSecret(r.Header.Get("X-Setup-Probe"), secret) {
			setupError(w, 403, "Setup readiness is not authorized.")
			return true
		}
		jsonReply(w, 200, map[string]string{"mode": "cloudflare-access", "publicOrigin": s.access.origin, "audience": s.access.audience, "allowedEmail": s.access.email})
		return true
	}
	if s.desktop {
		capability := os.Getenv("CODEX_WEBUI_DESKTOP_SETUP_CAPABILITY")
		if s.access == nil && capability != "" && equalSecret(capability, r.Header.Get("X-Desktop-Setup-Capability")) && s.quickHTTP(w, r, path) {
			return true
		}
		setupError(w, 409, "Manage remote access in the desktop app.")
		return true
	}
	if r.Method != "POST" && r.Method != "GET" {
		setupError(w, 405, "Method not allowed")
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if s.id != "" && !now.Before(s.sessionUntil) {
		s.id, s.csrf = "", ""
	}
	if r.Method == "POST" && path == "/api/setup/launch" {
		jsonReply(w, 200, map[string]string{"key": s.issue()})
		return true
	}
	if path == "/api/setup/session" && r.Method == "POST" {
		var body struct {
			Key string `json:"key"`
		}
		if decodeOne(http.MaxBytesReader(w, r.Body, 2048), &body) != nil {
			setupError(w, 400, "Invalid setup request")
			return true
		}
		if s.key == "" || !now.Before(s.keyUntil) || !equalSecret(s.key, body.Key) {
			setupError(w, 403, "The setup link expired or was already used. Open a new setup link.")
			return true
		}
		s.key, s.id, s.csrf, s.sessionUntil = "", randomSecret(32), randomSecret(32), now.Add(30*time.Minute)
		http.SetCookie(w, &http.Cookie{Name: "crw_setup_session", Value: s.id, HttpOnly: true, SameSite: http.SameSiteStrictMode, Path: "/api/setup", MaxAge: 1800})
		jsonReply(w, 200, map[string]string{"csrf": s.csrf})
		return true
	}
	if path == "/api/setup/session" && s.id == "" {
		jsonReply(w, 200, map[string]bool{"unlocked": false})
		return true
	}
	cookie, err := r.Cookie("crw_setup_session")
	if err != nil || s.id == "" || !equalSecret(cookie.Value, s.id) {
		setupError(w, 401, "Unlock setup on this machine to continue.")
		return true
	}
	if path == "/api/setup/session" {
		jsonReply(w, 200, map[string]any{"unlocked": true, "csrf": s.csrf})
		return true
	}
	if !equalSecret(s.csrf, r.Header.Get("X-Setup-Csrf")) {
		setupError(w, 403, "Setup authorization is missing. Reopen setup.")
		return true
	}
	s.sessionUntil = now.Add(30 * time.Minute)
	if path == "/api/setup/lock" && r.Method == "POST" {
		if s.managed != nil {
			if s.managed.setupBusy() {
				setupError(w, 409, "A setup operation is already running.")
				return true
			}
			_ = s.managed.cloudLock(false)
		}
		s.id, s.csrf = "", ""
		http.SetCookie(w, &http.Cookie{Name: "crw_setup_session", HttpOnly: true, SameSite: http.SameSiteStrictMode, Path: "/api/setup", MaxAge: -1})
		jsonReply(w, 200, map[string]bool{"locked": true})
		return true
	}
	var body json.RawMessage
	if r.Method == "POST" && decodeOne(http.MaxBytesReader(w, r.Body, 8192), &body) != nil {
		setupError(w, 400, "Invalid setup request")
		return true
	}
	if s.managed != nil && s.handleManaged(w, r, path, body) {
		return true
	}
	switch {
	case path == "/api/setup/quick/status" && r.Method == "GET":
		jsonReply(w, 200, s.quick.status())
	case path == "/api/setup/quick/start" && r.Method == "POST":
		var input struct {
			Email string `json:"email"`
		}
		if json.Unmarshal(body, &input) != nil {
			setupError(w, 400, "Invalid email")
			return true
		}
		status, err := s.quick.start(input.Email)
		if err != nil {
			setupError(w, status, err.Error())
			return true
		}
		jsonReply(w, status, s.quick.status())
	case path == "/api/setup/quick/stop" && r.Method == "POST":
		s.quick.stop()
		jsonReply(w, 202, s.quick.status())
	case path == "/api/setup/status" && r.Method == "GET":
		jsonReply(w, 200, map[string]any{"connected": false, "phase": "idle", "managedAvailable": false})
	case path == "/api/setup/resources", path == "/api/setup/connect", path == "/api/setup/preview",
		path == "/api/setup/apply", path == "/api/setup/remove", path == "/api/setup/doctor",
		strings.HasPrefix(path, "/api/setup/change/"), strings.HasPrefix(path, "/api/setup/credential/"):
		setupError(w, 409, "Manage remote access in the desktop app.")
	default:
		setupError(w, 404, "Unknown setup endpoint")
	}
	return true
}

func (s *setupHTTP) handleManaged(w http.ResponseWriter, r *http.Request, path string, body json.RawMessage) bool {
	action := strings.TrimPrefix(path, "/api/setup/")
	method, status := http.MethodPost, http.StatusOK
	switch action {
	case "status", "resources":
		method = http.MethodGet
	case "connect", "preview", "change/preview", "doctor", "credential/forget", "credential/retry":
	case "apply", "remove", "change/recover", "migrate":
		status = http.StatusAccepted
		if !s.standalone && (action == "migrate" || s.access != nil) {
			setupError(w, 409, "Open the standalone setup command to restart or replace the managed service.")
			return true
		}
	default:
		return false
	}
	if r.Method != method {
		setupError(w, 405, "Method not allowed")
		return true
	}
	requestPath := action
	if r.URL.RawQuery != "" {
		requestPath += "?" + r.URL.RawQuery
	}
	request, _ := json.Marshal(map[string]any{"path": requestPath, "body": body})
	result, err := s.managed.setupRequest(r.Context(), request)
	if err != nil {
		failure := desktopSafeError(err)
		jsonReply(w, failure.Status, failure)
		return true
	}
	if action == "status" {
		out := result.(map[string]any)
		out["standaloneMaintenance"] = s.standalone
	}
	jsonReply(w, status, result)
	return true
}

func (s *setupHTTP) quickHTTP(w http.ResponseWriter, r *http.Request, path string) bool {
	switch {
	case path == "/api/setup/quick/status" && r.Method == "GET":
		jsonReply(w, 200, s.quick.status())
		return true
	case path == "/api/setup/quick/start" && r.Method == "POST":
		var input struct {
			Email string `json:"email"`
		}
		if decodeOne(http.MaxBytesReader(w, r.Body, 8192), &input) != nil {
			setupError(w, 400, "Invalid email")
			return true
		}
		status, err := s.quick.start(input.Email)
		if err != nil {
			setupError(w, status, err.Error())
			return true
		}
		jsonReply(w, status, s.quick.status())
		return true
	case path == "/api/setup/quick/stop" && r.Method == "POST":
		s.quick.stop()
		jsonReply(w, 202, s.quick.status())
		return true
	}
	return false
}

func (a *gatewayApp) remoteStatus(home string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, _ := r.Context().Value(requestAuthKey{}).(authResult)
		desktop := a.setup.desktop
		out := map[string]any{"configured": false, "canManage": !desktop && localSetupAllowed(r, false)}
		if desktop {
			out["management"] = "desktop"
		}
		var identity any
		if auth.email != "" {
			identity = map[string]string{"email": auth.email}
		}
		if a.access != nil {
			out["configured"], out["active"], out["mode"], out["publicOrigin"] = true, true, "cloudflare-access", a.access.origin
			out["allowedEmail"], out["teamDomain"], out["identity"], out["expiresAt"] = a.access.email, strings.TrimPrefix(a.access.issuer, "https://"), identity, nil
			if !auth.expires.IsZero() {
				out["expiresAt"] = auth.expires.UnixMilli()
			}
		} else if auth.email != "" && auth.origin != "" {
			out["configured"], out["active"], out["mode"], out["publicOrigin"], out["allowedEmail"], out["identity"], out["expiresAt"] = true, true, "quick-tunnel", auth.origin, auth.email, identity, nil
		} else {
			dir := filepath.Join(home, ".config", "codex-remote-web")
			if desktop {
				dir = desktopDirectory(home)
			}
			receipt, err := readDesktopDeployment(dir)
			if err != nil {
				setupError(w, 503, "Remote access status is unavailable. Try again.")
				return
			}
			if receipt != nil {
				recovery := desktopPendingChange(receipt.IdentityChange) || desktopPendingChange(receipt.ConfigurationChange)
				if receipt.Phase == "complete" || recovery {
					out["configured"], out["active"], out["mode"], out["publicOrigin"] = true, false, "cloudflare-access", "https://"+receipt.Input.Hostname
					out["allowedEmail"], out["teamDomain"], out["identity"], out["expiresAt"] = receipt.Input.Email, receipt.TeamDomain, nil, nil
					if recovery {
						out["recoveryRequired"] = true
					}
				}
			}
		}
		jsonReply(w, 200, out)
	}
}

func runSetup() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if absolute, err := filepath.EvalSymlinks(exe); err == nil {
		exe = absolute
	}
	root, err := os.OpenRoot(filepath.Dir(exe))
	if err != nil {
		return err
	}
	defer root.Close()
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	s := &setupHTTP{root: root, quick: newQuickTunnel(nil, ""), standalone: true, managed: newHeadlessSetup(home, filepath.Dir(exe))}
	if s.managed != nil {
		defer s.managed.closeSetup()
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 35 * time.Second, IdleTimeout: 30 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.handle(w, r) {
			http.NotFound(w, r)
		}
	})}
	go func() { <-ctx.Done(); _ = server.Close() }()
	fmt.Printf("Codex Remote Web - remote access setup\nhttp://%s/setup#setup=%s\n", listener.Addr(), s.issue())
	if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
