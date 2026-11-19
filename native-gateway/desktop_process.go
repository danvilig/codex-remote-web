package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type desktopProcessStatus struct {
	Phase string  `json:"phase"`
	PID   *int    `json:"pid"`
	Error *string `json:"error"`
}

type desktopProcess struct {
	mu         sync.Mutex
	status     desktopProcessStatus
	child      *exec.Cmd
	stdin      *os.File
	done       chan struct{}
	desired    bool
	generation uint64
	failures   []time.Time
	log        func(string)
}

func (p *desktopProcess) snapshot() desktopProcessStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.status.Phase == "" {
		return desktopProcessStatus{Phase: "stopped"}
	}
	return p.status
}

func (p *desktopProcess) active() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.desired || p.child != nil
}

type desktopLaunch struct {
	binary, cwd string
	args, env   []string
	timeout     time.Duration
	ready       func(string) bool
	noRetry     bool
}

func (p *desktopProcess) start(spec desktopLaunch) error {
	p.mu.Lock()
	if p.child != nil {
		phase := p.status.Phase
		p.mu.Unlock()
		if phase == "running" {
			return nil
		}
		return desktopFailure(409, "", "Wait for the gateway operation to finish")
	}
	p.desired = true
	p.generation++
	p.failures = nil
	return p.launchLocked(spec, p.generation)
}

// Called with mu held; transfers ownership of the child to the reaper and
// releases mu before waiting for readiness or an early exit.
func (p *desktopProcess) launchLocked(spec desktopLaunch, generation uint64) error {
	p.status = desktopProcessStatus{Phase: "starting"}
	child := exec.Command(spec.binary, spec.args...)
	child.Dir, child.Env = spec.cwd, spec.env
	err := configureOwnedCommand(child)
	var lifetime, stdin *os.File
	if err == nil {
		lifetime, stdin, err = os.Pipe()
	}
	if err != nil {
		p.desired = false
		p.status = desktopProcessStatus{Phase: "failed"}
		p.mu.Unlock()
		return err
	}
	child.Stdin = lifetime
	output, logWriter, err := os.Pipe()
	if err == nil {
		child.Stdout, child.Stderr = logWriter, logWriter
		err = child.Start()
		logWriter.Close()
	}
	lifetime.Close()
	if err != nil {
		stdin.Close()
		if output != nil {
			output.Close()
		}
		p.desired = false
		message := "Gateway executable could not start"
		p.status = desktopProcessStatus{Phase: "failed", Error: &message}
		p.mu.Unlock()
		return desktopFailure(400, "", message)
	}
	done, ready := make(chan struct{}), make(chan struct{})
	pid := child.Process.Pid
	p.child, p.stdin, p.done, p.status.PID = child, stdin, done, &pid
	p.mu.Unlock()
	go func() {
		defer output.Close()
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 4096), 64<<10)
		var once sync.Once
		for scanner.Scan() {
			if spec.ready(scanner.Text()) {
				once.Do(func() { close(ready) })
			}
		}
		_, _ = io.Copy(io.Discard, output)
	}()
	go func() {
		_ = child.Wait()
		stdin.Close()
		output.Close()
		p.mu.Lock()
		defer p.mu.Unlock()
		p.child, p.stdin = nil, nil
		defer close(done)
		if !p.desired || p.generation != generation {
			p.status = desktopProcessStatus{Phase: "stopped"}
			return
		}
		message := "Gateway exited. Check dependencies, directory and port."
		p.status = desktopProcessStatus{Phase: "failed", Error: &message}
		if p.log != nil {
			p.log("gateway-exited")
		}
		cutoff := time.Now().Add(-time.Minute)
		for len(p.failures) > 0 && p.failures[0].Before(cutoff) {
			p.failures = p.failures[1:]
		}
		p.failures = append(p.failures, time.Now())
		if !spec.noRetry && len(p.failures) < 3 {
			time.AfterFunc(2*time.Second, func() {
				p.mu.Lock()
				if !p.desired || p.generation != generation || p.child != nil {
					p.mu.Unlock()
					return
				}
				_ = p.launchLocked(spec, generation)
			})
		}
	}()
	timer := time.NewTimer(spec.timeout)
	defer timer.Stop()
	select {
	case <-ready:
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.child == child && p.desired && p.generation == generation {
			p.status.Phase = "running"
			if p.log != nil {
				p.log("gateway-ready")
			}
			return nil
		}
	case <-done:
	case <-timer.C:
		p.stopGeneration(generation)
		return desktopFailure(400, "", "Gateway startup timed out")
	}
	return desktopFailure(400, "", "Gateway failed to start. Check dependencies, directory and port.")
}

func (p *desktopProcess) stop() { p.stopGeneration(0) }

func (p *desktopProcess) stopGeneration(generation uint64) {
	p.mu.Lock()
	if generation != 0 && generation != p.generation {
		p.mu.Unlock()
		return
	}
	p.desired = false
	p.generation++
	child, done := p.child, p.done
	if child == nil {
		p.status = desktopProcessStatus{Phase: "stopped"}
		p.mu.Unlock()
		return
	}
	p.status.Phase = "stopping"
	_ = p.stdin.Close()
	_ = stopOwnedCommand(child, false)
	p.mu.Unlock()
	timer := time.NewTimer(8 * time.Second)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		p.mu.Lock()
		if p.child == child {
			_ = stopOwnedCommand(child, true)
		}
		p.mu.Unlock()
		<-done
	}
}

func desktopChildEnvironment(home string, config desktopConfig) []string {
	values := []string{}
	for _, key := range append([]string{"LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "CODEX_HOME", "CODEX_AUTH_PATH", "CODEX_WEBUI_APP_SERVER_MODE", "CODEX_WEBUI_APP_SERVER_SOCKET"}, desktopPlatformEnv()...) {
		if value := os.Getenv(key); value != "" {
			values = append(values, key+"="+value)
		}
	}
	return append(values, "HOME="+home, "PATH="+desktopPath(home), "HOST=127.0.0.1", "PORT="+strconv.Itoa(config.Port),
		"CODEX_WEBUI_CWD="+config.Cwd, "CODEX_WEBUI_REVIEW_ROOT="+config.Cwd,
		"CODEX_WEBUI_ENABLE_TERMINAL="+strconv.FormatBool(config.Terminal), "CODEX_WEBUI_AUTH_MODE=local",
		"CODEX_WEBUI_DESKTOP_CHILD=1", "CODEX_WEBUI_DESKTOP_PIPE_PARENT=1", "CODEX_WEBUI_CODEX="+config.Codex, "CODEX_WEBUI_CLOUDFLARED="+config.Cloudflared)
}

func desktopPath(home string) string {
	entries := desktopPathEntries(home)
	if path := os.Getenv("PATH"); path != "" {
		entries = append([]string{path}, entries...)
	}
	return strings.Join(entries, string(os.PathListSeparator))
}

func desktopExecutable(name, preferred, path string) string {
	if preferred != "" {
		return preferred
	}
	for _, dir := range filepath.SplitList(path) {
		if !filepath.IsAbs(dir) {
			continue
		}
		candidate := filepath.Join(dir, name)
		if checked, err := exec.LookPath(candidate); err == nil {
			return checked
		}
	}
	return ""
}

type desktopOutput struct {
	data  []byte
	limit int
}

func (b *desktopOutput) Write(p []byte) (int, error) {
	if len(b.data)+len(p) > b.limit {
		return 0, errors.New("Process output exceeded limit")
	}
	b.data = append(b.data, p...)
	return len(p), nil
}

func desktopExec(ctx context.Context, binary string, args, env []string, cwd string, limit int) ([]byte, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir, cmd.Env = cwd, env
	if err := configureOwnedCommand(cmd); err != nil {
		return nil, err
	}
	cmd.Cancel = func() error { return stopOwnedCommand(cmd, true) }
	cmd.WaitDelay = time.Second
	out := &desktopOutput{limit: limit}
	cmd.Stdout = out
	err := cmd.Run()
	return out.data, err
}

func desktopGatewayLaunch(binary, home string, config desktopConfig) desktopLaunch {
	address := fmt.Sprintf("http://127.0.0.1:%d", config.Port)
	return desktopLaunch{binary: binary, cwd: config.Cwd, env: desktopChildEnvironment(home, config),
		timeout: 20 * time.Second, ready: func(line string) bool { return line == address }}
}
