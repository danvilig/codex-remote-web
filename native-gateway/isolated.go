package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

type stdioMessageConn struct {
	stdin   *os.File
	stdout  io.ReadCloser
	scanner *bufio.Scanner
	once    sync.Once
}

func (c *stdioMessageConn) SetWriteDeadline(t time.Time) error { return c.stdin.SetWriteDeadline(t) }
func (c *stdioMessageConn) WriteJSON(v any) error              { return json.NewEncoder(c.stdin).Encode(v) }
func (c *stdioMessageConn) ReadMessage() (int, []byte, error) {
	if c.scanner.Scan() {
		return websocket.TextMessage, c.scanner.Bytes(), nil
	}
	if err := c.scanner.Err(); err != nil {
		return 0, nil, err
	}
	return 0, nil, io.EOF
}
func (c *stdioMessageConn) Close() error {
	c.once.Do(func() { _ = c.stdin.Close(); _ = c.stdout.Close() })
	return nil
}

func openIsolated(cwd string) (*stdioMessageConn, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, "isolated-worker")
	cmd.Dir = cwd
	cmd.Stderr = os.Stderr
	if err := configureOwnedCommand(cmd); err != nil {
		return nil, err
	}
	readEnd, in, err := isolatedInputPipe()
	if err != nil {
		return nil, err
	}
	defer readEnd.Close()
	cmd.Stdin = readEnd
	out, writeEnd, err := os.Pipe()
	if err != nil {
		_ = in.Close()
		return nil, err
	}
	defer writeEnd.Close()
	cmd.Stdout = writeEnd
	if err := cmd.Start(); err != nil {
		_ = in.Close()
		_ = out.Close()
		return nil, err
	}
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 64<<10), maxNativeMessage)
	// A separately owned pipe lets the reader drain final responses after Wait.
	conn := &stdioMessageConn{stdin: in, stdout: out, scanner: scanner}
	go func() { _ = cmd.Wait() }()
	return conn, nil
}

func runIsolatedWorker() error {
	if !workerOwnsProcess() {
		return errors.New("App Server supervisor must own its process tree")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	binary := os.Getenv("CODEX_WEBUI_CODEX")
	if binary == "" {
		binary = "codex"
	}
	cmd, err := codexCommand(binary, "app-server", "--stdio")
	if err != nil {
		return err
	}
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		_ = in.Close()
		return err
	}
	done, life := make(chan error, 1), make(chan struct{})
	go func() { done <- cmd.Wait() }()
	go func() { _, _ = io.Copy(in, os.Stdin); _ = in.Close(); close(life) }()
	var result error
	select {
	case result = <-done:
	case <-ctx.Done():
	case <-life:
	}
	// Terminate the owned tree even after its lead Codex process exits.
	finishOwnedWorker()
	return result
}
