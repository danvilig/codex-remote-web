package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsDesktopSessionPreservesUncertainTask(t *testing.T) {
	home := t.TempDir()
	s := desktopSession{home: home, directory: desktopDirectory(home), installation: `C:\Fixture\Codex Remote Web.exe`, platform: "windows"}
	absent := json.RawMessage(`null`)
	created := json.RawMessage(`{"xml":"<Task fixture='owned'/>","enabled":true}`)
	actual := absent
	s.windows = func(operation string, tx desktopWindowsTaskTransaction) (json.RawMessage, error) {
		switch operation {
		case "inspect", "snapshot":
			return actual, nil
		case "apply":
			if !windowsSessionSnapshotsMatch(actual, tx.Before) {
				t.Fatal("Mutation without original snapshot")
			}
			actual = created
			return nil, errors.New("synthetic helper disconnected after task registration")
		default:
			t.Fatalf("Unexpected scheduler mutation: %s", operation)
			return nil, nil
		}
	}
	if _, err := s.configure(true, false); desktopErrorCode(err) != "SESSION_RECOVERY_REQUIRED" {
		t.Fatalf("Uncertain task result must be reported: %v", err)
	}
	journal := filepath.Join(s.directory, "session-windows-pending.json")
	if _, err := os.Stat(journal); err != nil {
		t.Fatal("Lost the pending scheduler change", err)
	}
	if _, err := s.configure(false, true); desktopErrorCode(err) != "SESSION_RECOVERY_REQUIRED" {
		t.Fatalf("Uninstall skipped scheduler recovery: %v", err)
	}
	actual = absent
	if _, err := s.configure(false, true); err != nil {
		t.Fatal("Could not recover after the original scheduler state was restored", err)
	}
	if _, err := os.Stat(journal); !os.IsNotExist(err) {
		t.Fatal("Proven recovery retained the journal", err)
	}
}
