//go:build darwin || linux

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func conversationStamp(pid int) string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err == nil {
		if end := bytes.LastIndex(data, []byte(") ")); end != -1 {
			if fields := strings.Fields(string(data[end+2:])); len(fields) > 19 {
				return fields[19]
			}
		}
	}
	return ""
}

func processExists(pid int) error { return syscall.Kill(pid, 0) }
func processMissing(pid int) bool { return errors.Is(processExists(pid), syscall.ESRCH) }
func processAlive(pid int, stamp string) bool {
	err := processExists(pid)
	return errors.Is(err, syscall.EPERM) || (err == nil && (stamp == "" || stamp == conversationStamp(pid)))
}

func configureOwnedCommand(cmd *exec.Cmd) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd.Err
}

func stopOwnedCommand(cmd *exec.Cmd, force bool) error {
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	if err := syscall.Kill(-cmd.Process.Pid, sig); errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	} else {
		return err
	}
}

func workerOwnsProcess() bool { return syscall.Getpgrp() == os.Getpid() }
func gracefulOwnedWorker() bool {
	// The worker also receives its group's termination signal. Keep it from
	// becoming fatal if the connector exits before signal delivery completes.
	signal.Ignore(syscall.SIGTERM)
	return true
}
func stopOwnedWorker(force bool) {
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	_ = syscall.Kill(-os.Getpid(), sig)
}

func finishOwnedWorker() {
	stopOwnedWorker(false)
	time.Sleep(1500 * time.Millisecond)
	stopOwnedWorker(true)
}

func runPlatformCommand(string, []string) (bool, error) { return false, nil }

func codexCommand(binary string, args ...string) (*exec.Cmd, error) {
	return exec.Command(binary, args...), nil
}

func desktopPathEntries(home string) []string {
	return []string{home + "/.local/bin", home + "/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"}
}

func desktopPlatformEnv() []string { return nil }

func isolatedInputPipe() (*os.File, *os.File, error) { return os.Pipe() }
