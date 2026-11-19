package main

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func exposeTestFile(path string) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;" + user.User.Sid.String() + ")(A;;FR;;;WD)")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

func TestWindowsPrivateFileRejectsLinkAndPublicACL(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	if err := ensureDesktopDirectory(dir); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "state.json")
	if err := writeDesktopJSON(file, map[string]bool{"fixture": true}); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(dir, "alias.json")
	if err := os.Link(file, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := readDesktopFile(file, true); err == nil {
		t.Fatal("Accepted file with an extra hard link")
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if data, err := readDesktopFile(file, true); err != nil || !strings.Contains(string(data), "fixture") {
		t.Fatalf("Private state unavailable: %v", err)
	}
	if err := exposeTestFile(file); err != nil {
		t.Fatal(err)
	}
	if _, err := readDesktopFile(file, true); err == nil {
		t.Fatal("Accepted DACL granting Everyone read permission")
	}
}

func TestWindowsProcessPipeHonorsWriteDeadlineAndEOF(t *testing.T) {
	r, w, err := isolatedInputPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	if err := w.SetWriteDeadline(time.Now().Add(200 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(make([]byte, 1<<20)); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("Expected bounded write on a full pipe: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, r); err != nil {
		t.Fatalf("Expected EOF after write handle closed: %v", err)
	}
}

func TestWindowsQuickOriginRequiresPrivateHostAndLoopback(t *testing.T) {
	l, private, rule, err := quickListener("")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if rule["service"] != "http://"+l.Addr().String() || !strings.HasPrefix(l.Addr().String(), "127.0.0.1:") || len(private) != 48+len(".localhost") {
		t.Fatalf("Unexpected origin setup: %v, %q", rule, private)
	}
	const origin = "https://fixture.trycloudflare.com"
	app := &gatewayApp{}
	handler := app.quickHandler(func() string { return origin }, "owner@example.test", private)
	for _, c := range []struct{ host, peer, origin, expected string }{
		{private, "127.0.0.1:12452", origin, `"authenticated":true`},
		{private, "127.0.0.1:12452", "https://other.test", `"authenticated":false`},
		{"fixture.trycloudflare.com", "127.0.0.1:12452", origin, "404"},
		{private, "192.0.2.1:12452", origin, "404"},
	} {
		r := httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)
		r.Host, r.RemoteAddr = c.host, c.peer
		r.Header.Set("Origin", c.origin)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if !strings.Contains(w.Body.String(), c.expected) {
			t.Fatalf("Expected %q from temporary origin, got %d %s", c.expected, w.Code, w.Body.String())
		}
	}
}

func TestWindowsConPTY(t *testing.T) {
	if err := checkPTY(); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsCodexNPMShimResolvesWithoutShell(t *testing.T) {
	base := t.TempDir()
	shim := filepath.Join(base, "codex.cmd")
	entry := filepath.Join(base, "node_modules", "@openai", "codex", "bin", "codex.js")
	if err := os.MkdirAll(filepath.Dir(entry), 0700); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{shim, entry} {
		if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	node, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_WEBUI_NODE", node)
	args := []string{"app-server", "--stdio", "space & echoes"}
	cmd, err := codexCommand(shim, args...)
	if err != nil || !strings.EqualFold(cmd.Path, node) || !slices.Equal(cmd.Args[1:], append([]string{entry}, args...)) {
		t.Fatalf("Native resolver did not preserve argv: %v, %v", cmd, err)
	}
}
