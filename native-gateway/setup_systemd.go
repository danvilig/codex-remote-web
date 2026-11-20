package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const setupSystemdMarker = "# Managed by Codex Remote Web setup v1\n"
const setupSystemdService = "codex-remote-web.service"
const setupSystemdConnector = "codex-remote-web-tunnel.service"

type headlessSystemd struct {
	home, directory, binary, root string
	run                           func(...string) error
	readCommand                   func(string, ...string) ([]byte, error)
	ready                         func(context.Context, *desktopDeploymentReceipt) error
}

func newHeadlessSetup(home, root string) *desktopAgent {
	if runtime.GOOS != "linux" {
		return nil
	}
	binary, err := os.Executable()
	if err != nil {
		return nil
	}
	if resolved, err := filepath.EvalSymlinks(binary); err == nil {
		binary = resolved
	}
	directory := filepath.Join(home, ".config", "codex-remote-web")
	s := &headlessSystemd{home: home, directory: directory, binary: binary, root: root, ready: cloudProtectedReady}
	s.run = func(args ...string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if _, err := desktopExec(ctx, "systemctl", append([]string{"--user"}, args...), os.Environ(), root, 64<<10); err != nil {
			return desktopFailure(500, "SYSTEMD", "Could not update the service. Check the systemd user session.")
		}
		return nil
	}
	s.readCommand = func(binary string, args ...string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
		defer cancel()
		return desktopExec(ctx, binary, args, os.Environ(), root, 512000)
	}
	return &desktopAgent{home: home, directory: directory, binary: binary, systemd: s}
}

func (s *headlessSystemd) envPath() string   { return filepath.Join(s.directory, "remote.env") }
func (s *headlessSystemd) tokenPath() string { return filepath.Join(s.directory, "tunnel-token") }
func (s *headlessSystemd) unitPath(unit string) string {
	return filepath.Join(s.home, ".config", "systemd", "user", unit)
}

func readSystemdOwned(path string, private bool) ([]byte, error) {
	if _, err := systemdOwnedDirectory(filepath.Dir(path)); err != nil {
		return nil, err
	}
	return readDesktopFile(path, private)
}

func writeSystemdOwned(path, value string) error {
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0700); err != nil {
		return err
	}
	if _, err := systemdOwnedDirectory(parent); err != nil {
		return err
	}
	return writeDesktopFile(path, []byte(value))
}

func installSystemdFile(path, value string) error {
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0700); err != nil {
		return err
	}
	if _, err := systemdOwnedDirectory(parent); err != nil {
		return err
	}
	file, err := os.CreateTemp(parent, ".codex-systemd-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.WriteString(value)
	if err := errors.Join(writeErr, file.Sync(), file.Close()); err != nil {
		return err
	}
	if err := os.Link(file.Name(), path); err != nil {
		return err
	}
	if err := os.Remove(file.Name()); err != nil {
		return err
	}
	return syncDesktopDirectory(parent)
}

func (s *headlessSystemd) preflight(port int, current *desktopDeploymentReceipt) error {
	for _, path := range []string{s.root, s.binary, s.envPath()} {
		if !validDesktopPath(path) || strings.TrimSpace(path) != path || strings.ContainsAny(path, "\v\f\t") {
			return cloudConflict("The installation path cannot be used by systemd.")
		}
	}
	if err := s.run("show-environment"); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(s.root, "public", "index.html")); err != nil {
		return cloudConflict("Production assets are missing. Reinstall the native package.")
	}
	if current != nil {
		if err := s.assertOwned(current.Local); err != nil {
			return err
		}
	} else {
		for _, path := range []string{s.envPath(), s.unitPath(setupSystemdService)} {
			if value, err := readSystemdOwned(path, false); err != nil || value != nil {
				return cloudConflict("An existing local service or environment was found. Preserve it before setting up a managed service.")
			}
		}
		if _, target, err := systemdEnablement(s.unitPath(setupSystemdService), "default.target"); err != nil || target != "" {
			return cloudConflict("An existing service enablement was found. Preserve it before setting up a managed service.")
		}
	}
	if current == nil || current.Input.Port != port {
		probe, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			return cloudConflict("The local service port is already in use.")
		}
		probe.Close()
	}
	return nil
}

func systemdEnvQuote(value string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, `$`, `\$`, "`", "\\`").Replace(value) + `"`
}

func systemdUnitArgument(value string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`).Replace(value) + `"`
}

func (s *headlessSystemd) nativeUnit() string {
	escape := func(value string) string { return strings.ReplaceAll(value, "%", "%%") }
	return setupSystemdMarker + "[Unit]\nDescription=Codex Remote Web\nAfter=network-online.target\nStartLimitIntervalSec=60\nStartLimitBurst=3\n[Service]\nType=simple\nWorkingDirectory=" + escape(s.root) + "\nEnvironmentFile=" + escape(s.envPath()) + "\nExecStart=:" + systemdUnitArgument(s.binary) + " --assets " + systemdUnitArgument(s.root) + "\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=10\nKillMode=mixed\nUMask=0077\n[Install]\nWantedBy=default.target\n"
}

func (s *headlessSystemd) install(ctx context.Context, r *desktopDeploymentReceipt, persist func() error) error {
	values := map[string]string{"HOME": s.home, "PATH": os.Getenv("PATH"), "CODEX_HOME": getenvDefault("CODEX_HOME", filepath.Join(s.home, ".codex")), "CODEX_WEBUI_APP_SERVER_MODE": getenvDefault("CODEX_WEBUI_APP_SERVER_MODE", "shared")}
	for key, value := range environmentMap(os.Environ()) {
		if key == "CODEX_AUTH_PATH" || strings.HasPrefix(key, "CODEX_WEBUI_") {
			switch key {
			case "CODEX_WEBUI_PASSWORD", "CODEX_WEBUI_ACCESS_TOKEN", "CODEX_WEBUI_AUTH_STORE", "CODEX_WEBUI_DESKTOP_CHILD", "CODEX_WEBUI_DESKTOP_SETUP_CAPABILITY":
				continue
			}
			values[key] = value
		}
	}
	r.Probe = randomSecret(32)
	values["HOST"], values["PORT"], values["CODEX_WEBUI_AUTH_MODE"] = "127.0.0.1", fmt.Sprint(r.Input.Port), "cloudflare-access"
	values["CODEX_WEBUI_PUBLIC_ORIGIN"], values["CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL"] = "https://"+r.Input.Hostname, r.Input.Email
	values["CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN"], values["CODEX_WEBUI_CF_ACCESS_AUD"], values["CODEX_WEBUI_SETUP_PROBE"] = r.TeamDomain, r.AUD, r.Probe
	values["CODEX_WEBUI_CWD"] = getenvDefault("CODEX_WEBUI_CWD", s.root)
	values["CODEX_WEBUI_REVIEW_ROOT"] = getenvDefault("CODEX_WEBUI_REVIEW_ROOT", values["CODEX_WEBUI_CWD"])
	keys := make([]string, 0, len(values))
	for key, value := range values {
		if !systemdEnvironmentKey.MatchString(key) || strings.ContainsAny(value, "\x00\r\n") {
			return cloudConflict("A gateway setting cannot be written to the systemd environment.")
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var environment strings.Builder
	for _, key := range keys {
		fmt.Fprintf(&environment, "%s=%s\n", key, systemdEnvQuote(values[key]))
	}
	r.Local = &desktopOwnedEnvironment{Environment: environment.String(), Unit: s.nativeUnit()}
	if err := persist(); err != nil {
		return err
	}
	if err := installSystemdFile(s.envPath(), r.Local.Environment); err != nil {
		return err
	}
	if err := installSystemdFile(s.unitPath(setupSystemdService), r.Local.Unit); err != nil {
		return err
	}
	if err := s.run("daemon-reload"); err != nil {
		return err
	}
	if err := s.run("enable", "--now", setupSystemdService); err != nil {
		return err
	}
	return s.ready(ctx, r)
}

var systemdEnvironmentKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func validSystemdEnvironment(local *desktopOwnedEnvironment) bool {
	return local != nil && local.Owner == "" && strings.HasPrefix(local.Unit, setupSystemdMarker) && local.Environment != ""
}

func (s *headlessSystemd) assertOwned(local *desktopOwnedEnvironment, alternatives ...string) error {
	if validSystemdEnvironment(local) {
		unit, unitErr := readSystemdOwned(s.unitPath(setupSystemdService), false)
		value, envErr := readSystemdOwned(s.envPath(), true)
		_, _, linkErr := systemdEnablement(s.unitPath(setupSystemdService), "default.target")
		if unitErr == nil && envErr == nil && linkErr == nil && string(unit) == local.Unit {
			for _, expected := range append(alternatives, local.Environment) {
				if expected != "" && string(value) == expected {
					return nil
				}
			}
		}
	}
	return cloudConflict("Local service files changed. Automatic cleanup stopped to preserve your edits.")
}

func (s *headlessSystemd) updatedEnvironment(old, next *desktopDeploymentReceipt) (string, error) {
	values := map[string]string{"PORT": fmt.Sprint(next.Input.Port), "CODEX_WEBUI_PUBLIC_ORIGIN": "https://" + next.Input.Hostname, "CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN": next.TeamDomain, "CODEX_WEBUI_CF_ACCESS_AUD": next.AUD, "CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL": next.Input.Email}
	lines := strings.Split(old.Local.Environment, "\n")
	for index, line := range lines {
		key, _, _ := strings.Cut(line, "=")
		if value, ok := values[key]; ok {
			if strings.ContainsAny(value, "\x00\r\n") {
				return "", cloudConflict("The protected service has an invalid Access setting.")
			}
			lines[index] = key + "=" + systemdEnvQuote(value)
			delete(values, key)
		}
	}
	if len(values) != 0 {
		return "", cloudConflict("The managed service has an incomplete Access configuration.")
	}
	return strings.Join(lines, "\n"), nil
}

func (s *headlessSystemd) configure(ctx context.Context, r *desktopDeploymentReceipt, alternatives ...string) error {
	if err := s.assertOwned(r.Local, alternatives...); err != nil {
		return err
	}
	if err := writeSystemdOwned(s.envPath(), r.Local.Environment); err != nil {
		return err
	}
	if err := s.run("restart", setupSystemdService); err != nil {
		return err
	}
	return s.ready(ctx, r)
}

func (s *headlessSystemd) removeUnit(name string, unit []byte, expected string) error {
	path := s.unitPath(name)
	_, target, err := systemdEnablement(path, "default.target")
	if err != nil || unit == nil && target != "" || unit != nil && (expected == "" || string(unit) != expected) {
		return cloudConflict("Local service files changed. Automatic cleanup stopped to preserve your edits.")
	}
	if unit == nil {
		return nil
	}
	if err := s.run("disable", "--now", name); err != nil {
		return err
	}
	if err := removeDesktopFile(path); err != nil {
		return err
	}
	return s.run("daemon-reload")
}

func (s *headlessSystemd) removeService(local *desktopOwnedEnvironment) error {
	unit, unitErr := readSystemdOwned(s.unitPath(setupSystemdService), false)
	value, envErr := readSystemdOwned(s.envPath(), true)
	if !validSystemdEnvironment(local) || unitErr != nil || envErr != nil || value != nil && string(value) != local.Environment {
		return cloudConflict("Local service files changed. Automatic cleanup stopped to preserve your edits.")
	}
	if err := s.removeUnit(setupSystemdService, unit, local.Unit); err != nil {
		return err
	}
	return removeDesktopFile(s.envPath())
}

func (s *headlessSystemd) connectorBinary() (string, error) {
	binary := desktopExecutable("cloudflared", "", desktopPath(s.home))
	if !validDesktopPath(binary) {
		return "", cloudConflict("Install cloudflared on this machine before creating a Tunnel. Then refresh the preview.")
	}
	for _, path := range []string{s.unitPath(setupSystemdConnector), s.tokenPath()} {
		if value, err := readSystemdOwned(path, false); err != nil || value != nil {
			return "", cloudConflict("A dedicated connector already exists. Preserve it before creating another one.")
		}
	}
	if _, target, err := systemdEnablement(s.unitPath(setupSystemdConnector), "default.target"); err != nil || target != "" {
		return "", cloudConflict("A dedicated connector already exists. Preserve it before creating another one.")
	}
	return binary, nil
}

func (s *headlessSystemd) installConnector(binary, token string, r *desktopDeploymentReceipt, persist func() error) error {
	value := token + "\n"
	unit := setupSystemdMarker + "[Unit]\nDescription=Codex Remote Web Tunnel connector\nAfter=network-online.target\n[Service]\nType=simple\nExecStart=:" + systemdUnitArgument(binary) + " --no-autoupdate tunnel run --token-file " + systemdUnitArgument(s.tokenPath()) + "\nRestart=on-failure\nRestartSec=5\nUMask=0077\n[Install]\nWantedBy=default.target\n"
	r.Connector = &desktopOwnedConnector{Unit: unit, TokenDigest: fmt.Sprintf("%x", sha256.Sum256([]byte(value)))}
	if err := persist(); err != nil {
		return err
	}
	if err := installSystemdFile(s.tokenPath(), value); err != nil {
		return err
	}
	if err := installSystemdFile(s.unitPath(setupSystemdConnector), unit); err != nil {
		return err
	}
	if err := s.run("daemon-reload"); err != nil {
		return err
	}
	return s.run("enable", "--now", setupSystemdConnector)
}

func (s *headlessSystemd) removeConnector(connector *desktopOwnedConnector) error {
	unit, unitErr := readSystemdOwned(s.unitPath(setupSystemdConnector), false)
	token, tokenErr := readSystemdOwned(s.tokenPath(), true)
	if unitErr != nil || tokenErr != nil || !strings.HasPrefix(connector.Unit, setupSystemdMarker) || token != nil &&
		(connector.TokenDigest != "" && connector.TokenDigest != fmt.Sprintf("%x", sha256.Sum256(token)) || connector.TokenDigest == "" && unit == nil) {
		return cloudConflict("The dedicated connector files changed. Cleanup stopped to preserve the change.")
	}
	if err := s.removeUnit(setupSystemdConnector, unit, connector.Unit); err != nil {
		return err
	}
	return removeDesktopFile(s.tokenPath())
}

var systemdInvocation = regexp.MustCompile(`(?m)^InvocationID=([a-f0-9]{32})$`)
var systemdConnectorID = regexp.MustCompile(`(?i)Generated Connector ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b`)

func (s *headlessSystemd) connectorIDs() map[string]bool {
	var wait sync.WaitGroup
	var mutex sync.Mutex
	result := map[string]bool{}
	for _, user := range []bool{false, true} {
		for _, unit := range []string{"cloudflared.service", setupSystemdConnector} {
			wait.Go(func() {
				flag := []string{}
				if user {
					flag = []string{"--user"}
				}
				properties, err := s.readCommand("systemctl", append(flag, "show", unit, "-p", "InvocationID", "-p", "ActiveState")...)
				invocation := systemdInvocation.FindSubmatch(properties)
				if err != nil || len(invocation) != 2 || !strings.Contains("\n"+string(properties)+"\n", "\nActiveState=active\n") {
					return
				}
				logs, err := s.readCommand("journalctl", append(flag, "--no-pager", "-b", "-n", "500", "-o", "cat", "_SYSTEMD_INVOCATION_ID="+string(invocation[1]))...)
				if err == nil {
					mutex.Lock()
					for _, match := range systemdConnectorID.FindAllSubmatch(logs, -1) {
						result[strings.ToLower(string(match[1]))] = true
					}
					mutex.Unlock()
				}
			})
		}
	}
	wait.Wait()
	return result
}

type systemdMigration struct {
	Version int                       `json:"version"`
	Before  *desktopDeploymentReceipt `json:"before"`
	After   *desktopDeploymentReceipt `json:"after"`
}

func (a *desktopAgent) systemdMigrationStatus(r *desktopDeploymentReceipt) (required, pending bool) {
	if a.systemd == nil {
		return false, false
	}
	_, err := os.Lstat(filepath.Join(a.directory, "setup-systemd-migration.json"))
	pending = !errors.Is(err, os.ErrNotExist)
	required = r != nil && r.Phase == "complete" && validSystemdEnvironment(r.Local) && r.Local.Unit != a.systemd.nativeUnit()
	return required, pending
}

func (a *desktopAgent) migrateSystemd(ctx context.Context) error {
	s := a.systemd
	path := filepath.Join(a.directory, "setup-systemd-migration.json")
	var migration systemdMigration
	pending, err := readDesktopJSON(path, &migration)
	if err != nil {
		return err
	}
	r, err := a.readDeployment()
	if err != nil {
		return err
	}
	if pending {
		if migration.Version != 1 || r == nil || migration.Before == nil || migration.After == nil ||
			!validSystemdEnvironment(migration.Before.Local) || !validSystemdEnvironment(migration.After.Local) ||
			!(cloudSame(r, migration.Before) || cloudSame(r, migration.After)) {
			return cloudConflict("The migration record cannot be verified. Preserve the service files before proceeding.")
		}
		actual, err := readSystemdOwned(s.unitPath(setupSystemdService), false)
		if err != nil || string(actual) != migration.After.Local.Unit && string(actual) != migration.Before.Local.Unit {
			return cloudConflict("The service unit changed during migration. It was preserved.")
		}
		if cloudSame(r, migration.After) {
			if err := s.assertOwned(r.Local); err != nil {
				return err
			}
			if err := s.ready(ctx, r); err != nil {
				return err
			}
			return removeDesktopFile(path)
		}
		if err := s.restoreMigration(ctx, &migration, path); err != nil {
			return err
		}
	}
	if r == nil || r.Phase != "complete" || desktopPendingChange(r.IdentityChange) || desktopPendingChange(r.ConfigurationChange) || r.Probe == "" || !validCloudInput(r.Input, false) {
		return cloudConflict("Finish the existing managed deployment before migrating the service.")
	}
	if err := s.preflight(r.Input.Port, r); err != nil {
		return err
	}
	if r.Local.Unit == s.nativeUnit() {
		return s.ready(ctx, r)
	}
	next := cloudClone(r)
	next.Local.Unit = s.nativeUnit()
	migration = systemdMigration{Version: 1, Before: r, After: next}
	if err := writeDesktopJSON(path, migration); err != nil {
		return err
	}
	err = s.switchUnit(ctx, next)
	if err == nil {
		err = a.cloudSave(next)
	}
	if err != nil {
		actual, readErr := a.readDeployment()
		if readErr != nil || !cloudSame(actual, r) {
			return cloudConflict("The systemd migration result needs recovery. Retry migration after checking the service.")
		}
		if rollbackErr := s.restoreMigration(ctx, &migration, path); rollbackErr != nil {
			return cloudConflict("The previous service could not be restored. Preserve the migration record and retry recovery.")
		}
		return err
	}
	return removeDesktopFile(path)
}

func (s *headlessSystemd) switchUnit(ctx context.Context, r *desktopDeploymentReceipt) error {
	if err := writeSystemdOwned(s.unitPath(setupSystemdService), r.Local.Unit); err != nil {
		return err
	}
	if err := s.run("daemon-reload"); err != nil {
		return err
	}
	if err := s.run("restart", setupSystemdService); err != nil {
		return err
	}
	return s.ready(ctx, r)
}

func (s *headlessSystemd) restoreMigration(ctx context.Context, migration *systemdMigration, path string) error {
	before, after := migration.Before, migration.After
	if !cloudSame(before.Local.Environment, after.Local.Environment) || !cloudSame(before.Input, after.Input) {
		return cloudConflict("The migration record cannot be verified.")
	}
	if err := s.assertOwned(before.Local); err != nil {
		if err := s.assertOwned(after.Local); err != nil {
			return err
		}
	}
	if err := s.switchUnit(ctx, before); err != nil {
		return err
	}
	return removeDesktopFile(path)
}
