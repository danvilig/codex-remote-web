//go:build darwin || linux

package main

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func tryQuickLock(f *os.File) bool {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil
}
func quickPlatformReady(help string) bool { return strings.Contains(help, "--unix-socket") }
func quickPlatformEnv() []string          { return nil }

// Darwin's private temp directory can exceed the Unix socket path limit.
func quickTemp() (string, error) { return os.MkdirTemp("/tmp", "crw-quick-") }

func quickListener(dir string) (net.Listener, string, map[string]any, error) {
	socket := filepath.Join(dir, "origin.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return nil, "", nil, err
	}
	if err = os.Chmod(socket, 0600); err != nil {
		listener.Close()
		return nil, "", nil, err
	}
	return listener, "", map[string]any{"service": "unix:" + socket}, nil
}
