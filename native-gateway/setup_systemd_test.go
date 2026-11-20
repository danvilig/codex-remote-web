//go:build linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLinuxDesktopLoginPreservesEditedEnablementAndSupportsOfflineRemoval(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "runtime-without-bus"))
	t.Setenv("WAYLAND_DISPLAY", "wayland-1")
	s := desktopSession{home: home, directory: desktopDirectory(home), installation: "/fixture/Codex % Web", platform: "linux", run: func(...string) error {
		t.Fatal("No user bus: disabling startup must not invoke systemctl")
		return nil
	}}
	if err := ensureDesktopDirectory(s.directory); err != nil {
		t.Fatal(err)
	}
	old := desktopLinuxSessionDefinition(home, s.installation, func(key string) string {
		if key == "XAUTHORITY" {
			return `/old/xauth"file`
		}
		return ""
	})
	if !old.ownedBy(s.definition()) || !strings.Contains(old.Content, `"/fixture/Codex %% Web"`) {
		t.Fatal("The old generated launcher or its quoting was not recognized")
	}
	for _, injected := range []string{"ExecStart=/bin/false\n", "Environment=\"WAYLAND_DISPLAY=evil\"\nEnvironment=\"DISPLAY=:0\"\n"} {
		modified := old
		modified.Content = strings.Replace(old.Content, desktopLinuxSessionTail, injected+desktopLinuxSessionTail, 1)
		if modified.ownedBy(s.definition()) {
			t.Fatalf("Accepted unknown launch content: %q", injected)
		}
	}
	if err := writeSystemdOwned(old.Path, old.Content); err != nil {
		t.Fatal(err)
	}
	record := filepath.Join(s.directory, "session.json")
	if err := writeDesktopJSON(record, old); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(filepath.Dir(old.Path), "graphical-session.target.wants", filepath.Base(old.Path))
	if err := os.MkdirAll(filepath.Dir(link), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../foreign.service", link); err != nil {
		t.Fatal(err)
	}
	if _, err := s.configure(false, false); desktopErrorCode(err) != "SESSION_CHANGED" {
		t.Fatalf("Foreign enablement was not blocked: %v", err)
	}
	assertSystemdFile(t, old.Path, old.Content)
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../"+filepath.Base(old.Path), link); err != nil {
		t.Fatal(err)
	}
	if _, err := s.configure(false, false); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{old.Path, link, record} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("Offline uninstall left %s: %v", path, err)
		}
	}
}

func assertSystemdFile(t *testing.T, path, expected string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil || string(data) != expected {
		t.Fatalf("Unexpected file at %s: %v", path, err)
	}
}

func systemdLegacyFixture(t *testing.T) (*desktopAgent, *desktopDeploymentReceipt) {
	t.Helper()
	home := t.TempDir()
	root := filepath.Join(home, "native % package")
	if err := os.MkdirAll(filepath.Join(root, "public"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "public", "index.html"), []byte("synthetic assets"), 0600); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(home, ".config", "codex-remote-web")
	s := &headlessSystemd{home: home, directory: directory, binary: filepath.Join(root, "codex-remote-web"), root: root, run: func(...string) error { return nil }, ready: func(context.Context, *desktopDeploymentReceipt) error { return nil }}
	a := &desktopAgent{home: home, directory: directory, systemd: s}
	var r desktopDeploymentReceipt
	if err := json.Unmarshal([]byte(`{"version":1,"phase":"complete","input":{"accountId":"0123456789abcdef0123456789abcdef","zoneId":"1123456789abcdef0123456789abcdef","tunnelId":"b647d93a-639b-443b-81ad-a7be3a887666","hostname":"fixture.example.com","port":8899,"email":"owner@example.com"},"local":{"unit":"# Managed by Codex Remote Web setup v1\n[Service]\nExecStart=:/fixture/bun run dist/server.js\n","environment":"HOST=\"127.0.0.1\"\nPORT=\"8899\"\n"},"probe":"synthetic-test-probe","aud":"aud","teamDomain":"fixture.cloudflareaccess.com"}`), &r); err != nil {
		t.Fatal(err)
	}
	if err := a.cloudSave(&r); err != nil {
		t.Fatal(err)
	}
	if err := writeSystemdOwned(s.unitPath(setupSystemdService), r.Local.Unit); err != nil {
		t.Fatal(err)
	}
	if err := writeSystemdOwned(s.envPath(), r.Local.Environment); err != nil {
		t.Fatal(err)
	}
	return a, &r
}

func TestHeadlessSystemdMigrationRollsBackAndRecovers(t *testing.T) {
	a, old := systemdLegacyFixture(t)
	s := a.systemd
	journal := filepath.Join(a.directory, "setup-systemd-migration.json")
	failed := true
	var probes []string
	s.ready = func(_ context.Context, receipt *desktopDeploymentReceipt) error {
		if _, err := os.Stat(journal); err != nil {
			t.Fatal("Unit was switched before recording migration intent", err)
		}
		probes = append(probes, receipt.Local.Unit)
		assertSystemdFile(t, s.unitPath(setupSystemdService), receipt.Local.Unit)
		stored, err := a.readDeployment()
		if err != nil || !cloudSame(stored, old) {
			t.Fatal("Receipt was committed before the readiness probe", err)
		}
		if failed && receipt.Local.Unit == s.nativeUnit() {
			return errors.New("synthetic gateway readiness failure")
		}
		return nil
	}
	if err := a.migrateSystemd(t.Context()); err == nil || len(probes) != 2 || probes[1] != old.Local.Unit {
		t.Fatalf("Migration did not roll back: %v (%d probes)", err, len(probes))
	}
	assertSystemdFile(t, s.unitPath(setupSystemdService), old.Local.Unit)
	assertSystemdFile(t, s.envPath(), old.Local.Environment)
	if _, err := os.Lstat(journal); !os.IsNotExist(err) {
		t.Fatal("Completed rollback retained an intent", err)
	}
	next := cloudClone(old)
	next.Local.Unit = s.nativeUnit()
	if err := writeDesktopJSON(journal, systemdMigration{Version: 1, Before: old, After: next}); err != nil {
		t.Fatal(err)
	}
	if err := writeSystemdOwned(s.unitPath(setupSystemdService), next.Local.Unit+"# edited during migration\n"); err != nil {
		t.Fatal(err)
	}
	if err := a.migrateSystemd(t.Context()); err == nil {
		t.Fatal("Recovery overwrote a service unit after it was edited")
	}
	assertSystemdFile(t, s.unitPath(setupSystemdService), next.Local.Unit+"# edited during migration\n")
	if err := writeSystemdOwned(s.unitPath(setupSystemdService), next.Local.Unit); err != nil {
		t.Fatal(err)
	}
	failed = false
	if err := a.migrateSystemd(t.Context()); err != nil {
		t.Fatal(err)
	}
	stored, err := a.readDeployment()
	if err != nil || !cloudSame(stored, next) || strings.Contains(stored.Local.Unit, "/fixture/bun") {
		t.Fatal("Native migration not committed", err)
	}
	assertSystemdFile(t, s.envPath(), old.Local.Environment)
}

func TestHeadlessSystemdInstallReadinessAndEditedEnvironment(t *testing.T) {
	a, old := systemdLegacyFixture(t)
	s := a.systemd
	for _, path := range []string{s.envPath(), s.unitPath(setupSystemdService)} {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	var operations []string
	s.run = func(args ...string) error { operations = append(operations, strings.Join(args, " ")); return nil }
	s.ready = func(_ context.Context, r *desktopDeploymentReceipt) error {
		if strings.Join(operations, ",") != "daemon-reload,enable --now codex-remote-web.service" {
			t.Fatalf("Readiness ran before service startup: %v", operations)
		}
		assertSystemdFile(t, s.envPath(), r.Local.Environment)
		return nil
	}
	old.Local = nil
	if err := s.install(t.Context(), old, func() error {
		if _, err := os.Lstat(s.envPath()); !os.IsNotExist(err) || old.Local.Unit != s.nativeUnit() {
			t.Fatal("Install must persist the receipt before writing local files")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := writeSystemdOwned(s.envPath(), old.Local.Environment+"# personal settings\n"); err != nil {
		t.Fatal(err)
	}
	if err := s.removeService(old.Local); err == nil || len(operations) != 2 {
		t.Fatal("Cleanup changed the systemd service after the environment was edited")
	}
	assertSystemdFile(t, s.envPath(), old.Local.Environment+"# personal settings\n")
}

func TestHeadlessMigrationRequiresLoopbackSessionAndCSRF(t *testing.T) {
	a, _ := systemdLegacyFixture(t)
	s := &setupHTTP{managed: a, standalone: true}
	request := func(path, host, address, csrf, cookie, payload string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "http://"+host+"/api/setup/"+path, strings.NewReader(payload))
		r.RemoteAddr = address
		r.Header.Set("Origin", "http://"+host)
		r.Header.Set("X-Setup-Request", "1")
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Setup-Csrf", csrf)
		if cookie != "" {
			r.Header.Set("Cookie", cookie)
		}
		w := httptest.NewRecorder()
		if !s.handle(w, r) {
			t.Fatal("Managed route was not handled")
		}
		return w
	}
	const host, local = "127.0.0.1:8899", "127.0.0.1:12345"
	if w := request("migrate", host, "192.0.2.10:12345", "", "", `{}`); w.Code != 403 {
		t.Fatalf("Remote request reached migration: %d", w.Code)
	}
	if w := request("migrate", host, local, "", "", `{}`); w.Code != 401 {
		t.Fatalf("Unauthenticated request reached migration: %d", w.Code)
	}
	key := s.issue()
	unlock := request("session", host, local, "", "", `{"key":"`+key+`"}`)
	if unlock.Code != 200 || len(unlock.Result().Cookies()) != 1 {
		t.Fatalf("Unlock failed: %d", unlock.Code)
	}
	cookie := unlock.Result().Cookies()[0]
	cookieText := cookie.Name + "=" + cookie.Value
	if w := request("migrate", host, local, "", cookieText, `{}`); w.Code != 403 {
		t.Fatalf("Missing CSRF check: %d", w.Code)
	}
	var response struct{ CSRF string }
	if err := json.Unmarshal(unlock.Body.Bytes(), &response); err != nil || response.CSRF == "" {
		t.Fatal("No CSRF value", err)
	}
	if w := request("migrate", host, local, response.CSRF, cookieText, `{}`); w.Code != 202 {
		t.Fatalf("Valid request did not start migration: %d, %s", w.Code, w.Body.String())
	}
	a.closeSetup()
	if a.setupStatus()["phase"] != "complete" {
		t.Fatalf("Authenticated migration failed: %v", a.setupStatus()["error"])
	}
}
