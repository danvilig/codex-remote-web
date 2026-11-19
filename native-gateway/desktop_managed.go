package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type desktopManaged struct {
	mu                                     sync.Mutex
	client                                 desktopCloud
	accounts                               []map[string]any
	restoreAttempted, saved                bool
	credentialError                        string
	phase, failure, hostname, verification string
	steps                                  []string
	done                                   chan struct{}
	plan                                   *desktopCloudPlan
	connectorID                            string
}

type desktopCloudPlan struct {
	ID       string
	Input    desktopRemoteInput
	Snapshot desktopCloudSnapshot
	Expires  time.Time
	Previous *desktopDeploymentReceipt
	Source   desktopChangeSource
	Identity bool
}

func (a *desktopAgent) setupBusy() bool {
	a.managed.mu.Lock()
	defer a.managed.mu.Unlock()
	return a.managed.done != nil
}

func (a *desktopAgent) closeSetup() {
	a.managed.mu.Lock()
	done := a.managed.done
	a.managed.mu.Unlock()
	if done != nil {
		<-done
	}
}

func (a *desktopAgent) setupStatus() map[string]any {
	m := &a.managed
	m.mu.Lock()
	defer m.mu.Unlock()
	phase := m.phase
	if phase == "" {
		phase = "idle"
	}
	status := map[string]any{"phase": phase, "steps": append([]string{}, m.steps...), "error": nil, "connected": m.client.token != "", "accounts": append([]map[string]any{}, m.accounts...), "savedCredential": m.saved, "credentialError": nil, "busy": m.done != nil}
	if m.failure != "" {
		status["error"] = m.failure
	}
	if m.credentialError != "" {
		status["credentialError"] = m.credentialError
	}
	if m.hostname != "" {
		status["hostname"] = m.hostname
	}
	if m.verification != "" {
		status["verification"] = m.verification
	}
	return status
}

func (a *desktopAgent) cloudStep(step string) {
	a.managed.mu.Lock()
	defer a.managed.mu.Unlock()
	a.managed.steps = append(a.managed.steps, step)
}

func (a *desktopAgent) cloudClient() (desktopCloud, error) {
	a.managed.mu.Lock()
	defer a.managed.mu.Unlock()
	if a.managed.client.token == "" {
		return desktopCloud{}, desktopFailure(401, "", "Connect your Cloudflare account again.")
	}
	return a.managed.client, nil
}

type desktopCredential struct {
	Version int    `json:"version"`
	Token   string `json:"token"`
}

func (a *desktopAgent) cloudConnect(ctx context.Context, token string, save bool) ([]map[string]any, error) {
	if !desktopCloudToken.MatchString(token) {
		return nil, desktopFailure(400, "", "Enter a valid Cloudflare API token.")
	}
	a.managed.mu.Lock()
	client := desktopCloud{token: token, transport: a.managed.client.transport}
	a.managed.mu.Unlock()
	items, err := client.list(ctx, "/accounts")
	if err != nil {
		return nil, err
	}
	accounts := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if desktopResourceID.MatchString(cloudString(item["id"])) {
			accounts = append(accounts, map[string]any{"id": item["id"], "name": cloudString(item["name"])})
		}
	}
	if save {
		if err := writeDesktopJSON(filepath.Join(a.directory, "management-token.json"), desktopCredential{Version: 1, Token: token}); err != nil {
			return nil, err
		}
	}
	m := &a.managed
	m.mu.Lock()
	defer m.mu.Unlock()
	m.client, m.accounts, m.plan, m.saved, m.restoreAttempted, m.credentialError = client, accounts, nil, true, true, ""
	return accounts, nil
}

func (a *desktopAgent) cloudResume(ctx context.Context) {
	m := &a.managed
	m.mu.Lock()
	if m.client.token != "" || m.done != nil || m.restoreAttempted {
		m.mu.Unlock()
		return
	}
	m.restoreAttempted = true
	m.mu.Unlock()
	var credential desktopCredential
	exists, err := readDesktopJSON(filepath.Join(a.directory, "management-token.json"), &credential)
	if err != nil || exists && (credential.Version != 1 || !desktopCloudToken.MatchString(credential.Token)) {
		err = desktopFailure(400, "", "The saved management token cannot be read securely. Replace or forget it.")
	} else if exists {
		_, err = a.cloudConnect(ctx, credential.Token, false)
	}
	if err != nil {
		m.mu.Lock()
		m.saved = true
		m.credentialError = desktopSafeError(err).Message
		m.mu.Unlock()
	}
}

func (a *desktopAgent) cloudLock(forget bool) error {
	m := &a.managed
	m.mu.Lock()
	defer m.mu.Unlock()
	if forget {
		if err := removeDesktopFile(filepath.Join(a.directory, "management-token.json")); err != nil {
			return err
		}
		m.saved = false
	}
	m.client.token = ""
	m.accounts = nil
	m.plan = nil
	m.restoreAttempted = false
	m.credentialError = ""
	return nil
}

func (a *desktopAgent) cloudDiscover(ctx context.Context, id string) (any, error) {
	client, err := a.cloudClient()
	if err != nil {
		return nil, err
	}
	if !desktopResourceID.MatchString(id) {
		return nil, desktopFailure(400, "", "Select a valid Cloudflare resource.")
	}
	base := "/accounts/" + id
	zones, err := client.list(ctx, "/zones?account.id="+id)
	if err != nil {
		return nil, err
	}
	tunnels, err := client.list(ctx, base+"/cfd_tunnel?is_deleted=false")
	if err != nil {
		return nil, err
	}
	var org map[string]any
	if err := client.get(ctx, base+"/access/organizations", &org); err != nil {
		return nil, err
	}
	team := cloudString(org["auth_domain"])
	if !desktopTeamDomain.MatchString(team) {
		return nil, desktopFailure(400, "", "Complete Zero Trust onboarding and configure a login method in Cloudflare first.")
	}
	zoneList, tunnelList := []map[string]any{}, []map[string]any{}
	for _, zone := range zones {
		zoneList = append(zoneList, map[string]any{"id": zone["id"], "name": zone["name"]})
	}
	for _, tunnel := range tunnels {
		tunnelID := cloudString(tunnel["id"])
		if tunnel["remote_config"] != true || tunnel["deleted_at"] != nil || !desktopResourceID.MatchString(tunnelID) {
			continue
		}
		var connections []map[string]any
		lookupErr := client.get(ctx, base+"/cfd_tunnel/"+tunnelID+"/connections", &connections)
		item := a.connectorSummary(connections)
		item["id"], item["name"], item["status"], item["identityAvailable"] = tunnelID, tunnel["name"], tunnel["status"], lookupErr == nil
		tunnelList = append(tunnelList, item)
	}
	_, createErr := a.connectorBinary()
	return map[string]any{"zones": zoneList, "tunnels": tunnelList, "createAvailable": createErr == nil, "teamDomain": team}, nil
}

func (a *desktopAgent) connectorBinary() (string, error) {
	if a.systemd != nil {
		return a.systemd.connectorBinary()
	}
	binary := desktopExecutable("cloudflared", a.currentConfig().Cloudflared, desktopPath(a.home))
	if binary == "" {
		return "", desktopFailure(400, "", "Install cloudflared on this machine before creating a Tunnel. Then refresh the preview.")
	}
	if _, err := os.Lstat(filepath.Join(a.directory, "tunnel-token.json")); !errors.Is(err, os.ErrNotExist) {
		return "", cloudConflict("A dedicated connector already exists. Remove the managed deployment before creating another one.")
	}
	return binary, nil
}

func (a *desktopAgent) cloudInput(ctx context.Context, client desktopCloud, body json.RawMessage, base desktopRemoteInput) (desktopRemoteInput, error) {
	var raw map[string]json.RawMessage
	if json.Unmarshal(body, &raw) != nil || raw == nil {
		return base, desktopFailure(400, "", "Select a valid Cloudflare resource.")
	}
	if err := json.Unmarshal(body, &base); err != nil {
		return base, desktopFailure(400, "", "Select a valid Cloudflare resource.")
	}
	if value, ok := raw["subdomain"]; ok {
		var name string
		if json.Unmarshal(value, &name) != nil || !desktopResourceID.MatchString(base.ZoneID) {
			return base, desktopFailure(400, "", "Select a valid domain.")
		}
		name = strings.ToLower(strings.TrimSpace(name))
		var zone map[string]any
		if err := client.get(ctx, "/zones/"+base.ZoneID, &zone); err != nil {
			return base, err
		}
		domain := cloudString(zone["name"])
		if name == "@" {
			base.Hostname = domain
		} else {
			if name == domain || strings.HasSuffix(name, "."+domain) {
				return base, desktopFailure(400, "", "Enter only a subdomain, or @ for the selected domain.")
			}
			for _, label := range strings.Split(name, ".") {
				if !desktopSubdomain.MatchString(label) {
					return base, desktopFailure(400, "", "Enter a valid subdomain.")
				}
			}
			base.Hostname = name + "." + domain
		}
	}
	base.Hostname = strings.ToLower(strings.TrimSpace(base.Hostname))
	base.Email = strings.ToLower(strings.TrimSpace(base.Email))
	create := base.TunnelMode == "create"
	if !validCloudInput(base, create) {
		return base, desktopFailure(400, "", "Choose a valid hostname, allowed email, local service port and Cloudflare resources.")
	}
	if create {
		base.TunnelID = ""
		base.TunnelName = strings.TrimSpace(base.TunnelName)
		if base.TunnelName == "" {
			base.TunnelName = "Codex Remote Web"
		}
		if len([]rune(base.TunnelName)) > 60 || strings.ContainsFunc(base.TunnelName, func(r rune) bool { return r < 32 }) {
			return base, desktopFailure(400, "", "Enter a Tunnel name between 1 and 60 characters.")
		}
	} else {
		base.TunnelMode, base.TunnelName = "", ""
	}
	return base, nil
}

func (a *desktopAgent) cloudPreflight(port int, current *desktopDeploymentReceipt) error {
	if a.systemd != nil {
		return a.systemd.preflight(port, current)
	}
	if port == a.currentConfig().Port {
		return cloudConflict("The local gateway and fixed-domain gateway need different ports")
	}
	if current == nil {
		if _, err := os.Lstat(filepath.Join(a.directory, "protected-gateway.json")); !errors.Is(err, os.ErrNotExist) {
			return cloudConflict("A desktop deployment already exists. Recover or remove it first.")
		}
	}
	if current == nil || current.Input.Port != port {
		probe, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			return cloudConflict("The local service port is already in use.")
		}
		probe.Close()
	}
	return nil
}

func (a *desktopAgent) cloudPreview(ctx context.Context, body json.RawMessage, change bool) (any, error) {
	client, err := a.cloudClient()
	if err != nil {
		return nil, err
	}
	old, err := a.readDeployment()
	if err != nil {
		return nil, err
	}
	a.managed.mu.Lock()
	a.managed.plan = nil
	a.managed.mu.Unlock()
	if change {
		return a.cloudPreviewChange(ctx, client, body, old)
	}
	input, err := a.cloudInput(ctx, client, body, desktopRemoteInput{})
	if err != nil {
		return nil, err
	}
	if old != nil && old.Phase != "removed" {
		previous := old.Input
		if old.SourceInput != nil {
			previous = *old.SourceInput
		}
		if old.Phase == "complete" && previous == input {
			return map[string]any{"installed": true, "hostname": input.Hostname, "changes": []string{}, "message": "This workspace is already configured. Run diagnostics or remove the managed deployment."}, nil
		}
		return nil, cloudConflict("A managed deployment already exists. Run diagnostics or remove it before changing the installation.")
	}
	if err := a.cloudPreflight(input.Port, nil); err != nil {
		return nil, err
	}
	create := input.TunnelMode == "create"
	if create {
		if _, err := a.connectorBinary(); err != nil {
			return nil, err
		}
	}
	snapshot, err := a.cloudSnapshot(ctx, client, input, create)
	if err != nil {
		return nil, err
	}
	if err := cloudTargetAvailable(snapshot, input, nil); err != nil {
		return nil, err
	}
	id, err := desktopGeneration()
	if err != nil {
		return nil, err
	}
	pl := &desktopCloudPlan{ID: id, Input: input, Snapshot: snapshot, Expires: time.Now().Add(10 * time.Minute)}
	a.managed.mu.Lock()
	a.managed.plan = pl
	a.managed.mu.Unlock()
	changes := []string{}
	if create {
		changes = append(changes, "Create a dedicated Tunnel and install a local connector without changing existing connectors.")
	}
	changes = append(changes, "Create an Access application allowing only the selected email.", "Install and start a protected user service on the selected loopback port.", "Add one protected route while preserving the existing Tunnel configuration.", "Create a proxied DNS record and check the public login boundary.")
	return map[string]any{"id": id, "hostname": input.Hostname, "expiresAt": pl.Expires.UnixMilli(), "changes": changes, "service": fmt.Sprintf("127.0.0.1:%d", input.Port), "teamDomain": snapshot.TeamDomain}, nil
}

func cloudTargetAvailable(snapshot desktopCloudSnapshot, input desktopRemoteInput, old *desktopDeploymentReceipt) error {
	for _, app := range snapshot.Apps {
		if old == nil || cloudString(app["id"]) != old.AppID || cloudString(app["domain"]) != old.Input.Hostname {
			return cloudConflict("This hostname already has an Access application. Choose an unused subdomain.")
		}
	}
	for _, record := range snapshot.DNS {
		if old == nil || input.Hostname != old.Input.Hostname || !cloudOwnDNS(record, old) {
			return cloudConflict("This hostname already has a DNS record. Choose an unused subdomain.")
		}
	}
	ingress := cloudArray(snapshot.Config["ingress"])
	for _, rule := range ingress {
		if cloudMatchesHost(cloudString(cloudObject(rule)["hostname"]), input.Hostname) && (old == nil || old.Input.TunnelID != input.TunnelID || !cloudSame(rule, old.Route)) {
			return cloudConflict("This hostname matches an existing Tunnel rule. Choose an unused subdomain.")
		}
	}
	if len(ingress) == 0 || cloudString(cloudObject(ingress[len(ingress)-1])["hostname"]) != "" || cloudString(cloudObject(ingress[len(ingress)-1])["path"]) != "" {
		return cloudConflict("The Tunnel must end with a catch-all ingress rule.")
	}
	return nil
}

func (a *desktopAgent) withCloudDiskLock(work func() error) error {
	if err := ensureDesktopDirectory(a.directory); err != nil {
		return err
	}
	path := filepath.Join(a.directory, "setup.lock")
	claim := func() (*os.File, error) {
		return desktopOpen(path, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL, 64, true)
	}
	file, err := claim()
	if errors.Is(err, os.ErrExist) {
		data, readErr := readDesktopFile(path, true)
		if readErr != nil {
			return readErr
		}
		var pid int
		if _, scanErr := fmt.Sscanf(string(data), "%d", &pid); scanErr != nil || pid <= 0 || !processMissing(pid) {
			return cloudConflict("Remote access is managed by another process. Stop it before retrying.")
		}
		// This agent already owns the desktop agent lock, so no other desktop
		// setup operation can race to replace the stale marker.
		if err := removeDesktopFile(path); err != nil {
			return err
		}
		file, err = claim()
	}
	if err != nil {
		return err
	}
	defer removeDesktopFile(path)
	_, err = fmt.Fprint(file, os.Getpid())
	if closeErr := file.Close(); err != nil || closeErr != nil {
		return errors.Join(err, closeErr)
	}
	return work()
}

func (a *desktopAgent) cloudRun(client desktopCloud, work func(context.Context, desktopCloud) error) {
	m := &a.managed
	m.mu.Lock()
	m.done = make(chan struct{})
	m.phase, m.failure, m.hostname, m.verification, m.steps = "running", "", "", "", nil
	done := m.done
	m.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
		defer cancel()
		err := a.withCloudDiskLock(func() error { return work(ctx, client) })
		m.mu.Lock()
		defer m.mu.Unlock()
		if err != nil {
			m.phase = "failed"
			m.failure = desktopSafeError(err).Message
		}
		m.done = nil
		close(done)
	}()
}

func (a *desktopAgent) setupRequest(ctx context.Context, raw json.RawMessage) (any, error) {
	var request struct {
		Path string          `json:"path"`
		Body json.RawMessage `json:"body"`
	}
	if json.Unmarshal(raw, &request) != nil {
		return nil, desktopFailure(400, "", "Invalid desktop setup operation")
	}
	path, query, _ := strings.Cut(request.Path, "?")
	switch path {
	case "session":
		return map[string]any{"unlocked": true, "csrf": "desktop"}, nil
	case "launch":
		return map[string]string{"key": "desktop"}, nil
	case "status":
		a.cloudResume(ctx)
		status := a.setupStatus()
		receipt, err := a.readDeployment()
		if err != nil {
			return nil, err
		}
		status["deployment"] = nil
		if receipt != nil {
			status["deployment"] = map[string]any{"phase": receipt.Phase, "input": receipt.Input, "identityRecovery": desktopPendingChange(receipt.IdentityChange), "configurationRecovery": desktopPendingChange(receipt.ConfigurationChange)}
		}
		if a.systemd != nil {
			status["migrationRequired"], status["migrationPending"] = a.systemdMigrationStatus(receipt)
		}
		return status, nil
	case "quick/status", "quick/start", "quick/stop":
		return a.desktopQuickRequest(ctx, path, request.Body)
	}
	if a.setupBusy() {
		return nil, cloudConflict("A setup operation is already running.")
	}
	if a.systemd != nil && (path == "apply" || path == "preview" || path == "change/preview" || path == "remove" || path == "change/recover") {
		if _, pending := a.systemdMigrationStatus(nil); pending {
			return nil, cloudConflict("Recover the pending systemd migration first.")
		}
	}
	switch path {
	case "resources":
		values, _ := url.ParseQuery(query)
		return a.cloudDiscover(ctx, values.Get("accountId"))
	case "connect":
		var form struct{ Token string }
		_ = json.Unmarshal(request.Body, &form)
		accounts, err := a.cloudConnect(ctx, form.Token, true)
		return map[string]any{"accounts": accounts}, err
	case "preview", "change/preview":
		if path == "preview" && a.systemd == nil && a.local.snapshot().Phase != "running" {
			return nil, cloudConflict("Initialize and start the local gateway first")
		}
		return a.cloudPreview(ctx, request.Body, path != "preview")
	case "apply":
		if a.systemd == nil && a.local.snapshot().Phase != "running" {
			return nil, cloudConflict("Start the local gateway first")
		}
		client, err := a.cloudClient()
		if err != nil {
			return nil, err
		}
		var form struct{ ID string }
		_ = json.Unmarshal(request.Body, &form)
		a.managed.mu.Lock()
		plan := a.managed.plan
		if plan != nil && plan.ID == form.ID && time.Now().Before(plan.Expires) {
			a.managed.plan = nil
		} else {
			plan = nil
		}
		a.managed.mu.Unlock()
		if plan == nil {
			return nil, cloudConflict("The preview expired. Review the changes again.")
		}
		a.cloudRun(client, func(ctx context.Context, client desktopCloud) error {
			if plan.Previous != nil {
				return a.cloudChange(ctx, client, plan)
			}
			return a.cloudApply(ctx, client, plan)
		})
		return a.setupStatus(), nil
	case "migrate":
		if a.systemd == nil {
			return nil, desktopFailure(404, "", "Unknown setup operation")
		}
		a.cloudRun(desktopCloud{}, func(ctx context.Context, _ desktopCloud) error {
			if err := a.migrateSystemd(ctx); err != nil {
				return err
			}
			a.managed.mu.Lock()
			a.managed.phase = "complete"
			a.managed.mu.Unlock()
			a.cloudStep("The managed Linux service now runs the native gateway")
			return nil
		})
		return a.setupStatus(), nil
	case "change/recover", "remove":
		client, err := a.cloudClient()
		if err != nil {
			return nil, err
		}
		a.cloudRun(client, func(ctx context.Context, client desktopCloud) error {
			receipt, err := a.readDeployment()
			if err != nil {
				return err
			}
			if receipt == nil || receipt.Phase == "removed" {
				return cloudConflict("No managed deployment was found.")
			}
			if path == "change/recover" {
				return a.cloudRecover(ctx, client, receipt)
			}
			if desktopPendingChange(receipt.IdentityChange) || desktopPendingChange(receipt.ConfigurationChange) {
				return cloudConflict("Recover the pending configuration change before removing this deployment.")
			}
			if err := a.cloudCleanup(ctx, client, receipt); err != nil {
				return err
			}
			receipt.Phase = "removed"
			if err := a.cloudSave(receipt); err != nil {
				return err
			}
			a.managed.mu.Lock()
			a.managed.phase = "removed"
			a.managed.mu.Unlock()
			a.cloudStep("Managed resources and service removed")
			return nil
		})
		return a.setupStatus(), nil
	case "doctor":
		return a.cloudDoctor(ctx)
	case "credential/forget":
		return map[string]bool{"forgotten": true}, a.cloudLock(true)
	case "credential/retry":
		a.managed.mu.Lock()
		a.managed.restoreAttempted = false
		a.managed.mu.Unlock()
		a.cloudResume(ctx)
		return a.setupStatus(), nil
	case "lock":
		return map[string]bool{"locked": true}, a.cloudLock(false)
	default:
		return nil, desktopFailure(404, "", "Unknown desktop setup operation")
	}
}

func (a *desktopAgent) cloudSave(receipt *desktopDeploymentReceipt) error {
	return writeDesktopJSON(filepath.Join(a.directory, "setup-state.json"), receipt)
}

func (a *desktopAgent) desktopQuickRequest(ctx context.Context, path string, body json.RawMessage) (any, error) {
	if a.local.snapshot().Phase != "running" {
		if path == "quick/status" {
			return map[string]any{"available": false, "running": false, "phase": "stopped"}, nil
		}
		return nil, cloudConflict("Start the local gateway first")
	}
	return desktopGatewaySetupRequest(ctx, a.currentConfig().Port, a.setupCapability, path, body)
}

func desktopGatewaySetupRequest(ctx context.Context, port int, capability, path string, body json.RawMessage) (any, error) {
	origin := fmt.Sprintf("http://127.0.0.1:%d", port)
	method := http.MethodPost
	if path == "quick/status" {
		method = http.MethodGet
	}
	if len(body) == 0 && method == http.MethodPost {
		body = json.RawMessage(`{}`)
	}
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, method, origin+"/api/setup/"+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Origin", origin)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Setup-Request", "1")
	request.Header.Set("X-Desktop-Setup-Capability", capability)
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, desktopStateLimit+1))
	if err != nil || len(data) > desktopStateLimit || !json.Valid(data) {
		return nil, errors.New("Invalid gateway reply")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure desktopError
		_ = json.Unmarshal(data, &failure)
		if failure.Message == "" {
			failure.Message = "Gateway setup request failed"
		}
		failure.Status = response.StatusCode
		return nil, &failure
	}
	return json.RawMessage(data), nil
}
