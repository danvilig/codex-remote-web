//go:build darwin || linux

package main

import (
	"os/exec"
	"testing"
)

func TestTerminalRoundTrip(t *testing.T) {
	if err := checkPTY(); err != nil {
		t.Fatal(err)
	}
}

func TestTerminalCloseReapsOwnedShell(t *testing.T) {
	cmd := exec.CommandContext(t.Context(), "/bin/sh", "-c", `read -r _`)
	session, err := startTerminal(cmd, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if err := session.resize(0, 0); err == nil {
		t.Error("invalid terminal size was accepted")
	}
	session.close()
	if cmd.ProcessState == nil {
		t.Fatal("terminal shell was not reaped")
	}
}
