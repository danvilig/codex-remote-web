package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type desktopRemoteInput struct {
	AccountID    string `json:"accountId"`
	ZoneID       string `json:"zoneId"`
	TunnelID     string `json:"tunnelId,omitempty"`
	TunnelMode   string `json:"tunnelMode,omitempty"`
	TunnelName   string `json:"tunnelName,omitempty"`
	ConfirmLocal bool   `json:"confirmLocal,omitempty"`
	Hostname     string `json:"hostname"`
	Email        string `json:"email"`
	Port         int    `json:"port"`
}

type desktopOwnedEnvironment struct {
	Owner       string `json:"owner,omitempty"`
	Environment string `json:"environment"`
	Unit        string `json:"unit,omitempty"`
}

type desktopOwnedConnector struct {
	Owner       string `json:"owner,omitempty"`
	Binary      string `json:"binary,omitempty"`
	Unit        string `json:"unit,omitempty"`
	TokenDigest string `json:"tokenDigest,omitempty"`
}

type desktopDeploymentReceipt struct {
	Version             int                      `json:"version"`
	Phase               string                   `json:"phase"`
	Input               desktopRemoteInput       `json:"input"`
	SourceInput         *desktopRemoteInput      `json:"sourceInput,omitempty"`
	Local               *desktopOwnedEnvironment `json:"local,omitempty"`
	Connector           *desktopOwnedConnector   `json:"connector,omitempty"`
	IdentityChange      json.RawMessage          `json:"identityChange,omitempty"`
	ConfigurationChange json.RawMessage          `json:"configurationChange,omitempty"`
	Probe               string                   `json:"probe,omitempty"`
	TeamDomain          string                   `json:"teamDomain,omitempty"`
	AUD                 string                   `json:"aud,omitempty"`
	AppID               string                   `json:"appId,omitempty"`
	Policy              map[string]any           `json:"policy,omitempty"`
	DNSID               string                   `json:"dnsId,omitempty"`
	Route               map[string]any           `json:"route,omitempty"`
	AppName             string                   `json:"appName,omitempty"`
	RouteIntent         bool                     `json:"routeIntent,omitempty"`
	DNSIntent           bool                     `json:"dnsIntent,omitempty"`
	CreatedTunnel       bool                     `json:"createdTunnel,omitempty"`
	CreatedTunnelID     string                   `json:"createdTunnelId,omitempty"`
	CreatedTunnelName   string                   `json:"createdTunnelName,omitempty"`
	InitialTunnelConfig map[string]any           `json:"initialTunnelConfig,omitempty"`
	AppSnapshot         map[string]any           `json:"appSnapshot,omitempty"`
}

func (a *desktopAgent) readDeployment() (*desktopDeploymentReceipt, error) {
	return readDesktopDeployment(a.directory)
}

func (a *desktopAgent) assertOwnedDeployment(receipt *desktopDeploymentReceipt, alternatives ...string) error {
	if a.systemd != nil {
		return a.systemd.assertOwned(receipt.Local, alternatives...)
	}
	var current desktopOwnedEnvironment
	found, err := readDesktopJSON(filepath.Join(a.directory, "protected-gateway.json"), &current)
	if err != nil {
		return err
	}
	if found && receipt.Local != nil && current.Owner != "" && current.Owner == receipt.Local.Owner {
		for _, environment := range append(alternatives, receipt.Local.Environment) {
			if environment != "" && current.Environment == environment {
				return nil
			}
		}
	}
	return desktopFailure(409, "", "Desktop deployment configuration changed. Cleanup stopped.")
}

func environmentMap(env []string) map[string]string {
	result := make(map[string]string, len(env))
	for _, item := range env {
		if key, value, ok := strings.Cut(item, "="); ok {
			result[key] = value
		}
	}
	return result
}

func environmentList(env map[string]string) []string {
	result := make([]string, 0, len(env))
	for key, value := range env {
		result = append(result, key+"="+value)
	}
	return result
}

func (a *desktopAgent) activateProtected(receipt *desktopDeploymentReceipt) error {
	if receipt.Local == nil || receipt.Input.Port < 1024 || receipt.Input.Port == a.currentConfig().Port || receipt.Input.Port > 65535 {
		return desktopFailure(409, "", "Protected gateway configuration could not be verified")
	}
	if err := a.assertOwnedDeployment(receipt); err != nil {
		return err
	}
	var saved map[string]string
	if err := json.Unmarshal([]byte(receipt.Local.Environment), &saved); err != nil {
		return err
	}
	config := a.currentConfig()
	config.Port = receipt.Input.Port
	spec := desktopGatewayLaunch(a.binary, a.home, config)
	env := environmentMap(spec.env)
	env["CODEX_WEBUI_AUTH_MODE"] = "cloudflare-access"
	for _, key := range []string{"CODEX_WEBUI_PUBLIC_ORIGIN", "CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN", "CODEX_WEBUI_CF_ACCESS_AUD", "CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL", "CODEX_WEBUI_SETUP_PROBE"} {
		env[key] = saved[key]
		if env[key] == "" {
			return errors.New("Incomplete protected gateway configuration")
		}
	}
	if env["CODEX_WEBUI_PUBLIC_ORIGIN"] != "https://"+receipt.Input.Hostname || env["CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL"] != receipt.Input.Email ||
		env["CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN"] != receipt.TeamDomain || env["CODEX_WEBUI_CF_ACCESS_AUD"] != receipt.AUD || env["CODEX_WEBUI_SETUP_PROBE"] != receipt.Probe {
		return desktopFailure(409, "", "Protected gateway configuration does not match its deployment")
	}
	spec.env = environmentList(env)
	a.protected.stop()
	return a.protected.start(spec)
}

func (a *desktopAgent) startConnector(spec *desktopOwnedConnector) error {
	if spec == nil || a.connector.snapshot().Phase == "running" {
		return nil
	}
	var saved struct{ Owner, Token string }
	found, err := readDesktopJSON(filepath.Join(a.directory, "tunnel-token.json"), &saved)
	if err != nil {
		return err
	}
	if !found || saved.Owner == "" || spec.Owner != saved.Owner || !validDesktopPath(spec.Binary) || len(saved.Token) < 16 || len(saved.Token) > 16384 || strings.ContainsAny(saved.Token, "\x00\r\n") {
		return desktopFailure(409, "", "Connector ownership could not be verified")
	}
	file, err := os.CreateTemp(a.directory, "connector-*.token")
	if err != nil {
		return err
	}
	path := file.Name()
	defer os.Remove(path)
	_, err = fmt.Fprintln(file, saved.Token)
	if closeErr := file.Close(); err != nil || closeErr != nil {
		return errors.Join(err, closeErr)
	}
	a.managed.mu.Lock()
	a.managed.connectorID = ""
	a.managed.mu.Unlock()
	// Keep the token file for this process only until cloudflared has consumed
	// it. The protected gateway and its connector are stopped as one deployment.
	err = a.connector.start(desktopLaunch{binary: a.binary, cwd: a.directory, env: desktopConnectorEnvironment(a.directory, a.home), timeout: 90 * time.Second,
		args: []string{"desktop-connector-worker", spec.Binary, path}, ready: func(line string) bool {
			if id, ok := strings.CutPrefix(line, "connector-id:"); ok && desktopGenerationPattern.MatchString(id) {
				a.managed.mu.Lock()
				a.managed.connectorID = id
				a.managed.mu.Unlock()
			}
			return line == "connector-ready"
		}, noRetry: true})
	if err == nil {
		a.log("connector-ready")
	}
	return err
}

func desktopConnectorEnvironment(directory, home string) []string {
	env := []string{"HOME=" + directory, "PATH=" + desktopPath(home)}
	for _, key := range []string{"TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"} {
		if value := os.Getenv(key); value != "" {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func desktopPendingChange(raw json.RawMessage) bool { return len(raw) != 0 && string(raw) != "null" }

func (a *desktopAgent) startProtected() error {
	receipt, err := a.readDeployment()
	if err != nil || receipt == nil || receipt.Phase != "complete" || desktopPendingChange(receipt.IdentityChange) || desktopPendingChange(receipt.ConfigurationChange) {
		return err
	}
	if err := a.assertOwnedDeployment(receipt); err != nil {
		return err
	}
	if a.protected.snapshot().Phase != "running" {
		if err := a.activateProtected(receipt); err != nil {
			return err
		}
	}
	return a.startConnector(receipt.Connector)
}
