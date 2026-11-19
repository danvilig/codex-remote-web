package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func desktopAgentRequest(ctx context.Context, directory, installation, action string, body json.RawMessage, deadline time.Duration) (json.RawMessage, error) {
	var descriptor desktopDescriptor
	invalid := desktopFailure(400, "AGENT_STATE_INVALID", "Background agent state is invalid")
	found, err := readDesktopJSON(filepath.Join(directory, "agent.json"), &descriptor)
	if err != nil {
		return nil, invalid
	}
	if !found {
		return nil, desktopFailure(503, "AGENT_ABSENT", "Background agent is unavailable")
	}
	secret, err := base64.RawURLEncoding.DecodeString(descriptor.Token)
	if err != nil || len(secret) != 32 || descriptor.Version != 1 || descriptor.Port < 1 || descriptor.Port > 65535 {
		return nil, invalid
	}
	if descriptor.Installation != installation {
		return nil, desktopFailure(409, "AGENT_FOREIGN", "Background agent belongs to another installation")
	}
	payload, err := json.Marshal(desktopRequest{Action: action, Body: body})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/control", descriptor.Port), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+descriptor.Token)
	request.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{DialContext: (&net.Dialer{}).DialContext, DisableKeepAlives: true, MaxResponseHeaderBytes: 8 << 10}
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if errors.Is(err, syscall.ECONNREFUSED) {
		return nil, desktopFailure(503, "AGENT_OFFLINE", "Background agent is offline")
	}
	if err != nil {
		return nil, desktopFailure(503, "AGENT_REQUEST_FAILED", "Could not complete the background operation. Try again.")
	}
	defer response.Body.Close()
	const limit = 1 << 20
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || len(data) > limit || !json.Valid(data) {
		return nil, desktopFailure(503, "AGENT_INVALID_REPLY", "Background agent returned an invalid response")
	}
	if response.StatusCode != 200 {
		var failure desktopError
		if json.Unmarshal(data, &failure) != nil || failure.Message == "" {
			failure = desktopError{Message: "Desktop operation failed"}
		}
		failure.Status = response.StatusCode
		return nil, &failure
	}
	return json.RawMessage(data), nil
}

func desktopAgentUnavailable(err error, foreign bool) bool {
	code := desktopErrorCode(err)
	return code == "AGENT_ABSENT" || code == "AGENT_OFFLINE" || foreign && code == "AGENT_FOREIGN"
}

func waitDesktopAgent(ctx context.Context, directory, installation string) (bool, error) {
	result, err := desktopAgentRequest(ctx, directory, installation, "status", nil, 3*time.Second)
	if desktopAgentUnavailable(err, false) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var status struct {
		Runtime               string `json:"runtime"`
		GatewayImplementation string `json:"gatewayImplementation"`
	}
	if err := json.Unmarshal(result, &status); err != nil {
		return false, err
	}
	if status.Runtime == "macos-native" && status.GatewayImplementation == "go" {
		return true, nil
	}
	if _, err := desktopAgentRequest(ctx, directory, installation, "shutdown", nil, 120*time.Second); err != nil {
		return false, err
	}
	for attempt := 0; attempt < 150; attempt++ {
		_, err := desktopAgentRequest(ctx, directory, installation, "status", nil, 3*time.Second)
		if desktopAgentUnavailable(err, false) {
			// The previous control socket may close before its children and the
			// stable lock are released. Launch only after it has finished draining.
			release, err := lockDesktop(directory, "agent-lock", 100*time.Millisecond)
			if err == nil {
				release()
				return false, nil
			}
			if desktopErrorCode(err) != "PRIVATE_LOCK_BUSY" {
				return false, err
			}
		} else if err != nil {
			return false, err
		}
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return false, desktopFailure(409, "", "Previous background agent is still shutting down. Try opening the application again.")
}

var desktopCleanupFiles = []string{"config.json", "management-token.json", "setup-state.json"}

func readDesktopDeployment(directory string) (*desktopDeploymentReceipt, error) {
	var receipt *desktopDeploymentReceipt
	_, err := readDesktopJSON(filepath.Join(directory, "setup-state.json"), &receipt)
	return receipt, err
}

func assertDesktopCleanup(directory string) error {
	receipt, err := readDesktopDeployment(directory)
	if err != nil {
		return err
	}
	if receipt != nil && receipt.Phase != "removed" {
		return desktopFailure(409, "REMOTE_DEPLOYMENT_PRESENT", "Remove the remote deployment in Remote access before cleaning up.")
	}
	for _, name := range []string{"protected-gateway.json", "tunnel-token.json", "setup.lock", "session-windows-pending.json"} {
		if _, err := os.Lstat(filepath.Join(directory, name)); !errors.Is(err, os.ErrNotExist) {
			return desktopFailure(409, "RECOVERY_REQUIRED", "Finish remote access or startup recovery before cleaning up.")
		}
	}
	for _, name := range desktopCleanupFiles {
		var value json.RawMessage
		if _, err := readDesktopJSON(filepath.Join(directory, name), &value); err != nil {
			return err
		}
	}
	return nil
}

func cleanDesktopState(home, directory string) error {
	releaseAgent, err := lockDesktop(directory, "agent-lock", 10*time.Second)
	if err != nil {
		return err
	}
	defer releaseAgent()
	releaseSession, err := lockDesktop(directory, "session-lock", 5*time.Second)
	if err != nil {
		return err
	}
	defer releaseSession()
	for _, name := range []string{"agent.json", "session.json"} {
		if _, err := os.Lstat(filepath.Join(directory, name)); !errors.Is(err, os.ErrNotExist) {
			return desktopFailure(409, "", "Stop and remove the background component before cleaning up.")
		}
	}
	if err := assertDesktopCleanup(directory); err != nil {
		return err
	}
	legacy := []string{
		filepath.Join(home, "Library", "Application Support", "Codex Remote Web"),
		filepath.Join(home, "Library", "Caches", "io.github.danvilig.codex-remote-web"),
		filepath.Join(home, "Library", "Logs", "Codex Remote Web"),
	}
	for _, path := range legacy {
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		// No redirected directory is part of this application's cleanup scope.
		base, baseErr := filepath.EvalSymlinks(home)
		actual, actualErr := filepath.EvalSymlinks(path)
		relative, relErr := filepath.Rel(home, path)
		if err != nil || !info.IsDir() || !desktopOwned(info) || baseErr != nil || actualErr != nil || relErr != nil || actual != filepath.Join(base, relative) {
			return desktopFailure(409, "", "Application data path is unsafe; cleanup stopped.")
		}
	}
	for _, name := range desktopCleanupFiles {
		if err := removeDesktopFile(filepath.Join(directory, name)); err != nil {
			return err
		}
	}
	for _, path := range legacy {
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	return nil
}

func performDesktopOperation(ctx context.Context, home, installation string, request desktopRequest) (any, error) {
	if !validDesktopPath(installation) {
		return nil, desktopFailure(400, "", "Invalid desktop installation")
	}
	directory := desktopDirectory(home)
	if err := ensureDesktopDirectory(directory); err != nil {
		return nil, err
	}
	call := func(action string, body json.RawMessage) (json.RawMessage, error) {
		return desktopAgentRequest(ctx, directory, installation, action, body, 120*time.Second)
	}
	session := newDesktopSession(home, directory, installation)
	switch request.Action {
	case "prepare":
		return nil, nil
	case "prepareAgent":
		return waitDesktopAgent(ctx, directory, installation)
	case "removeBackground", "cleanUninstall":
		if request.Action == "cleanUninstall" {
			if _, err := call("cleanupCheck", nil); err != nil && !desktopAgentUnavailable(err, false) {
				return nil, err
			}
			if err := assertDesktopCleanup(directory); err != nil {
				return nil, err
			}
		}
		for _, action := range []string{"stop", "shutdown"} {
			if _, err := call(action, nil); err != nil && !desktopAgentUnavailable(err, true) {
				return nil, err
			}
		}
		if _, err := session.configure(false, true); err != nil {
			return nil, err
		}
		if request.Action == "cleanUninstall" {
			return nil, cleanDesktopState(home, directory)
		}
		return nil, nil
	case "config":
		validated, err := call("validateConfig", request.Body)
		if err != nil {
			return nil, err
		}
		config, err := parseDesktopConfig(validated, home)
		if err != nil {
			return nil, err
		}
		restore, err := session.configure(config.Autostart, false)
		if err != nil {
			return nil, err
		}
		value, err := call("config", request.Body)
		if err != nil {
			if rollbackErr := restore(); rollbackErr != nil {
				return nil, rollbackErr
			}
		}
		return value, err
	case "status", "dependencies", "start", "stop", "restart", "setup", "language":
		return call(request.Action, request.Body)
	default:
		return nil, desktopFailure(400, "", "Unsupported desktop operation")
	}
}

// runDesktopOperation implements Swift's single request/reply CLI protocol.
// Operation failures are reported as data; the transport itself still exits 0.
func runDesktopOperation(installation string, input io.Reader, output io.Writer) error {
	request, err := readDesktopRequest(input)
	var value any
	if err == nil {
		var home string
		if home, err = os.UserHomeDir(); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 123*time.Second)
			defer cancel()
			value, err = performDesktopOperation(ctx, home, installation, request)
		}
	}
	encoder := json.NewEncoder(output)
	if err != nil {
		failure := desktopSafeError(err)
		return encoder.Encode(map[string]any{"ok": false, "error": failure.Message, "code": failure.Code, "status": failure.Status})
	}
	return encoder.Encode(map[string]any{"ok": true, "value": value})
}

func runDesktopUninstall(installation string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if installation == "" {
		var registration desktopRegistration
		found, err := readDesktopJSON(filepath.Join(desktopDirectory(home), "session.json"), &registration)
		if err != nil {
			return err
		}
		if found {
			installation = registration.Executable
		} else {
			var descriptor desktopDescriptor
			found, err = readDesktopJSON(filepath.Join(desktopDirectory(home), "agent.json"), &descriptor)
			if err != nil || !found {
				return err
			}
			installation = descriptor.Installation
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 123*time.Second)
	defer cancel()
	_, err = performDesktopOperation(ctx, home, installation, desktopRequest{Action: "removeBackground"})
	return err
}

func runDesktopCleanup(output io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	directory := desktopDirectory(home)
	if err := ensureDesktopDirectory(directory); err != nil {
		return err
	}
	if err := cleanDesktopState(home, directory); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string][]string{"removed": desktopCleanupFiles})
}
