package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const desktopSessionLabel = "io.github.danvilig.codex-remote-web.desktop-agent"

type desktopRegistration struct {
	Executable string   `json:"executable,omitempty"`
	Args       []string `json:"args,omitempty"`
	Platform   string   `json:"platform"`
	Path       string   `json:"path,omitempty"`
	Content    string   `json:"content,omitempty"`
	Name       string   `json:"name,omitempty"`
	Arguments  string   `json:"arguments,omitempty"`
}

func desktopSessionDefinition(home, installation string) desktopRegistration {
	xml := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&apos;")
	return desktopRegistration{
		Platform: "darwin", Executable: installation, Args: []string{},
		Path: filepath.Join(home, "Library", "LaunchAgents", desktopSessionLabel+".plist"),
		Content: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>` + desktopSessionLabel +
			`</string><key>ProgramArguments</key><array><string>` + xml.Replace(installation) + `</string><string>--background-agent</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>20</integer></dict></plist>` + "\n",
	}
}

func (r *desktopRegistration) ownedBy(expected desktopRegistration) bool {
	if r == nil || r.Platform != expected.Platform || r.Path != expected.Path ||
		(r.Executable != "" && r.Executable != expected.Executable) || len(r.Args) != 0 {
		return false
	}
	switch expected.Platform {
	case "linux":
		return r.Name == "" && r.Arguments == "" && desktopLinuxSessionContentOwned(r.Content, expected.Content)
	case "win32":
		return r.Executable == expected.Executable && r.Name == expected.Name && r.Arguments == expected.Arguments && r.Content == ""
	default:
		return r.Name == "" && r.Arguments == "" && r.Content == expected.Content
	}
}

type desktopSession struct {
	home, directory, installation string
	platform                      string
	run                           func(...string) error
	windows                       desktopWindowsSessionRunner
}

func newDesktopSession(home, directory, installation string) desktopSession {
	return desktopSession{home: home, directory: directory, installation: installation, platform: runtime.GOOS, windows: runDesktopWindowsSessionCommand, run: func(args ...string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		binary, message := "/bin/launchctl", "macOS could not update the login item. Check that the application is running in your login session."
		if runtime.GOOS == "linux" {
			binary, message = "systemctl", "Could not update the login item. Check the systemd user session."
		}
		if _, err := desktopExec(ctx, binary, args, os.Environ(), "", 64<<10); err != nil {
			return desktopFailure(400, "SESSION_MANAGER", message)
		}
		return nil
	}}
}

func (s desktopSession) definition() desktopRegistration {
	switch s.platform {
	case "linux":
		return desktopLinuxSessionDefinition(s.home, s.installation, os.Getenv)
	case "windows":
		return desktopWindowsSessionDefinition(s.home, s.installation)
	default:
		return desktopSessionDefinition(s.home, s.installation)
	}
}

type desktopSessionRevision struct {
	generation string
	record     *desktopRegistration
}

type desktopSessionSnapshot struct {
	Previous   *desktopRegistration `json:"previous"`
	Current    *desktopRegistration `json:"current"`
	Generation *string              `json:"generation"`
	Skipped    bool                 `json:"skipped,omitempty"`
}

var desktopGenerationPattern = regexp.MustCompile(`^[0-9a-f-]{36}$`)

func desktopGeneration() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}

func desktopRegistrationMatches(got, expected *desktopRegistration) bool {
	if got == nil || expected == nil {
		return got == expected
	}
	a, _ := json.Marshal(got)
	b, _ := json.Marshal(expected)
	return string(a) == string(b)
}

func (s desktopSession) configure(enabled, ownedOnly bool) (func() error, error) {
	definition := s.definition()
	restore, _, err := s.configureRegistration(enabled, ownedOnly, definition, nil)
	return restore, err
}

func (s desktopSession) configureRegistration(enabled, ownedOnly bool, definition desktopRegistration, expected *desktopSessionRevision) (func() error, desktopSessionSnapshot, error) {
	var snapshot desktopSessionSnapshot
	if err := ensureDesktopDirectory(s.directory); err != nil {
		return nil, snapshot, err
	}
	release, err := lockDesktop(s.directory, "session-lock", 5*time.Second)
	if err != nil {
		return nil, snapshot, err
	}
	defer release()
	recordPath := filepath.Join(s.directory, "session.json")
	generationPath := filepath.Join(s.directory, "session-generation.json")
	var generation string
	if found, err := readDesktopJSON(generationPath, &generation); err != nil || found && !desktopGenerationPattern.MatchString(generation) {
		return nil, snapshot, desktopFailure(400, "SESSION_STATE_INVALID", "Background registration generation is invalid; preserve it")
	}
	if err := s.recoverWindowsSession(recordPath); err != nil {
		return nil, snapshot, err
	}
	var saved *desktopRegistration
	if found, err := readDesktopJSON(recordPath, &saved); err != nil || found && !saved.valid() {
		return nil, snapshot, desktopFailure(400, "SESSION_STATE_INVALID", "Background registration state is invalid; preserve it")
	}
	if expected != nil && (expected.generation != generation || !desktopRegistrationMatches(saved, expected.record)) {
		return nil, snapshot, desktopFailure(409, "SESSION_CHANGED", "Background registration changed before rollback; preserve it")
	}
	snapshot.Previous, snapshot.Current = saved, saved
	if generation != "" {
		snapshot.Generation = &generation
	}
	if saved != nil && !saved.ownedBy(s.definition()) {
		if !enabled && ownedOnly {
			snapshot.Skipped = true
			return func() error { return nil }, snapshot, nil
		}
		return nil, snapshot, desktopFailure(409, "SESSION_CHANGED", "Background registration belongs to another installation; preserve it")
	}
	if ownedOnly && saved == nil {
		snapshot.Skipped = true
		return func() error { return nil }, snapshot, nil
	}
	nextGeneration, err := desktopGeneration()
	if err != nil {
		return nil, snapshot, err
	}
	if err := writeDesktopJSON(generationPath, nextGeneration); err != nil {
		return nil, snapshot, err
	}
	if err := s.mutate(enabled, definition, saved, recordPath); err != nil {
		return nil, snapshot, err
	}
	var current *desktopRegistration
	if _, err := readDesktopJSON(recordPath, &current); err != nil {
		return nil, snapshot, err
	}
	snapshot.Current, snapshot.Generation = current, &nextGeneration
	return func() error {
		restored := definition
		if saved != nil {
			restored = *saved
		}
		_, _, err := s.configureRegistration(saved != nil, false, restored, &desktopSessionRevision{generation: nextGeneration, record: current})
		return err
	}, snapshot, nil
}

func runDesktopSessionConfigure(input io.Reader, output io.Writer) error {
	value, err := desktopSessionConfigureInput(input)
	if err != nil {
		failure := desktopSafeError(err)
		if encodeErr := json.NewEncoder(output).Encode(failure); encodeErr != nil {
			return encodeErr
		}
		return failure
	}
	return json.NewEncoder(output).Encode(map[string]any{"snapshot": value})
}

func desktopSessionConfigureInput(input io.Reader) (desktopSessionSnapshot, error) {
	invalid := desktopFailure(400, "", "Invalid background registration request")
	var snapshot desktopSessionSnapshot
	data, err := io.ReadAll(io.LimitReader(input, desktopStateLimit+1))
	if err != nil || len(data) > desktopStateLimit {
		return snapshot, invalid
	}
	var request struct {
		Enabled *bool `json:"enabled"`
		Options struct {
			Directory            string               `json:"directory"`
			Executable           string               `json:"executable"`
			Args                 []string             `json:"args"`
			Definition           *desktopRegistration `json:"definition"`
			ExpectedInstallation string               `json:"expectedInstallation"`
			ExpectedRegistration json.RawMessage      `json:"expectedRegistration"`
			ExpectedGeneration   json.RawMessage      `json:"expectedGeneration"`
		} `json:"options"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || request.Enabled == nil {
		return snapshot, invalid
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return snapshot, err
	}
	o := request.Options
	if !validDesktopPath(o.Executable) || o.Directory != desktopDirectory(home) || len(o.Args) != 0 || o.ExpectedInstallation != "" && o.ExpectedInstallation != o.Executable {
		return snapshot, invalid
	}
	session := newDesktopSession(home, o.Directory, o.Executable)
	definition := session.definition()
	if o.Definition != nil {
		if !o.Definition.ownedBy(definition) {
			return snapshot, invalid
		}
		definition = *o.Definition
	}
	var revision *desktopSessionRevision
	if len(o.ExpectedGeneration) > 0 || len(o.ExpectedRegistration) > 0 {
		revision = new(desktopSessionRevision)
		if json.Unmarshal(o.ExpectedGeneration, &revision.generation) != nil || json.Unmarshal(o.ExpectedRegistration, &revision.record) != nil {
			return snapshot, invalid
		}
	}
	_, snapshot, err = session.configureRegistration(*request.Enabled, o.ExpectedInstallation != "", definition, revision)
	return snapshot, err
}

func (s desktopSession) mutate(enabled bool, spec desktopRegistration, saved *desktopRegistration, recordPath string) error {
	switch spec.Platform {
	case "linux":
		return s.mutateLinuxSession(enabled, spec, saved, recordPath)
	case "win32":
		return s.mutateWindowsSession(enabled, spec, saved, recordPath)
	default:
		return s.mutateDarwinSession(enabled, spec, saved, recordPath)
	}
}

func (r *desktopRegistration) valid() bool {
	if r == nil {
		return false
	}
	switch r.Platform {
	case "darwin", "linux":
		return r.Path != "" && r.Content != ""
	case "win32":
		return r.Name != "" && r.Executable != "" && r.Arguments != ""
	default:
		return false
	}
}

func (s desktopSession) mutateDarwinSession(enabled bool, spec desktopRegistration, saved *desktopRegistration, recordPath string) error {
	if !enabled && saved == nil {
		return nil
	}
	path := spec.Path
	if path != desktopSessionDefinition(s.home, s.installation).Path || saved != nil && saved.Path != path {
		return desktopFailure(409, "SESSION_CHANGED", "Background registration path changed; preserve it")
	}
	parent := filepath.Dir(path)
	if info, err := os.Lstat(parent); err == nil {
		if !info.IsDir() || !desktopOwned(parent, info) {
			return errors.New("Unsafe background registration directory")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	current, err := readDesktopFile(path, false)
	if err != nil {
		return err
	}
	if current != nil && (saved == nil || string(current) != saved.Content) {
		return desktopFailure(409, "SESSION_CHANGED", "Background registration file changed; preserve it")
	}
	if enabled && desktopRegistrationMatches(saved, &spec) && string(current) == spec.Content {
		return nil
	}
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	service := domain + "/" + desktopSessionLabel
	apply := func() error {
		if !enabled {
			if err := removeDesktopFile(path); err != nil {
				return err
			}
			// Disable future launches without interrupting the current session.
			if err := s.run("disable", service); err != nil {
				return err
			}
			return removeDesktopFile(recordPath)
		}
		if err := os.MkdirAll(parent, 0700); err != nil {
			return err
		}
		if info, err := os.Lstat(parent); err != nil || !info.IsDir() || !desktopOwned(parent, info) {
			return errors.New("Unsafe background registration directory")
		}
		if err := writeDesktopFile(path, []byte(spec.Content)); err != nil {
			return err
		}
		if err := s.run("enable", service); err != nil {
			return err
		}
		_ = s.run("bootout", service)
		if err := s.run("bootstrap", domain, path); err != nil {
			return err
		}
		return writeDesktopJSON(recordPath, spec)
	}
	if err := apply(); err != nil {
		restore := func() error {
			if current == nil {
				if err := removeDesktopFile(path); err != nil {
					return err
				}
			} else if err := writeDesktopFile(path, current); err != nil {
				return err
			}
			if saved == nil {
				_ = s.run("bootout", service)
				if err := s.run("disable", service); err != nil {
					return err
				}
				return removeDesktopFile(recordPath)
			}
			if err := s.run("enable", service); err != nil {
				return err
			}
			if current != nil {
				_ = s.run("bootout", service)
				if err := s.run("bootstrap", domain, path); err != nil {
					return err
				}
			}
			return writeDesktopJSON(recordPath, saved)
		}
		if rollbackErr := restore(); rollbackErr != nil {
			return desktopFailure(500, "SESSION_RECOVERY", "The login item could not be restored. Preserve the startup settings and retry.")
		}
		return err
	}
	return nil
}
