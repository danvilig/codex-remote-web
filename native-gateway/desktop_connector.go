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
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

var desktopConnectorTokenFile = regexp.MustCompile(`^connector-[0-9]+\.token$`)
var desktopConnectorID = regexp.MustCompile(`(?i)Generated Connector ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})`)

// Keep cloudflared tied to the agent even if the agent is killed. Raw
// connector output can include sensitive diagnostics; emit only fixed markers.
func runDesktopConnectorWorker(binary, tokenPath string) error {
	directory, err := os.Getwd()
	if err != nil || !workerOwnsProcess() || !validDesktopPath(binary) ||
		!validDesktopPath(tokenPath) || !desktopConnectorTokenFile.MatchString(filepath.Base(tokenPath)) {
		return errors.New("Invalid desktop connector supervisor")
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(tokenPath))
	if err != nil || parent != directory || ensureDesktopDirectory(parent) != nil {
		return errors.New("Invalid desktop connector directory")
	}
	if file, err := desktopOpen(tokenPath, syscall.O_RDONLY, 16385, true); err != nil {
		return errors.New("Invalid desktop connector token file")
	} else {
		file.Close()
	}
	defer os.Remove(tokenPath)
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	output, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	defer output.Close()
	cmd := exec.Command(binary, "tunnel", "--no-autoupdate", "--output", "json", "run", "--token-file", tokenPath)
	cmd.Stdout, cmd.Stderr = writer, writer
	err = cmd.Start()
	writer.Close()
	if err != nil {
		return errors.New("Cloudflare connector could not start")
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	go func() {
		defer cancel()
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 4096), 64<<10)
		var announced bool
		for scanner.Scan() {
			line := scanner.Text()
			var event struct {
				Message string `json:"message"`
			}
			if json.Unmarshal([]byte(line), &event) == nil {
				line = event.Message
			}
			if matches := desktopConnectorID.FindStringSubmatch(line); len(matches) == 2 {
				if _, err := os.Stdout.WriteString("connector-id:" + strings.ToLower(matches[1]) + "\n"); err != nil {
					return
				}
			}
			if !announced && strings.Contains(line, "Registered tunnel connection") {
				announced = true
				if _, err := os.Stdout.WriteString("connector-ready\n"); err != nil {
					return
				}
			}
		}
	}()
	select {
	case <-done:
		return errors.New("Cloudflare connector exited")
	case <-ctx.Done():
	}
	if !gracefulOwnedWorker() {
		return nil
	}
	// This worker still owns its process group until it exits. Escalate once
	// if the connector ignores termination, including any child it started.
	stopOwnedWorker(false)
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case <-done:
		return nil
	case <-timer.C:
		_ = os.Remove(tokenPath)
		stopOwnedWorker(true)
		return nil
	}
}
