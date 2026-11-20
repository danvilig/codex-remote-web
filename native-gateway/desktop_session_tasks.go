package main

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
)

//go:embed windows-session.ps1
var desktopWindowsSessionScript string

type desktopWindowsTaskSnapshot struct {
	XML     string `json:"xml"`
	Enabled *bool  `json:"enabled"`
}

type desktopWindowsTaskTransaction struct {
	Version int                  `json:"version"`
	Spec    desktopRegistration  `json:"spec"`
	Saved   *desktopRegistration `json:"saved"`
	Enabled bool                 `json:"enabled"`
	Before  json.RawMessage      `json:"before"`
	After   json.RawMessage      `json:"after,omitempty"`
}

type desktopWindowsSessionRunner func(string, desktopWindowsTaskTransaction) (json.RawMessage, error)

func desktopWindowsSessionDefinition(home, executable string) desktopRegistration {
	name := sha256.Sum256([]byte(home))
	return desktopRegistration{Platform: "win32", Executable: executable, Name: fmt.Sprintf("Codex Remote Web Desktop %x", name[:6]), Arguments: `"--background-agent"`}
}

func runDesktopWindowsSessionCommand(operation string, transaction desktopWindowsTaskTransaction) (json.RawMessage, error) {
	root := os.Getenv("SystemRoot")
	if !filepath.IsAbs(root) {
		root = `C:\Windows`
	}
	binaryPath := filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	var script []byte
	for _, unit := range utf16.Encode([]rune(desktopWindowsSessionScript)) {
		script = binary.LittleEndian.AppendUint16(script, unit)
	}
	env := environmentMap(os.Environ())
	env["CRW_TASK_OPERATION"] = operation
	env["CRW_TASK_ENABLED"] = "0"
	if transaction.Enabled {
		env["CRW_TASK_ENABLED"] = "1"
	}
	for key, value := range map[string]any{"CRW_TASK_SPEC": transaction.Spec, "CRW_TASK_PREVIOUS": transaction.Saved, "CRW_TASK_BEFORE": transaction.Before, "CRW_TASK_AFTER": transaction.After} {
		data, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		env[key] = base64.StdEncoding.EncodeToString(data)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := desktopExec(ctx, binaryPath, []string{"-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(script)}, environmentList(env), "", desktopStateLimit)
	if err != nil {
		return nil, desktopFailure(400, "SESSION_MANAGER", "Windows could not update the login task. Check Task Scheduler and preserve any existing task.")
	}
	result := json.RawMessage(strings.TrimSpace(strings.TrimPrefix(string(out), "\uFEFF")))
	if _, ok := decodeWindowsSessionSnapshot(result); !ok {
		return nil, desktopFailure(500, "SESSION_MANAGER", "Windows returned an invalid login task snapshot")
	}
	return result, nil
}

func decodeWindowsSessionSnapshot(data json.RawMessage) (*desktopWindowsTaskSnapshot, bool) {
	var snapshot *desktopWindowsTaskSnapshot
	err := json.Unmarshal(data, &snapshot)
	return snapshot, err == nil && (snapshot == nil || snapshot.XML != "" && snapshot.Enabled != nil)
}

func windowsSessionSnapshotsMatch(a, b json.RawMessage) bool {
	first, ok := decodeWindowsSessionSnapshot(a)
	second, otherOK := decodeWindowsSessionSnapshot(b)
	return ok && otherOK && (first == nil && second == nil || first != nil && second != nil && first.XML == second.XML && *first.Enabled == *second.Enabled)
}

func restoreDesktopSessionRecord(path string, previous, intended *desktopRegistration) error {
	var current *desktopRegistration
	if _, err := readDesktopJSON(path, &current); err != nil {
		return err
	}
	if desktopRegistrationMatches(current, previous) {
		return nil
	}
	if !desktopRegistrationMatches(current, intended) {
		return desktopFailure(409, "SESSION_CHANGED", "Background registration changed before rollback; preserve it")
	}
	if previous == nil {
		return removeDesktopFile(path)
	}
	if current == nil {
		data, err := json.MarshalIndent(previous, "", "  ")
		if err != nil {
			return err
		}
		return restoreSystemdFileExclusive(path, append(data, '\n'))
	}
	return writeDesktopJSON(path, previous)
}

func windowsSessionRecoveryRequired() error {
	return desktopFailure(409, "SESSION_RECOVERY_REQUIRED", "Background task outcome is uncertain; preserve session-windows-pending.json and inspect the task before recovery")
}

func (s desktopSession) recoverWindowsSession(recordPath string) error {
	path := filepath.Join(s.directory, "session-windows-pending.json")
	var pending desktopWindowsTaskTransaction
	found, err := readDesktopJSON(path, &pending)
	if err != nil {
		return windowsSessionRecoveryRequired()
	}
	if !found {
		return nil
	}
	_, beforeOK := decodeWindowsSessionSnapshot(pending.Before)
	_, afterOK := decodeWindowsSessionSnapshot(pending.After)
	if s.platform != "windows" || s.windows == nil || pending.Version != 1 || !pending.Spec.valid() || pending.Spec.Platform != "win32" ||
		pending.Spec.Name != s.definition().Name || pending.Saved != nil && (!pending.Saved.valid() || pending.Saved.Platform != "win32" || pending.Saved.Name != pending.Spec.Name) ||
		!beforeOK || len(pending.After) > 0 && !afterOK {
		return windowsSessionRecoveryRequired()
	}
	current, err := s.windows("snapshot", pending)
	if err != nil {
		return windowsSessionRecoveryRequired()
	}
	var intended *desktopRegistration
	if pending.Enabled {
		intended = &pending.Spec
	}
	if windowsSessionSnapshotsMatch(current, pending.Before) {
		if err := restoreDesktopSessionRecord(recordPath, pending.Saved, intended); err != nil {
			return windowsSessionRecoveryRequired()
		}
	} else {
		var record *desktopRegistration
		if _, err := readDesktopJSON(recordPath, &record); err != nil || !afterOK || !windowsSessionSnapshotsMatch(current, pending.After) || !desktopRegistrationMatches(record, intended) {
			return windowsSessionRecoveryRequired()
		}
	}
	return removeDesktopFile(path)
}

func (s desktopSession) mutateWindowsSession(enabled bool, spec desktopRegistration, saved *desktopRegistration, recordPath string) error {
	if !enabled && saved == nil {
		return nil
	}
	if s.windows == nil || !spec.ownedBy(s.definition()) || saved != nil && saved.Name != spec.Name {
		return desktopFailure(409, "SESSION_CHANGED", "Background task identity changed; preserve it")
	}
	transaction := desktopWindowsTaskTransaction{Version: 1, Spec: spec, Saved: saved, Enabled: enabled}
	before, err := s.windows("inspect", transaction)
	if err != nil {
		return err
	}
	prior, ok := decodeWindowsSessionSnapshot(before)
	if !ok {
		return windowsSessionRecoveryRequired()
	}
	if enabled && prior != nil && *prior.Enabled && desktopRegistrationMatches(saved, &spec) {
		return nil
	}
	transaction.Before = before
	path := filepath.Join(s.directory, "session-windows-pending.json")
	if err := writeDesktopJSON(path, transaction); err != nil {
		return err
	}
	after, err := s.windows("apply", transaction)
	if err != nil {
		if recoveryErr := s.recoverWindowsSession(recordPath); recoveryErr != nil {
			return recoveryErr
		}
		return err
	}
	transaction.After = after
	var intended *desktopRegistration
	if enabled {
		intended = &spec
		err = writeDesktopJSON(recordPath, spec)
	} else {
		err = removeDesktopFile(recordPath)
	}
	if err == nil {
		err = writeDesktopJSON(path, transaction)
	}
	if err == nil {
		// A retained BEFORE/AFTER journal with a committed record is recoverable.
		return removeDesktopFile(path)
	}
	_, rollbackErr := s.windows("rollback", transaction)
	if recordErr := restoreDesktopSessionRecord(recordPath, saved, intended); rollbackErr != nil || recordErr != nil {
		return windowsSessionRecoveryRequired()
	}
	_ = removeDesktopFile(path)
	return err
}
