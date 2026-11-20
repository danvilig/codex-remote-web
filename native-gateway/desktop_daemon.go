package main

import (
	"context"
	"errors"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

func desktopDefaultDaemon(flags *flag.FlagSet) bool {
	if os.Getenv("CODEX_WEBUI_DESKTOP_CHILD") != "1" || os.Getenv("CODEX_WEBUI_APP_SERVER_MODE") != "" || os.Getenv("CODEX_WEBUI_APP_SERVER_SOCKET") != "" {
		return false
	}
	if runtime.GOOS == "windows" && workerOwnsProcess() {
		// The desktop agent handles daemon startup outside the gateway's Job.
		return false
	}
	customSocket := false
	flags.Visit(func(f *flag.Flag) { customSocket = customSocket || f.Name == "socket" })
	return !customSocket
}

type desktopDaemon struct {
	start       func(context.Context) error
	nextAttempt time.Time
}

func (d *desktopDaemon) maybeStart(ctx context.Context, socket string, dialErr error) bool {
	if ctx.Err() != nil || time.Now().Before(d.nextAttempt) || !missingDaemonEndpoint(socket, dialErr) {
		return false
	}
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	err := d.start(startup)
	d.nextAttempt = time.Now().Add(30 * time.Second)
	return err == nil
}

func missingDaemonEndpoint(socket string, dialErr error) bool {
	if errors.Is(dialErr, os.ErrNotExist) {
		_, err := os.Lstat(socket)
		return errors.Is(err, os.ErrNotExist)
	}
	if errors.Is(dialErr, syscall.ECONNREFUSED) || errors.Is(dialErr, syscall.Errno(10061)) {
		info, err := os.Lstat(socket)
		return errors.Is(err, os.ErrNotExist) || err == nil && info.Mode()&os.ModeSocket != 0
	}
	return false
}

func startDesktopDaemon(ctx context.Context) error {
	home, _ := os.UserHomeDir()
	return runDesktopDaemonCommand(ctx, home, getenvDefault("CODEX_WEBUI_CODEX", "codex"), nil)
}

func runDesktopDaemonCommand(ctx context.Context, home, codex string, env []string) error {
	cmd, err := codexCommand(codex, "app-server", "daemon", "start")
	if err != nil {
		return err
	}
	// Only Codex owns this daemon's lifetime and its shared writer lock.
	// Do not put the starter in the gateway's isolated subprocess supervisor.
	starter := exec.CommandContext(ctx, cmd.Path, cmd.Args[1:]...)
	starter.Dir, starter.Env = home, env
	return starter.Run()
}

func watchWindowsDesktopDaemon(done <-chan struct{}, home, preferred string, env []string) {
	if os.Getenv("CODEX_WEBUI_APP_SERVER_MODE") != "" || os.Getenv("CODEX_WEBUI_APP_SERVER_SOCKET") != "" {
		return
	}
	profile := getenvDefault("CODEX_HOME", filepath.Join(home, ".codex"))
	socket := filepath.Join(profile, "app-server-control", "app-server-control.sock")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-done:
			cancel()
		case <-ctx.Done():
		}
	}()
	d := desktopDaemon{start: func(ctx context.Context) error {
		binary := desktopExecutable("codex", preferred, desktopPath(home))
		if binary == "" {
			return exec.ErrNotFound
		}
		return runDesktopDaemonCommand(ctx, home, binary, env)
	}}
	for ctx.Err() == nil {
		probe, stop := context.WithTimeout(ctx, 3*time.Second)
		transport, err := nativeSocket(probe, socket)
		stop()
		if err == nil {
			_ = transport.Close()
		} else {
			d.maybeStart(ctx, socket, err)
		}
		timer := time.NewTimer(30 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
