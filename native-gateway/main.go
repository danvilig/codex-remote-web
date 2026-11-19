package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "0.2.0-beta.2"

func socketPath() string {
	if socket := os.Getenv("CODEX_WEBUI_APP_SERVER_SOCKET"); socket != "" {
		return socket
	}
	home := os.Getenv("CODEX_HOME")
	if home == "" {
		if dir, err := os.UserHomeDir(); err == nil {
			home = filepath.Join(dir, ".codex")
		}
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, "app-server-control", "app-server-control.sock")
}

func run() error {
	if len(os.Args) > 1 {
		if handled, err := runPlatformCommand(os.Args[1], os.Args[2:]); handled {
			return err
		}
		switch os.Args[1] {
		case "--version", "-v":
			fmt.Println("Codex Remote Web", version)
			return nil
		case "--check-pty":
			return checkPTY()
		case "isolated-worker":
			return runIsolatedWorker()
		case "desktop-connector-worker":
			if len(os.Args) != 4 {
				return errors.New("Invalid desktop connector arguments")
			}
			return runDesktopConnectorWorker(os.Args[2], os.Args[3])
		case "quick-worker":
			if len(os.Args) != 5 {
				return errors.New("Invalid temporary connector worker arguments")
			}
			return runQuickWorker(os.Args[2], os.Args[3], os.Args[4])
		case "setup":
			return runSetup()
		case "agent":
			return runDesktopAgent()
		case "session-configure":
			return runDesktopSessionConfigure(os.Stdin, os.Stdout)
		case "cleanup-desktop":
			return runDesktopCleanup(os.Stdout)
		case "uninstall-desktop":
			installation := ""
			if len(os.Args) > 3 {
				return errors.New("Invalid uninstall arguments")
			}
			if len(os.Args) == 3 {
				installation = os.Args[2]
			}
			return runDesktopUninstall(installation)
		case "native-operation":
			if len(os.Args) != 3 {
				return errors.New("Missing desktop installation path")
			}
			return runDesktopOperation(os.Args[2], os.Stdin, os.Stdout)
		case "--help", "-h":
			fmt.Println("Usage: codex-remote-web [setup | agent | uninstall-desktop | --version | --help]\nNo command starts the WebUI at http://127.0.0.1:8899.")
			return nil
		}
	}
	return runGateway()
}

func runGateway() error {
	defaultPort := 8899
	if raw := os.Getenv("PORT"); raw != "" {
		var err error
		if defaultPort, err = strconv.Atoi(raw); err != nil {
			return errors.New("Invalid gateway port")
		}
	}
	flags := flag.NewFlagSet("codex-remote-web", flag.ContinueOnError)
	socket := flags.String("socket", socketPath(), "Codex App Server Unix socket")
	port := flags.Int("port", defaultPort, "Gateway port (0 picks an available port)")
	assetPath := flags.String("assets", "", "Gateway package directory")
	if err := flags.Parse(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || *port < 0 || *port > 65535 {
		return errors.New("Invalid gateway arguments")
	}
	mode := getenvDefault("CODEX_WEBUI_APP_SERVER_MODE", "shared")
	if mode != "shared" && mode != "auto" && mode != "isolated" {
		return errors.New("Invalid CODEX_WEBUI_APP_SERVER_MODE")
	}
	if mode != "isolated" && (!filepath.IsAbs(*socket) || strings.ContainsAny(*socket, "\x00\r\n")) {
		return errors.New("App Server socket must be an absolute local path")
	}
	appRoot := *assetPath
	if appRoot == "" {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		if path, err := filepath.EvalSymlinks(exe); err == nil {
			exe = path
		}
		appRoot = filepath.Dir(exe)
	}
	root, err := os.OpenRoot(appRoot)
	if err != nil {
		return err
	}
	defer root.Close()
	if info, err := root.Stat("public/index.html"); err != nil || !info.Mode().IsRegular() {
		return errors.New("Cannot locate Codex Remote Web application assets")
	}
	host := getenvDefault("HOST", "127.0.0.1")
	codexHome, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	projectless := os.Getenv("CODEX_WEBUI_PROJECTLESS") == "true"
	reviewRoot := os.Getenv("CODEX_WEBUI_REVIEW_ROOT")
	defaultCwd := appRoot
	if projectless {
		if reviewRoot == "" {
			return errors.New("CODEX_WEBUI_REVIEW_ROOT is required when CODEX_WEBUI_PROJECTLESS=true")
		}
		defaultCwd = codexHome
	}
	b := new(bridge)
	w, err := newWorkspace(codexHome, getenvDefault("CODEX_WEBUI_CWD", defaultCwd), b)
	if err != nil {
		return err
	}
	if reviewRoot == "" {
		reviewRoot = w.cwd
	}
	reviewRoot, err = filepath.Abs(reviewRoot)
	if err != nil {
		return err
	}
	access, err := loadAccessAuth(host)
	if err != nil {
		return err
	}
	var local *localAuthenticator
	if access == nil {
		local, err = loadLocalAuth(getenvDefault("CODEX_WEBUI_AUTH_STORE", filepath.Join(w.privateRoot, "codex-webui-auth.json")), getenvDefault("CODEX_WEBUI_PASSWORD", os.Getenv("CODEX_WEBUI_ACCESS_TOKEN")), loopbackHost(host))
		if err != nil {
			return err
		}
	}
	terminal := os.Getenv("CODEX_WEBUI_ENABLE_TERMINAL") == "true"
	reviewWrite := os.Getenv("CODEX_WEBUI_ENABLE_REVIEW_WRITE") == "true"
	app := &gatewayApp{bridge: b, root: root, local: local, access: access, version: version, mux: http.NewServeMux(), config: map[string]any{
		"home": w.home, "defaultCwd": w.cwd, "reviewRoot": reviewRoot, "projectless": projectless, "capabilities": map[string]bool{"terminal": terminal, "reviewWrite": reviewWrite},
	}}
	app.setup = &setupHTTP{root: root, desktop: os.Getenv("CODEX_WEBUI_DESKTOP_CHILD") == "1", quick: newQuickTunnel(app, filepath.Join(w.home, ".config", "codex-remote-web")), access: access}
	if !app.setup.desktop {
		app.setup.managed = newHeadlessSetup(w.home, appRoot)
	}
	defer func() { <-app.setup.quick.stop() }()
	app.mux.HandleFunc("GET /api/remote-access/status", app.remoteStatus(w.home))
	c := newConversation(b, w.privateRoot, app.events.publish)
	c.delivery.bindAttachments = w.attachments.bind
	w.developer.protectedAttachments = c.delivery.protectedAttachmentIDs
	w.developer.terminalGate = &app.terminalGate
	w.developer.worktreeBusy = w.developer.worktreeUsage(c, func() bool { return app.activeTerminals.Load() != 0 })
	accounts := newAccountCache(b, w.privateRoot)
	review := &reviewService{bridge: b, root: reviewRoot, enabled: reviewWrite}
	review.register(app.mux)
	b.onNative = func(conn *nativeConn, message json.RawMessage) {
		var envelope struct{ Method string }
		if json.Unmarshal(message, &envelope) == nil && envelope.Method == "account/updated" {
			accounts.invalidate()
		}
		c.onNative(conn, message)
		if b.current() == conn {
			review.observe(message)
		}
	}
	b.onStatus = func() {
		accounts.invalidate()
		if b.current() == nil {
			review.clear()
		}
		app.events.publish(app.status())
	}
	app.dispatch = func(ctx context.Context, request browserRequest) any {
		if request.Type == "codex/response" || request.Type == "codex/error" {
			ctx, cancel := context.WithTimeout(ctx, writeTimeout)
			defer cancel()
			answer := conversationAnswer{RequestID: request.RequestID, RequestEpoch: request.RequestEpoch, Result: request.Result}
			if request.Type == "codex/error" {
				answer.Error = request.Error
			}
			if err := c.respond(ctx, answer); err != nil {
				return conversationRPCError(request.ID, err)
			}
			return map[string]string{"type": "ack"}
		}
		response := c.dispatch(ctx, request)
		if response.Type == "rpc/result" {
			review.observeReply(request.Method, request.Params, response.Result)
		}
		return response
	}
	if terminal {
		app.terminalDir = func(path string) string {
			if path != "" {
				candidate := workspaceCanonical(path)
				if info, err := os.Stat(candidate); err == nil && info.IsDir() && workspaceInRoots(candidate, workspaceCanonicalRoots(w.browseRoots)) {
					return candidate
				}
			}
			return w.cwd
		}
	}
	w.register(app.mux)
	c.register(app.mux, workspaceMutationAllowed, func(value string) (string, error) {
		if value == "" {
			value = w.cwd
		}
		_, dir, err := w.browse(value)
		return dir, err
	})
	accounts.register(app.mux)
	app.registerCore()
	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(*port)))
	if err != nil {
		return err
	}
	defer listener.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if os.Getenv("CODEX_WEBUI_DESKTOP_PIPE_PARENT") == "1" {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	}
	bridgeDone := make(chan struct{})
	conversationDone := make(chan struct{})
	go func() { defer close(conversationDone); c.run(ctx) }()
	go func() { defer close(bridgeDone); b.runMode(ctx, mode, *socket, w.cwd, version, time.Second) }()
	server := &http.Server{
		Handler: app, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 35 * time.Second, WriteTimeout: 35 * time.Second, IdleTimeout: 30 * time.Second,
		MaxHeaderBytes: 32 << 10, BaseContext: func(net.Listener) context.Context { return ctx },
	}
	stopped := make(chan error, 1)
	go func() {
		<-ctx.Done()
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		stopped <- server.Shutdown(shutdown)
	}()
	fmt.Println("http://" + listener.Addr().String())
	err = server.Serve(listener)
	cancel()
	<-bridgeDone
	<-conversationDone
	if errors.Is(err, http.ErrServerClosed) {
		return <-stopped
	}
	return err
}

func getenvDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
