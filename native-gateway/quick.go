package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

var quickEmailPattern = regexp.MustCompile("^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\\.[a-z]{2,63}$")
var quickOriginPattern = regexp.MustCompile(`https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com(?:[\s|]|$)`)
var quickConfigOK = regexp.MustCompile(`(?m)^OK\s*$`)

var quickOwnerBusy = errors.New("Temporary access is managed by another WebUI process. Stop it there first.")

type quickStatus struct {
	Phase     string     `json:"phase"`
	Origin    *string    `json:"publicOrigin"`
	Email     *string    `json:"email"`
	StartedAt *time.Time `json:"startedAt"`
	Error     *string    `json:"error"`
	Running   bool       `json:"running"`
	Available bool       `json:"available"`
}

type quickTunnel struct {
	mu        sync.Mutex
	app       *gatewayApp
	configDir string
	state     quickStatus
	cancel    context.CancelFunc
	done      chan struct{}
}

func newQuickTunnel(app *gatewayApp, configDir string) *quickTunnel {
	return &quickTunnel{app: app, configDir: configDir, state: quickStatus{Phase: "stopped", Available: app != nil}}
}

func (q *quickTunnel) status() quickStatus { q.mu.Lock(); defer q.mu.Unlock(); return q.state }

func (q *quickTunnel) start(rawEmail string) (int, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.app == nil {
		return 409, errors.New("Open the full WebUI to start temporary access.")
	}
	if q.cancel != nil {
		return 409, errors.New("Temporary access is already starting or running.")
	}
	email := strings.ToLower(strings.TrimSpace(rawEmail))
	if len(email) > 254 || !quickEmailPattern.MatchString(email) {
		return 400, errors.New("Enter the one email address allowed to sign in.")
	}
	ctx, cancel := context.WithCancel(context.Background())
	q.cancel, q.done = cancel, make(chan struct{})
	q.state = quickStatus{Phase: "starting", Email: &email, Running: true, Available: true}
	go func(done chan struct{}) {
		err := q.run(ctx, email)
		cancel()
		q.mu.Lock()
		defer q.mu.Unlock()
		q.state.Phase, q.state.Origin, q.state.Running = "stopped", nil, false
		if err != nil {
			msg := err.Error()
			q.state.Phase, q.state.Error = "failed", &msg
		}
		q.cancel = nil
		close(done)
	}(q.done)
	return 202, nil
}

func (q *quickTunnel) stop() <-chan struct{} {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.cancel == nil {
		ch := make(chan struct{})
		close(ch)
		return ch
	}
	q.state.Phase, q.state.Origin = "stopping", nil
	q.cancel()
	return q.done
}

func quickEnv(dir string) []string {
	env := []string{"HOME=" + dir, "PATH=" + getenvDefault("PATH", "/usr/bin:/bin")}
	for _, key := range append([]string{"TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"}, quickPlatformEnv()...) {
		if v := os.Getenv(key); v != "" {
			env = append(env, key+"="+v)
		}
	}
	return env
}

func quickArgs(dir, email string) []string {
	return []string{"tunnel", "--no-autoupdate", "--config", filepath.Join(dir, "config.yml"), "--output", "json", "--loglevel", "info", "--protocol", "auto", "--hello-world", "--allowed-mail", email, "--metrics", "127.0.0.1:0", "--management-diagnostics=false", "--grace-period", "1s"}
}

func quickProbe(ctx context.Context, binary, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir, cmd.Env = dir, quickEnv(dir)
	if err := configureOwnedCommand(cmd); err != nil {
		return "", err
	}
	cmd.Cancel = func() error { return stopOwnedCommand(cmd, true) }
	cmd.WaitDelay = time.Second
	var output quickOutput
	cmd.Stdout, cmd.Stderr = &output, &output
	err := cmd.Run()
	return output.String(), err
}

type quickOutput struct {
	mu   sync.Mutex
	text strings.Builder
}

func (o *quickOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.text.Len()+len(p) > 150000 {
		return 0, errors.New("Connector diagnostic exceeded its output limit")
	}
	return o.text.Write(p)
}
func (o *quickOutput) String() string { o.mu.Lock(); defer o.mu.Unlock(); return o.text.String() }

// The Bun gateway honors this exclusive marker. Keep it while the native
// process holds the OS lock so both generations agree about tunnel ownership.
func claimLegacyQuickMarker(directory string) (func(), error) {
	path := filepath.Join(directory, "quick-tunnel.lock")
	type owner struct {
		PID int    `json:"pid"`
		ID  string `json:"id"`
	}
	data, _ := json.Marshal(owner{PID: os.Getpid(), ID: uuidConversation()})
	for range 2 {
		f, err := desktopOpen(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 1024, true)
		if err == nil {
			_, writeErr := f.Write(data)
			if err := errors.Join(writeErr, f.Close()); err != nil {
				_ = os.Remove(path)
				return nil, err
			}
			return func() {
				if current, err := readDesktopFile(path, true); err == nil && bytes.Equal(current, data) {
					_ = os.Remove(path)
				}
			}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		current, err := readDesktopFile(path, true)
		var previous owner
		if current == nil && err == nil {
			continue
		}
		if err != nil || len(current) > 1024 || json.Unmarshal(current, &previous) != nil || previous.PID <= 0 || !processMissing(previous.PID) {
			return nil, quickOwnerBusy
		}
		if latest, err := readDesktopFile(path, true); err != nil || !bytes.Equal(current, latest) {
			return nil, quickOwnerBusy
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return nil, quickOwnerBusy
}

func (q *quickTunnel) run(ctx context.Context, email string) (failure error) {
	defer func() {
		if ctx.Err() != nil {
			failure = nil
		}
	}()
	binary, err := exec.LookPath(getenvDefault("CODEX_WEBUI_CLOUDFLARED", "cloudflared"))
	if err != nil {
		return errors.New("Install cloudflared to use temporary access.")
	}
	help, err := quickProbe(ctx, binary, os.TempDir(), "tunnel", "--help")
	if err != nil || !strings.Contains(help, "--allowed-mail") || !quickPlatformReady(help) {
		return errors.New("Update cloudflared to a version supporting protected Quick Tunnels.")
	}
	if err = ensureDesktopDirectory(q.configDir); err != nil {
		return errors.New("Unable to open private temporary access state.")
	}
	lock, err := desktopOpen(filepath.Join(q.configDir, "native-quick.lock"), os.O_RDWR|os.O_CREATE, 1<<20, true)
	if err != nil {
		return errors.New("Unable to open private temporary access state.")
	}
	defer lock.Close()
	if !tryQuickLock(lock) {
		return quickOwnerBusy
	}
	release, err := claimLegacyQuickMarker(q.configDir)
	if err != nil {
		if errors.Is(err, quickOwnerBusy) {
			return err
		}
		return errors.New("Unable to open private temporary access state.")
	}
	defer release()
	dir, err := quickTemp()
	if err != nil {
		return errors.New("Unable to open private temporary access state.")
	}
	defer os.RemoveAll(dir)
	listener, privateHost, rule, err := quickListener(dir)
	if err != nil {
		return errors.New("Unable to start the private temporary origin.")
	}
	defer listener.Close()
	config, _ := json.Marshal(map[string]any{"ingress": []map[string]any{rule}})
	if os.WriteFile(filepath.Join(dir, "config.yml"), config, 0600) != nil {
		return errors.New("Unable to write the private connector configuration.")
	}
	args := quickArgs(dir, email)
	output, err := quickProbe(ctx, binary, dir, append(append([]string{}, args...), "ingress", "validate")...)
	if err != nil || !quickConfigOK.MatchString(output) || strings.Contains(output, "Incorrect Usage") || strings.Contains(output, "flag provided but not defined") {
		return errors.New("cloudflared rejected the temporary access configuration. Update cloudflared and retry.")
	}
	server := &http.Server{Handler: q.app.quickHandler(func() string {
		s := q.status()
		if s.Origin != nil {
			return *s.Origin
		}
		return ""
	}, email, privateHost), ReadHeaderTimeout: 5 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	defer server.Close()
	go func() { _ = server.Serve(listener) }()
	exe, err := os.Executable()
	if err != nil {
		return errors.New("The temporary access connector could not start.")
	}
	cmd := exec.Command(exe, "quick-worker", binary, dir, email)
	cmd.Dir, cmd.Env = dir, quickEnv(dir)
	if err := configureOwnedCommand(cmd); err != nil {
		return errors.New("The temporary access connector could not start.")
	}
	input, err := cmd.StdinPipe()
	if err != nil {
		return errors.New("The temporary access connector could not start.")
	}
	defer input.Close()
	ready, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return errors.New("The temporary access connector could not start.")
	}
	defer func() { _ = input.Close(); _ = cmd.Wait() }()
	announced := make(chan string, 1)
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		scanner := bufio.NewScanner(ready)
		for scanner.Scan() {
			select {
			case announced <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
	}()
	timer := time.NewTimer(90 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil
	case <-timer.C:
		return errors.New("Temporary access did not become ready in time. Check connectivity and retry.")
	case origin := <-announced:
		if origin == "unprotected" {
			return errors.New("cloudflared did not confirm email protection. Temporary access was not opened.")
		}
		if !strings.HasPrefix(origin, "https://") || strings.TrimSpace(quickOriginPattern.FindString(origin)) != origin {
			return errors.New("The temporary address could not be verified.")
		}
		q.mu.Lock()
		if ctx.Err() == nil {
			now := time.Now()
			q.state.Phase, q.state.Origin, q.state.StartedAt = "ready", &origin, &now
		}
		q.mu.Unlock()
	case <-ended:
		return errors.New("Temporary access could not connect securely. Check cloudflared and the network, then retry.")
	}
	select {
	case <-ctx.Done():
		return nil
	case <-ended:
		return errors.New("The temporary access connector disconnected.")
	}
}

func runQuickWorker(binary, dir, email string) error {
	if !workerOwnsProcess() || !filepath.IsAbs(binary) || !quickEmailPattern.MatchString(email) {
		return errors.New("Invalid temporary connector supervisor")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	cmd := exec.Command(binary, quickArgs(dir, email)...)
	cmd.Dir, cmd.Env = dir, quickEnv(dir)
	r, w, err := os.Pipe()
	if err != nil {
		return err
	}
	defer r.Close()
	cmd.Stdout, cmd.Stderr = w, w
	if err := cmd.Start(); err != nil {
		_ = w.Close()
		return err
	}
	_ = w.Close()
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	go func() {
		defer cancel()
		scanner := bufio.NewScanner(r)
		var protected, registered, ready bool
		var origin string
		for scanner.Scan() {
			line := scanner.Text()
			var event struct {
				Message string `json:"message"`
			}
			if json.Unmarshal([]byte(line), &event) == nil {
				line = event.Message
			}
			if strings.Contains(line, "Your quick Tunnel has been created!") {
				_, _ = os.Stdout.WriteString("unprotected\n")
				return
			}
			if strings.Contains(line, "Your protected quick Tunnel has been created!") {
				protected = true
			}
			if protected {
				if value := strings.Trim(quickOriginPattern.FindString(line), " |\t\r\n"); value != "" {
					origin = value
				}
			}
			if strings.Contains(line, "Registered tunnel connection") {
				registered = true
			}
			if protected && registered && origin != "" && !ready {
				ready = true
				if _, err := os.Stdout.WriteString(origin + "\n"); err != nil {
					return
				}
			}
		}
	}()
	select {
	case <-ctx.Done():
	case <-done:
	}
	finishOwnedWorker()
	return nil
}
