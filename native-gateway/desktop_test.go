package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestDesktopConnectorWorkerFixture(t *testing.T) {
	if os.Getenv("CRW_TEST_DESKTOP_CONNECTOR") != "1" {
		return
	}
	if err := runDesktopConnectorWorker(os.Getenv("CRW_TEST_CONNECTOR_BINARY"), os.Getenv("CRW_TEST_CONNECTOR_TOKEN")); err != nil {
		t.Fatal(err)
	}
}

func TestDesktopConnectorWorkerStopsOnParentEOF(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shell connector fixture; Windows process ownership is tested separately")
	}
	directory := desktopDirectory(t.TempDir())
	if err := ensureDesktopDirectory(directory); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(directory, "cloudflared-fixture")
	fixture := "#!/bin/sh\nprintf '%s\\n' 'Generated Connector ID: 00000000-0000-0000-0000-000000000001' 'Registered tunnel connection' 'private fixture diagnostics'\nexec /bin/sleep 60\n"
	if err := os.WriteFile(binary, []byte(fixture), 0700); err != nil {
		t.Fatal(err)
	}
	token := filepath.Join(directory, "connector-0123.token")
	if err := os.WriteFile(token, []byte("fixture token"), 0600); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	worker := exec.CommandContext(ctx, exe, "-test.run=^TestDesktopConnectorWorkerFixture$")
	worker.Dir = directory
	worker.Env = append(os.Environ(), "CRW_TEST_DESKTOP_CONNECTOR=1", "CRW_TEST_CONNECTOR_BINARY="+binary, "CRW_TEST_CONNECTOR_TOKEN="+token)
	if err := configureOwnedCommand(worker); err != nil {
		t.Fatal(err)
	}
	worker.Cancel = func() error { return stopOwnedCommand(worker, true) }
	input, err := worker.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := worker.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(); err != nil {
		t.Fatal(err)
	}
	defer worker.Wait()
	defer input.Close()
	scanner := bufio.NewScanner(output)
	for _, expected := range []string{"connector-id:00000000-0000-0000-0000-000000000001", "connector-ready"} {
		if !scanner.Scan() || scanner.Text() != expected {
			t.Fatalf("Expected worker marker %q, got %q (%v)", expected, scanner.Text(), scanner.Err())
		}
	}
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), "private fixture diagnostics") {
			t.Fatal("Raw connector output escaped its worker")
		}
	}
	if err := worker.Wait(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(token); !os.IsNotExist(err) {
		t.Fatalf("Worker did not clean its token file: %v", err)
	}
}

func waitDesktopTest(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("Timed out waiting for desktop state")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestDesktopAgentLifecycle(t *testing.T) {
	home := t.TempDir()
	directory := desktopDirectory(home)
	binary := filepath.Join(home, "gateway-fixture")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf 'http://127.0.0.1:%s\\n' \"$PORT\"\nexec /bin/sleep 30\n"), 0700); err != nil {
		t.Fatal(err)
	}
	config, _ := parseDesktopConfig(nil, home)
	config.Initialized, config.Enabled = true, true
	path := filepath.Join(directory, "config.json")
	if err := writeDesktopJSON(path, config); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	const installation = "/fixture/Codex Remote Web.app/Contents/MacOS/Codex Remote Web"
	var done chan error
	start := func() {
		done = make(chan error, 1)
		go func() { done <- serveDesktopAgent(ctx, home, binary, installation) }()
	}
	call := func(action string, body json.RawMessage) (json.RawMessage, error) {
		return desktopAgentRequest(ctx, directory, installation, action, body, time.Second)
	}
	var previousPID int
	getPID := func() int {
		result, err := call("status", nil)
		if err != nil {
			return 0
		}
		var status struct {
			Runtime string
			Local   desktopProcessStatus
		}
		if json.Unmarshal(result, &status) != nil || status.Runtime != desktopRuntime() || status.Local.Phase != "running" || status.Local.PID == nil {
			return 0
		}
		return *status.Local.PID
	}
	start()
	waitDesktopTest(t, func() bool { previousPID = getPID(); return previousPID != 0 })
	if ready, err := waitDesktopAgent(ctx, directory, installation); !ready || err != nil {
		t.Fatalf("The matching agent should remain running: %v %v", ready, err)
	}
	_, foreign := desktopAgentRequest(ctx, directory, "/fixture/other-installation", "stop", nil, time.Second)
	if desktopErrorCode(foreign) != "AGENT_FOREIGN" || getPID() != previousPID {
		t.Fatalf("Foreign agent should be untouched: %v", foreign)
	}
	if _, err := call("language", json.RawMessage(`{"language":"zh"}`)); err != nil || getPID() != previousPID {
		t.Fatalf("Live language change: %v", err)
	}
	if err := serveDesktopAgent(ctx, home, binary, installation); desktopErrorCode(err) != "PRIVATE_LOCK_BUSY" {
		t.Fatalf("Expected a single owner, got %v", err)
	}
	if _, err := call("shutdown", nil); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := readDesktopJSON(path, &config); err != nil || !config.Enabled || config.Language != "zh" {
		t.Fatalf("Shutdown did not preserve gateway preferences: %#v %v", config, err)
	}
	start()
	waitDesktopTest(t, func() bool { return getPID() != 0 && getPID() != previousPID })
	if _, err := call("stop", nil); err != nil || getPID() != 0 {
		t.Fatalf("Stop did not reap the gateway: %v", err)
	}
	if _, err := readDesktopJSON(path, &config); err != nil || config.Enabled {
		t.Fatalf("Explicit stop did not persist disabled state: %#v %v", config, err)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestDesktopControlAndOperationProtocol(t *testing.T) {
	a := &desktopAgent{}
	host, token := "127.0.0.1:4567", strings.Repeat("a", 43)
	handler := a.handler(host, token)
	for _, test := range []struct {
		header, value string
		want          int
	}{
		{"", "", 200}, {"Host", "localhost:4567", 403}, {"Origin", "http://" + host, 403}, {"CF-Connecting-IP", "127.0.0.1", 403},
		{"X-Forwarded-Host", host, 403}, {"Authorization", "Bearer wrong", 403}, {"Content-Type", "text/plain", 405}, {"Sec-Fetch-Site", "cross-site", 403},
	} {
		r := httptest.NewRequest(http.MethodPost, "http://"+host+"/v1/control", strings.NewReader(`{"action":"status"}`))
		r.RemoteAddr = "127.0.0.1:54321"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+token)
		if test.header == "Host" {
			r.Host = test.value
		} else if test.header != "" {
			r.Header.Set(test.header, test.value)
		}
		w := httptest.NewRecorder()
		handler(w, r)
		if w.Code != test.want {
			t.Fatalf("Header %q: got %d want %d", test.header, w.Code, test.want)
		}
	}
	t.Setenv("HOME", t.TempDir())
	for _, test := range []struct {
		body   string
		ok     bool
		status int
	}{
		{`{"action":"prepare","body":null}`, true, 0}, {`{"action":"prepareAgent"}`, true, 0}, {`{"action":"validateConfig"}`, false, 400},
		{strings.Repeat(" ", desktopRequestLimit+1), false, 413},
	} {
		var output bytes.Buffer
		if err := runDesktopOperation("/fixture/app", strings.NewReader(test.body), &output); err != nil {
			t.Fatal(err)
		}
		var reply struct {
			OK     bool
			Status int
		}
		if err := json.Unmarshal(output.Bytes(), &reply); err != nil || reply.OK != test.ok || reply.Status != test.status {
			t.Fatalf("Unexpected CLI response: %s", output.String())
		}
	}
}

func TestDesktopUpgradeReplacesOlderNativeAgent(t *testing.T) {
	directory := desktopDirectory(t.TempDir())
	if err := ensureDesktopDirectory(directory); err != nil {
		t.Fatal(err)
	}
	const installation = "/Applications/Codex Remote Web.app/Contents/MacOS/Codex Remote Web"
	token := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	lock, err := lockDesktop(directory, "agent-lock", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer lock()
	stopped := make(chan struct{})
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request, err := readDesktopRequest(r.Body)
		if err != nil || r.Header.Get("Authorization") != "Bearer "+token || (request.Action != "status" && request.Action != "shutdown") {
			t.Error("Invalid legacy agent request")
			w.WriteHeader(400)
			return
		}
		if request.Action == "shutdown" {
			close(stopped)
		}
		fmt.Fprintf(w, `{"runtime":%q,"gatewayImplementation":"go","gatewayVersion":"0.2.0-beta.1"}`, desktopRuntime())
	}))
	server.Start()
	defer server.Close()
	if err := writeDesktopJSON(filepath.Join(directory, "agent.json"), desktopDescriptor{Version: 1, Port: server.Listener.Addr().(*net.TCPAddr).Port, Token: token, Installation: installation}); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		select {
		case <-stopped:
			server.Close()
			time.Sleep(175 * time.Millisecond) // The old agent is still reaping children.
			lock()
		case <-t.Context().Done():
		}
	}()
	if alreadyRunning, err := waitDesktopAgent(t.Context(), directory, installation); err != nil || alreadyRunning {
		t.Fatalf("The old runtime was reused: %v %v", alreadyRunning, err)
	}
	<-done
}

func TestDesktopPrepareWaitsForOfflineAgentLock(t *testing.T) {
	directory := desktopDirectory(t.TempDir())
	if err := ensureDesktopDirectory(directory); err != nil {
		t.Fatal(err)
	}
	release, err := lockDesktop(directory, "agent-lock", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(t.Context(), 175*time.Millisecond)
	defer cancel()
	installation := filepath.Join(t.TempDir(), "Codex Remote Web")
	if ready, err := waitDesktopAgent(ctx, directory, installation); ready || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Replacement must wait for the lock even with no descriptor: %v %v", ready, err)
	}
	release()
	if ready, err := waitDesktopAgent(t.Context(), directory, installation); ready || err != nil {
		t.Fatalf("Replacement should be allowed after release: %v %v", ready, err)
	}
}

func TestDesktopPrepareRejectsForeignInstallation(t *testing.T) {
	directory := desktopDirectory(t.TempDir())
	if err := ensureDesktopDirectory(directory); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("A foreign agent must not receive an operation")
	}))
	defer server.Close()
	installation := filepath.Join(t.TempDir(), "Codex Remote Web")
	descriptor := desktopDescriptor{Version: 1, Port: server.Listener.Addr().(*net.TCPAddr).Port, Token: base64.RawURLEncoding.EncodeToString(make([]byte, 32)), Installation: installation + " old"}
	if err := writeDesktopJSON(filepath.Join(directory, "agent.json"), descriptor); err != nil {
		t.Fatal(err)
	}
	if ready, err := waitDesktopAgent(t.Context(), directory, installation); ready || desktopErrorCode(err) != "AGENT_FOREIGN" {
		t.Fatalf("Foreign installation was not rejected: %v %v", ready, err)
	}
}

func TestDesktopSessionGenerationAndFailedBootstrap(t *testing.T) {
	home := t.TempDir()
	directory := desktopDirectory(home)
	s := desktopSession{home: home, directory: directory, installation: "/fixture/Codex & Web", run: func(...string) error { return nil }}
	spec := desktopSessionDefinition(home, s.installation)
	if !strings.Contains(spec.Content, "Codex &amp; Web") {
		t.Fatal("Launcher path was not escaped")
	}
	restore, err := s.configure(true, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.configure(true, false); err != nil {
		t.Fatal(err)
	}
	if err := restore(); desktopErrorCode(err) != "SESSION_CHANGED" {
		t.Fatalf("An identical later save should supersede rollback: %v", err)
	}
	foreign := s
	foreign.installation = "/fixture/foreign"
	foreign.run = func(...string) error { t.Fatal("Foreign session must not invoke launchctl"); return nil }
	if _, err := foreign.configure(false, true); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(spec.Path); err != nil || string(data) != spec.Content {
		t.Fatalf("Registration lost: %v", err)
	}
	if _, err := s.configure(false, false); err != nil {
		t.Fatal(err)
	}
	s.run = func(args ...string) error {
		if args[0] == "bootstrap" {
			return fmt.Errorf("Fixture failure")
		}
		return nil
	}
	if _, err := s.configure(true, false); err == nil {
		t.Fatal("A failed login item should fail configuration")
	}
	for _, path := range []string{spec.Path, filepath.Join(directory, "session.json")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("Failed bootstrap left a registration: %s %v", path, err)
		}
	}
}

func TestDesktopCleanupPreservesAccountAndUncertainState(t *testing.T) {
	home := t.TempDir()
	directory := desktopDirectory(home)
	config := filepath.Join(directory, "config.json")
	if err := writeDesktopJSON(config, map[string]int{"version": 1}); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(directory, "setup-state.json")
	if err := writeDesktopJSON(state, map[string]any{"phase": "complete"}); err != nil {
		t.Fatal(err)
	}
	if err := cleanDesktopState(home, directory); desktopErrorCode(err) != "REMOTE_DEPLOYMENT_PRESENT" {
		t.Fatalf("Cleanup should refuse a live deployment: %v", err)
	}
	if _, err := os.Stat(config); err != nil {
		t.Fatal(err)
	}
	if err := writeDesktopJSON(state, map[string]any{"phase": "removed"}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(home, ".codex", "account.txt"), filepath.Join(directory, "unknown.json"), filepath.Join(home, "Library", "Logs", "Codex Remote Web", "old.txt")} {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := cleanDesktopState(home, directory); err != nil {
		t.Fatal(err)
	}
	removed := []string{config, state}
	preserved := []string{filepath.Join(home, ".codex", "account.txt"), filepath.Join(directory, "unknown.json"), filepath.Join(directory, "agent-lock.sqlite"), filepath.Join(directory, "session-lock.sqlite")}
	legacyLogs := filepath.Join(home, "Library", "Logs", "Codex Remote Web")
	if runtime.GOOS == "darwin" {
		removed = append(removed, legacyLogs)
	} else {
		preserved = append(preserved, legacyLogs)
	}
	for _, path := range removed {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("Cleanup left %s: %v", path, err)
		}
	}
	for _, path := range preserved {
		if _, err := os.Lstat(path); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDesktopLockInteroperatesWithSQLite(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun is required only for the legacy lock interoperability fixture")
	}
	dir := filepath.Join(t.TempDir(), "private")
	if err := ensureDesktopDirectory(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "agent-lock.sqlite")
	setup := `import { Database } from 'bun:sqlite';const db=new Database(process.argv[1]);`
	initialize := exec.Command(bun, "-e", setup+`db.close();`, path)
	if data, err := initialize.CombinedOutput(); err != nil {
		t.Fatalf("Initialize legacy SQLite fixture: %v %s", err, data)
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	release, err := lockDesktop(dir, "agent-lock", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	legacy := func() ([]byte, error) {
		return exec.Command(bun, "-e", setup+`db.exec('PRAGMA busy_timeout=0');try{db.exec('BEGIN IMMEDIATE');console.log('held');db.exec('ROLLBACK')}catch(e){console.log(e.code)}db.close()`, path).CombinedOutput()
	}
	if data, err := legacy(); err != nil || strings.TrimSpace(string(data)) != "SQLITE_BUSY" {
		t.Fatalf("SQLite ignored native lock: %v %s", err, data)
	}
	release()
	if data, err := legacy(); err != nil || strings.TrimSpace(string(data)) != "held" {
		t.Fatalf("SQLite could not acquire released lock: %v %s", err, data)
	}
}
