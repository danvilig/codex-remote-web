package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

const desktopRequestLimit = 16 << 10

type desktopConfig struct {
	Version     int    `json:"version"`
	Initialized bool   `json:"initialized"`
	Enabled     bool   `json:"enabled"`
	Autostart   bool   `json:"autostart"`
	Cwd         string `json:"cwd"`
	Port        int    `json:"port"`
	Codex       string `json:"codex"`
	Cloudflared string `json:"cloudflared"`
	Terminal    bool   `json:"terminal"`
	Language    string `json:"language"`
	Theme       string `json:"theme"`
}

func validDesktopPath(path string) bool {
	return filepath.IsAbs(path) && !strings.ContainsAny(path, "\x00\r\n")
}

func parseDesktopConfig(data json.RawMessage, home string) (desktopConfig, error) {
	config := desktopConfig{Version: 1, Autostart: true, Cwd: home, Port: 8899, Language: "system", Theme: "system"}
	if len(data) == 0 {
		return config, nil
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields == nil {
		return config, desktopFailure(400, "", "Invalid desktop configuration")
	}
	for name, value := range fields {
		var field any
		switch name {
		case "version":
			field = &config.Version
		case "initialized":
			field = &config.Initialized
		case "enabled":
			field = &config.Enabled
		case "autostart":
			field = &config.Autostart
		case "cwd":
			field = &config.Cwd
		case "port":
			field = &config.Port
		case "codex":
			field = &config.Codex
		case "cloudflared":
			field = &config.Cloudflared
		case "terminal":
			field = &config.Terminal
		case "language":
			field = &config.Language
		case "theme":
			field = &config.Theme
		}
		if field == nil || bytes.Equal(value, []byte("null")) || json.Unmarshal(value, field) != nil {
			return config, desktopFailure(400, "", "Invalid desktop configuration")
		}
	}
	if config.Version != 1 || config.Port < 1024 || config.Port > 65535 {
		return config, desktopFailure(400, "", "Choose a port between 1024 and 65535")
	}
	if !validDesktopPath(config.Cwd) || config.Codex != "" && !validDesktopPath(config.Codex) || config.Cloudflared != "" && !validDesktopPath(config.Cloudflared) {
		return config, desktopFailure(400, "", "Choose an absolute local path")
	}
	if config.Language != "system" && config.Language != "zh" && config.Language != "en" || config.Theme != "system" && config.Theme != "light" && config.Theme != "dark" {
		return config, desktopFailure(400, "", "Invalid desktop preferences")
	}
	return config, nil
}

type desktopDependency struct {
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Path    string `json:"path,omitempty"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
}

func desktopDependencies(ctx context.Context, home string, config desktopConfig) []desktopDependency {
	selected := []struct{ name, path string }{{"codex", config.Codex}, {"git", ""}, {"cloudflared", config.Cloudflared}}
	results := make([]desktopDependency, len(selected))
	var group sync.WaitGroup
	for i, exe := range selected {
		group.Go(func() {
			check := desktopDependency{Name: exe.name, Path: desktopExecutable(exe.name, exe.path, desktopPath(home))}
			defer func() { results[i] = check }()
			if check.Path == "" {
				check.Error = "Executable not found"
				return
			}
			timed, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			output, err := desktopExec(timed, check.Path, []string{"--version"}, desktopChildEnvironment(home, config), "", 32768)
			if err != nil {
				check.Error = "Executable could not be verified"
				return
			}
			version, _, _ := strings.Cut(strings.TrimSpace(string(output)), "\n")
			versionRunes := []rune(version)
			check.OK, check.Version = true, string(versionRunes[:min(120, len(versionRunes))])
		})
	}
	group.Wait()
	return results
}

type desktopDescriptor struct {
	Version      int    `json:"version"`
	Port         int    `json:"port"`
	Token        string `json:"token"`
	PID          int    `json:"pid"`
	Installation string `json:"installation"`
}

type desktopRequest struct {
	Action string          `json:"action"`
	Body   json.RawMessage `json:"body,omitempty"`
}

func readDesktopRequest(input io.Reader) (desktopRequest, error) {
	var request desktopRequest
	data, err := io.ReadAll(io.LimitReader(input, desktopRequestLimit+1))
	if len(data) > desktopRequestLimit {
		return request, desktopFailure(413, "", "Desktop request is too large")
	}
	if err != nil || json.Unmarshal(data, &request) != nil || request.Action == "" {
		return request, desktopFailure(400, "", "Invalid desktop request")
	}
	if bytes.Equal(request.Body, []byte("null")) {
		request.Body = nil
	}
	return request, nil
}

type desktopEvent struct {
	Time  time.Time `json:"time"`
	Event string    `json:"event"`
}

type desktopAgent struct {
	home, directory, binary string
	setupCapability         string
	mu                      sync.RWMutex
	control                 sync.Mutex
	config                  desktopConfig
	events                  []desktopEvent
	closing                 bool
	local, protected        desktopProcess
	connector               desktopProcess
	managed                 desktopManaged
	done                    chan struct{}
}

func (a *desktopAgent) log(event string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.events = append(a.events, desktopEvent{Time: time.Now().UTC(), Event: event})
	if len(a.events) > 200 {
		a.events = append([]desktopEvent(nil), a.events[len(a.events)-200:]...)
	}
}

func (a *desktopAgent) currentConfig() desktopConfig {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.config
}

func (a *desktopAgent) saveConfig(config desktopConfig) error {
	if err := writeDesktopJSON(filepath.Join(a.directory, "config.json"), config); err != nil {
		return err
	}
	a.mu.Lock()
	a.config = config
	a.mu.Unlock()
	return nil
}

func (a *desktopAgent) status() map[string]any {
	a.mu.RLock()
	config := a.config
	events := append([]desktopEvent{}, a.events...)
	a.mu.RUnlock()
	return map[string]any{"runtime": "macos-native", "gatewayImplementation": "go", "url": fmt.Sprintf("http://127.0.0.1:%d", config.Port), "config": config,
		"local": a.local.snapshot(), "protected": a.protected.snapshot(), "connector": map[string]bool{"running": a.connector.snapshot().Phase == "running"},
		"events": events, "setup": a.setupStatus()}
}

func (a *desktopAgent) validateConfig(ctx context.Context, body json.RawMessage) (desktopConfig, error) {
	if a.local.active() || a.protected.active() {
		return desktopConfig{}, desktopFailure(409, "", "Stop the gateway before changing its settings")
	}
	next, err := parseDesktopConfig(body, a.home)
	if err != nil {
		return next, err
	}
	next.Enabled, next.Initialized = false, true
	receipt, err := a.readDeployment()
	if err != nil {
		return next, err
	}
	if receipt != nil && receipt.Phase != "removed" && next.Port == receipt.Input.Port {
		return next, desktopFailure(400, "", "The local gateway and fixed-domain gateway need different ports")
	}
	if info, err := os.Stat(next.Cwd); err != nil || !info.IsDir() {
		return next, desktopFailure(400, "", "Choose an existing project directory")
	}
	checks := desktopDependencies(ctx, a.home, next)
	if !checks[0].OK || !checks[1].OK {
		return next, desktopFailure(400, "", "Codex and Git must pass dependency checks")
	}
	return next, nil
}

func (a *desktopAgent) begin() error {
	config := a.currentConfig()
	if !config.Initialized {
		return desktopFailure(409, "", "Complete initialization first")
	}
	spec := desktopGatewayLaunch(a.binary, a.home, config)
	spec.env = append(spec.env, "CODEX_WEBUI_DESKTOP_SETUP_CAPABILITY="+a.setupCapability)
	if err := a.local.start(spec); err != nil {
		return err
	}
	if err := a.startProtected(); err != nil {
		return err
	}
	config.Enabled = true
	return a.saveConfig(config)
}

func (a *desktopAgent) stopChildren() {
	a.connector.stop()
	var children sync.WaitGroup
	children.Go(a.local.stop)
	children.Go(a.protected.stop)
	children.Wait()
}

func (a *desktopAgent) stop() error {
	a.stopChildren()
	config := a.currentConfig()
	config.Enabled = false
	return a.saveConfig(config)
}

func (a *desktopAgent) dispatch(ctx context.Context, request desktopRequest) (any, error) {
	if request.Action == "status" {
		return a.status(), nil
	}
	if request.Action == "dependencies" {
		config := a.currentConfig()
		var requestBody struct {
			Config json.RawMessage `json:"config"`
		}
		if len(request.Body) > 0 && json.Unmarshal(request.Body, &requestBody) != nil {
			return nil, desktopFailure(400, "", "Invalid desktop configuration")
		}
		if len(requestBody.Config) > 0 && string(requestBody.Config) != "null" {
			var err error
			if config, err = parseDesktopConfig(requestBody.Config, a.home); err != nil {
				return nil, err
			}
		}
		return desktopDependencies(ctx, a.home, config), nil
	}
	if !a.control.TryLock() {
		return nil, desktopFailure(409, "", "Wait for the current desktop operation")
	}
	defer a.control.Unlock()
	a.mu.RLock()
	closing := a.closing
	a.mu.RUnlock()
	if closing {
		return nil, desktopFailure(503, "", "The desktop agent is shutting down")
	}
	if request.Action == "setup" {
		return a.setupRequest(ctx, request.Body)
	}
	if a.setupBusy() && request.Action != "language" {
		return nil, desktopFailure(409, "", "Wait for the remote access operation")
	}
	var err error
	switch request.Action {
	case "language":
		var body map[string]string
		err = json.Unmarshal(request.Body, &body)
		language := body["language"]
		if err != nil || len(body) != 1 || language != "system" && language != "zh" && language != "en" {
			return nil, desktopFailure(400, "", "Invalid desktop preferences")
		}
		config := a.currentConfig()
		config.Language = language
		err = a.saveConfig(config)
	case "cleanupCheck":
		if err := assertDesktopCleanup(a.directory); err != nil {
			return nil, err
		}
		return map[string]bool{"ready": true}, nil
	case "validateConfig":
		return a.validateConfig(ctx, request.Body)
	case "config":
		var next desktopConfig
		if next, err = a.validateConfig(ctx, request.Body); err == nil {
			if err = a.saveConfig(next); err == nil {
				a.log("configuration-saved")
			}
		}
	case "start":
		err = a.begin()
	case "stop":
		err = a.stop()
	case "restart":
		if err = a.stop(); err == nil {
			err = a.begin()
		}
	case "shutdown":
		a.mu.Lock()
		a.closing = true
		a.mu.Unlock()
		close(a.done)
	default:
		return nil, desktopFailure(404, "", "Unknown desktop operation")
	}
	if err != nil {
		return nil, err
	}
	return a.status(), nil
}

func desktopSafeError(err error) *desktopError {
	var failure *desktopError
	if errors.As(err, &failure) {
		return failure
	}
	return &desktopError{Status: 400, Message: "Desktop operation failed. Check local paths, permissions and dependencies."}
}

func desktopControlRequest(r *http.Request, host, token string) bool {
	addr, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || net.ParseIP(addr) == nil || !net.ParseIP(addr).IsLoopback() || r.Host != host {
		return false
	}
	for key := range r.Header {
		key = strings.ToLower(key)
		if key == "origin" || key == "forwarded" || strings.HasPrefix(key, "x-forwarded-") || strings.HasPrefix(key, "cf-") {
			return false
		}
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return false
	}
	auth := r.Header.Values("Authorization")
	return len(auth) == 1 && subtle.ConstantTimeCompare([]byte(auth[0]), []byte("Bearer "+token)) == 1
}

func (a *desktopAgent) handler(host, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		reply := func(status int, data any) {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(data)
		}
		if !desktopControlRequest(r, host, token) {
			reply(403, &desktopError{Message: "Desktop control is private to this user"})
			return
		}
		if r.Method != http.MethodPost || len(r.Header.Values("Content-Type")) != 1 || r.Header.Get("Content-Type") != "application/json" {
			reply(405, &desktopError{Message: "Use an authenticated JSON operation"})
			return
		}
		if r.URL.RequestURI() != "/v1/control" {
			reply(404, &desktopError{Message: "Not found"})
			return
		}
		request, err := readDesktopRequest(r.Body)
		if err == nil {
			var value any
			value, err = a.dispatch(r.Context(), request)
			if err == nil {
				reply(200, value)
				return
			}
		}
		failure := desktopSafeError(err)
		reply(failure.Status, failure)
	}
}

// runDesktopAgent is the entry point for the Swift background helper. The
// gateway child is this same executable, started with PORT and the desktop
// child environment, and reports its bound URL on stdout after Listen.
func runDesktopAgent() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	installation := os.Getenv("CODEX_WEBUI_DESKTOP_INSTALLATION")
	if !validDesktopPath(installation) {
		return errors.New("Invalid desktop installation")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if os.Getenv("CODEX_WEBUI_DESKTOP_PIPE_PARENT") == "1" {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	}
	err = serveDesktopAgent(ctx, home, binary, installation)
	if desktopErrorCode(err) == "PRIVATE_LOCK_BUSY" || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func serveDesktopAgent(ctx context.Context, home, binary, installation string) error {
	directory := desktopDirectory(home)
	if err := ensureDesktopDirectory(directory); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	release, err := lockDesktop(directory, "agent-lock", 100*time.Millisecond)
	if err != nil {
		return err
	}
	defer release()
	a := &desktopAgent{home: home, directory: directory, binary: binary, done: make(chan struct{})}
	a.local.log = func(event string) { a.log("local:" + event) }
	a.protected.log = func(event string) { a.log("protected:" + event) }
	var data json.RawMessage
	if _, err := readDesktopJSON(filepath.Join(directory, "config.json"), &data); err != nil {
		return err
	}
	if a.config, err = parseDesktopConfig(data, home); err != nil {
		return err
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return err
	}
	token := base64.RawURLEncoding.EncodeToString(secret[:])
	if _, err := rand.Read(secret[:]); err != nil {
		return err
	}
	a.setupCapability = base64.RawURLEncoding.EncodeToString(secret[:])
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	descriptorPath := filepath.Join(directory, "agent.json")
	if err := writeDesktopJSON(descriptorPath, desktopDescriptor{Version: 1, Port: listener.Addr().(*net.TCPAddr).Port, Token: token, PID: os.Getpid(), Installation: installation}); err != nil {
		return err
	}
	defer removeDesktopFile(descriptorPath)
	server := &http.Server{Handler: a.handler(listener.Addr().String(), token), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 8 * time.Second, MaxHeaderBytes: 8 << 10}
	serveDone := make(chan error, 1)
	initial := a.currentConfig()
	go func() { serveDone <- server.Serve(listener) }()
	a.log("agent-ready")
	if initial.Enabled && initial.Initialized {
		go func() {
			if _, err := a.dispatch(ctx, desktopRequest{Action: "start"}); err != nil {
				a.log("startup-failed")
			}
		}()
	}
	select {
	case <-ctx.Done():
	case <-a.done:
	case err = <-serveDone:
	}
	a.mu.Lock()
	a.closing = true
	a.mu.Unlock()
	// Drain the response and wait for accepted state changes before stopping
	// children. The background agent's exit does not change desired state.
	shutdown, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdown)
	a.control.Lock()
	defer a.control.Unlock()
	a.closeSetup()
	a.stopChildren()
	return err
}
