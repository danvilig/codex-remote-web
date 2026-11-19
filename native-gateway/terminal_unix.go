//go:build darwin || linux

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
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

func serveTerminal(w http.ResponseWriter, r *http.Request, cwd string) {
	ws, err := authenticatedUpgrade(w, r)
	if err != nil {
		return
	}
	defer ws.Close()
	ws.SetReadLimit(1_000_000)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	due, stop, code := lease(ctx)
	defer stop()
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell, "-l")
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	session, err := startTerminal(cmd, 100, 24)
	if err != nil {
		_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1011, "Terminal unavailable"), time.Now().Add(writeTimeout))
		return
	}
	defer session.close()
	go func() {
		defer cancel()
		for {
			kind, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if kind == websocket.BinaryMessage {
				if _, err := session.master.Write(data); err != nil {
					return
				}
			} else if kind == websocket.TextMessage {
				var msg struct {
					Type       string `json:"type"`
					Cols, Rows uint16
				}
				if json.Unmarshal(data, &msg) == nil && msg.Type == "resize" {
					_ = session.resize(msg.Cols, msg.Rows)
				}
			}
		}
	}()
	output := make(chan []byte, 4)
	go func() {
		defer close(output)
		reader := bufio.NewReader(session.master)
		var block []byte
		for {
			rn, size, err := reader.ReadRune()
			if size != 0 {
				block = append(block, string(rn)...)
			}
			if len(block) > 0 && (err != nil || reader.Buffered() == 0 || len(block) >= 16<<10) {
				select {
				case output <- block:
					block = nil
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	write := func(data []byte) bool {
		return ws.SetWriteDeadline(time.Now().Add(writeTimeout)) == nil && ws.WriteMessage(websocket.TextMessage, data) == nil
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-due:
			closeForLease(ws, code)
			return
		case data, ok := <-output:
			if ok {
				if !write(data) {
					return
				}
				continue
			}
			select {
			case <-session.done:
			case <-ctx.Done():
				return
			case <-due:
				closeForLease(ws, code)
				return
			}
			status := 0
			if exit, ok := session.err.(*exec.ExitError); ok {
				status = exit.ExitCode()
			}
			_ = write(fmt.Appendf(nil, "\r\n[Process exited %d]\r\n", status))
			_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "Terminal exited"), time.Now().Add(writeTimeout))
			return
		}
	}
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
