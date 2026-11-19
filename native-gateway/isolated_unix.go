//go:build darwin || linux

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
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, writeEnd, err := os.Pipe()
	if err != nil {
		_ = in.Close()
		return nil, err
	}
	defer writeEnd.Close()
	cmd.Stdout = writeEnd
	file, ok := in.(*os.File)
	if !ok {
		_ = in.Close()
		_ = out.Close()
		return nil, errors.New("App Server supervisor has no deadline-aware pipe")
	}
	if err := cmd.Start(); err != nil {
		_ = in.Close()
		_ = out.Close()
		return nil, err
	}
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 64<<10), maxNativeMessage)
	// A separately owned pipe lets the reader drain final responses after Wait.
	conn := &stdioMessageConn{stdin: file, stdout: out, scanner: scanner}
	go func() { _ = cmd.Wait() }()
	return conn, nil
}

func runIsolatedWorker() error {
	if syscall.Getpgrp() != os.Getpid() {
		return errors.New("App Server supervisor must own its process group")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	binary := os.Getenv("CODEX_WEBUI_CODEX")
	if binary == "" {
		binary = "codex"
	}
	cmd := exec.Command(binary, "app-server", "--stdio")
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
	// Terminate the owned group even after its lead Codex process exits.
	_ = syscall.Kill(-os.Getpid(), syscall.SIGTERM)
	time.AfterFunc(1500*time.Millisecond, func() { _ = syscall.Kill(-os.Getpid(), syscall.SIGKILL) })
	<-time.After(1600 * time.Millisecond)
	return result
}
