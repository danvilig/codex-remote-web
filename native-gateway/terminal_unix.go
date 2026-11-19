//go:build darwin || linux

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/creack/pty"
)

type terminalSession struct {
	master *os.File
	child  *os.Process
	done   chan struct{}
	err    error // Read only after done has closed.
}

func startTerminal(cmd *exec.Cmd, cols, rows uint16) (*terminalSession, error) {
	master, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}
	session := &terminalSession{master: master, child: cmd.Process, done: make(chan struct{})}
	go func() {
		session.err = cmd.Wait()
		close(session.done)
	}()
	return session, nil
}

func (s *terminalSession) resize(cols, rows uint16) error {
	if cols < 20 || cols > 500 || rows < 5 || rows > 200 {
		return errors.New("Invalid terminal dimensions")
	}
	return pty.Setsize(s.master, &pty.Winsize{Cols: cols, Rows: rows})
}

func (s *terminalSession) close() {
	_ = s.master.Close()
	select {
	case <-s.done:
	default:
		_ = syscall.Kill(-s.child.Pid, syscall.SIGHUP)
		_ = syscall.Kill(-s.child.Pid, syscall.SIGKILL)
	}
	<-s.done
}

func terminalCommand(cwd string) *exec.Cmd {
	shell := getenvDefault("SHELL", "/bin/sh")
	cmd := exec.Command(shell, "-l")
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	return cmd
}

func (s *terminalSession) input() io.Writer  { return s.master }
func (s *terminalSession) output() io.Reader { return s.master }
func (s *terminalSession) exitStatus() int {
	if exit, ok := s.err.(*exec.ExitError); ok {
		return exit.ExitCode()
	}
	return 0
}

func checkPTY() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Absolute paths and a fixed local command keep the diagnostic independent
	// of the login shell, user dotfiles, and the Bun/Node build environment.
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", `/bin/stty size; read -r line; /bin/stty size; printf 'INPUT:%s\n' "$line"`)
	session, err := startTerminal(cmd, 80, 24)
	if err != nil {
		return err
	}
	defer session.close()
	reader := bufio.NewReader(session.master)
	checkLine := func(want string) error {
		line, err := reader.ReadString('\n')
		if err != nil || strings.TrimSpace(line) != want {
			return fmt.Errorf("expected PTY output %q, got %q (%v)", want, line, err)
		}
		return nil
	}
	if err := checkLine("24 80"); err != nil {
		return err
	}
	if err := session.resize(132, 41); err != nil {
		return err
	}
	if _, err := io.WriteString(session.master, "probe-token\n"); err != nil {
		return err
	}
	for _, want := range []string{"probe-token", "41 132", "INPUT:probe-token"} {
		if err := checkLine(want); err != nil {
			return err
		}
	}
	<-session.done
	return session.err
}
