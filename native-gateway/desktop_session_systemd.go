package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const desktopLinuxSessionUnit = "codex-remote-web-desktop.service"
const desktopLinuxSessionTail = "Restart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nKillMode=control-group\nUMask=0077\n[Install]\nWantedBy=graphical-session.target\n"

var desktopLinuxDisplayKeys = []string{"DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"}
var desktopLinuxDisplayLine = regexp.MustCompile(`^Environment="(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR)=(?:[^"\\\r\n\x00]|\\["\\])*"$`)

func desktopLinuxSessionDefinition(home, executable string, getenv func(string) string) desktopRegistration {
	quote := func(value string) string {
		return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%", "$", "$$").Replace(value) + `"`
	}
	var content strings.Builder
	content.WriteString("# Managed by Codex Remote Web desktop v1\n[Unit]\nDescription=Codex Remote Web desktop gateway\nPartOf=graphical-session.target\nAfter=graphical-session.target\nStartLimitIntervalSec=60\nStartLimitBurst=3\n[Service]\nExecStart=" + quote(executable) + ` "--background-agent"` + "\n")
	for _, key := range desktopLinuxDisplayKeys {
		if value := getenv(key); value != "" && !strings.ContainsAny(value, "\x00\r\n") {
			content.WriteString("Environment=" + quote(key+"="+value) + "\n")
		}
	}
	content.WriteString(desktopLinuxSessionTail)
	return desktopRegistration{Executable: executable, Platform: "linux", Path: filepath.Join(home, ".config", "systemd", "user", desktopLinuxSessionUnit), Content: content.String()}
}

func desktopLinuxSessionContentOwned(saved, expected string) bool {
	end := strings.Index(expected, "\nExecStart=")
	if end < 0 {
		return false
	}
	end += 1 + strings.Index(expected[end+1:], "\n") + 1
	block, ok := strings.CutPrefix(saved, expected[:end])
	if !ok {
		return false
	}
	block, ok = strings.CutSuffix(block, desktopLinuxSessionTail)
	if !ok || block == "" {
		return ok
	}
	block, ok = strings.CutSuffix(block, "\n")
	if !ok {
		return false
	}
	previous := -1
	for _, line := range strings.Split(block, "\n") {
		match := desktopLinuxDisplayLine.FindStringSubmatch(line)
		if match == nil {
			return false
		}
		for i, key := range desktopLinuxDisplayKeys {
			if key == match[1] {
				if i <= previous {
					return false
				}
				previous = i
				break
			}
		}
	}
	return true
}

func systemdOwnedDirectory(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() || !desktopOwned(path, info) {
		return false, desktopFailure(409, "SESSION_CHANGED", "Unsafe systemd user directory; preserve it")
	}
	return true, nil
}

func systemdEnablement(unitPath, target string) (link, literal string, err error) {
	wants := filepath.Join(filepath.Dir(unitPath), target+".wants")
	link = filepath.Join(wants, filepath.Base(unitPath))
	if exists, err := systemdOwnedDirectory(wants); err != nil || !exists {
		return link, "", err
	}
	info, err := os.Lstat(link)
	if errors.Is(err, os.ErrNotExist) {
		return link, "", nil
	}
	if err != nil {
		return link, "", err
	}
	if info.Mode()&os.ModeSymlink != 0 && desktopOwned(link, info) {
		literal, err = os.Readlink(link)
		if err != nil {
			return link, "", err
		}
		resolved := literal
		if !filepath.IsAbs(resolved) {
			resolved = filepath.Join(wants, resolved)
		}
		if filepath.Clean(resolved) == unitPath {
			return link, literal, nil
		}
	}
	return link, "", desktopFailure(409, "SESSION_CHANGED", "Systemd enablement changed; preserve it")
}

func desktopSystemdLoginOnline() (bool, error) {
	runtimeDirectory := os.Getenv("XDG_RUNTIME_DIR")
	if runtimeDirectory == "" {
		runtimeDirectory = fmt.Sprintf("/run/user/%d", os.Getuid())
	}
	_, err := os.Lstat(filepath.Join(runtimeDirectory, "bus"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func (s desktopSession) mutateLinuxSession(enabled bool, spec desktopRegistration, saved *desktopRegistration, recordPath string) error {
	if !enabled && saved == nil {
		return nil
	}
	path := s.definition().Path
	if spec.Path != path || !spec.ownedBy(s.definition()) || saved != nil && saved.Path != path {
		return desktopFailure(409, "SESSION_CHANGED", "Background registration path changed; preserve it")
	}
	parent := filepath.Dir(path)
	if _, err := systemdOwnedDirectory(parent); err != nil {
		return err
	}
	current, err := readDesktopFile(path, false)
	if err != nil {
		return err
	}
	if current != nil && (saved == nil || string(current) != saved.Content) {
		return desktopFailure(409, "SESSION_CHANGED", "Background registration file changed; preserve it")
	}
	link, oldTarget, err := systemdEnablement(path, "graphical-session.target")
	if err != nil {
		return err
	}
	if enabled && oldTarget != "" && string(current) == spec.Content && desktopRegistrationMatches(saved, &spec) {
		return nil
	}
	online, err := desktopSystemdLoginOnline()
	if err != nil {
		return err
	}
	apply := func() error {
		if enabled {
			if err := os.MkdirAll(parent, 0700); err != nil {
				return err
			}
			if _, err := systemdOwnedDirectory(parent); err != nil {
				return err
			}
			if err := writeDesktopFile(path, []byte(spec.Content)); err != nil {
				return err
			}
			if err := s.run("--user", "daemon-reload"); err != nil {
				return err
			}
			if err := s.run("--user", "enable", desktopLinuxSessionUnit); err != nil {
				return err
			}
			return writeDesktopJSON(recordPath, spec)
		}
		// Preserve the current user agent: never use --now when disabling startup.
		if online {
			if err := s.run("--user", "--no-reload", "disable", desktopLinuxSessionUnit); err != nil {
				return err
			}
		} else {
			if err := removeDesktopFile(recordPath); err != nil {
				return err
			}
			if oldTarget != "" {
				if err := removeDesktopFile(link); err != nil {
					return err
				}
			}
		}
		if err := removeDesktopFile(path); err != nil {
			return err
		}
		if online {
			if err := s.run("--user", "daemon-reload"); err != nil {
				return err
			}
		}
		return removeDesktopFile(recordPath)
	}
	if err := apply(); err != nil {
		rollback := func() error {
			actual, err := readDesktopFile(path, false)
			if err != nil {
				return err
			}
			var intended []byte
			if enabled {
				intended = []byte(spec.Content)
			}
			if !bytes.Equal(actual, current) {
				if !bytes.Equal(actual, intended) {
					return errors.New("Background registration changed during rollback")
				}
				if current == nil {
					err = removeDesktopFile(path)
				} else if actual == nil {
					err = restoreSystemdFileExclusive(path, current)
				} else {
					err = writeDesktopFile(path, current)
				}
				if err != nil {
					return err
				}
			}
			_, target, err := systemdEnablement(path, "graphical-session.target")
			if err != nil {
				return err
			}
			if target != oldTarget {
				if target != "" && oldTarget != "" {
					return errors.New("Background enablement changed during rollback")
				}
				if oldTarget == "" {
					if err := removeDesktopFile(link); err != nil {
						return err
					}
				} else if err := os.Symlink(oldTarget, link); err != nil {
					return err
				} else if err := syncDesktopDirectory(filepath.Dir(link)); err != nil {
					return err
				}
			}
			if online {
				if err := s.run("--user", "daemon-reload"); err != nil {
					return err
				}
			}
			var intendedRecord *desktopRegistration
			if enabled {
				intendedRecord = &spec
			}
			return restoreDesktopSessionRecord(recordPath, saved, intendedRecord)
		}
		if rollbackErr := rollback(); rollbackErr != nil {
			return desktopFailure(500, "SESSION_RECOVERY", "The login item could not be restored. Preserve the startup settings and retry.")
		}
		return err
	}
	return nil
}

func restoreSystemdFileExclusive(path string, content []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(content)
	err = errors.Join(writeErr, file.Sync(), file.Close())
	if err != nil {
		return err
	}
	return syncDesktopDirectory(filepath.Dir(path))
}
