package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func cloudEmailRules(email string) []any {
	return []any{map[string]any{"email": map[string]any{"email": email}}}
}

func cloudPolicyValid(policy map[string]any, email string) bool {
	return policy["decision"] == "allow" && cloudSame(policy["include"], cloudEmailRules(email)) && len(cloudArray(policy["exclude"])) == 0 && len(cloudArray(policy["require"])) == 0
}

func cloudRoute(input desktopRemoteInput, team, aud string) map[string]any {
	return map[string]any{"hostname": input.Hostname, "service": fmt.Sprintf("http://127.0.0.1:%d", input.Port), "originRequest": map[string]any{"httpHostHeader": input.Hostname, "access": map[string]any{"required": true, "teamName": strings.Split(team, ".")[0], "audTag": []string{aud}}}}
}

func cloudOwnDNS(record map[string]any, receipt *desktopDeploymentReceipt) bool {
	return cloudString(record["id"]) == receipt.DNSID && cloudString(record["name"]) == receipt.Input.Hostname && record["type"] == "CNAME" &&
		cloudString(record["content"]) == receipt.Input.TunnelID+".cfargotunnel.com" && record["proxied"] == true && cloudString(record["comment"]) == receipt.AppName
}

func cloudOwnApp(app map[string]any, receipt *desktopDeploymentReceipt) bool {
	if cloudString(app["id"]) != receipt.AppID || cloudString(app["name"]) != receipt.AppName || cloudString(app["domain"]) != receipt.Input.Hostname || cloudString(app["aud"]) != receipt.AUD {
		return false
	}
	for _, item := range cloudArray(app["destinations"]) {
		if cloudRuleHost(cloudString(cloudObject(item)["uri"])) != receipt.Input.Hostname {
			return false
		}
	}
	for _, item := range cloudArray(app["self_hosted_domains"]) {
		if cloudRuleHost(cloudString(item)) != receipt.Input.Hostname {
			return false
		}
	}
	return true
}

func cloudMakeApp(ctx context.Context, client desktopCloud, receipt *desktopDeploymentReceipt) error {
	_, path, _, _, _ := cloudAPPaths(receipt.Input)
	policy := map[string]any{"name": "Workspace owner", "decision": "allow", "precedence": 1, "include": cloudEmailRules(receipt.Input.Email)}
	body := map[string]any{"name": receipt.AppName, "type": "self_hosted", "domain": receipt.Input.Hostname, "session_duration": "720h", "http_only_cookie": true, "same_site_cookie": "lax", "app_launcher_visible": false, "policies": []any{policy}}
	var result map[string]any
	if err := client.result(ctx, http.MethodPost, path, body, &result); err != nil {
		return err
	}
	receipt.AppID, receipt.AUD = cloudString(result["id"]), cloudString(result["aud"])
	if !desktopResourceID.MatchString(receipt.AppID) || receipt.AUD == "" {
		return cloudConflict("Cloudflare did not return the Access audience.")
	}
	return nil
}

func cloudReadPolicies(ctx context.Context, client desktopCloud, r *desktopDeploymentReceipt) ([]map[string]any, error) {
	_, path, _, _, _ := cloudAPPaths(r.Input)
	if !desktopResourceID.MatchString(r.AppID) {
		return nil, cloudConflict("The Access app identity could not be verified.")
	}
	return client.list(ctx, path+"/"+r.AppID+"/policies")
}

func cloudCreateDNS(ctx context.Context, client desktopCloud, r *desktopDeploymentReceipt) error {
	_, _, path, _, _ := cloudAPPaths(r.Input)
	var record map[string]any
	body := map[string]any{"type": "CNAME", "name": r.Input.Hostname, "content": r.Input.TunnelID + ".cfargotunnel.com", "proxied": true, "ttl": 1, "comment": r.AppName}
	if err := client.result(ctx, http.MethodPost, path, body, &record); err != nil {
		return err
	}
	r.DNSID = cloudString(record["id"])
	if !desktopResourceID.MatchString(r.DNSID) {
		return cloudConflict("Cloudflare did not return a DNS record identity.")
	}
	return nil
}

func cloudReadTunnelConfig(ctx context.Context, client desktopCloud, path string) (map[string]any, error) {
	var value map[string]any
	if err := client.get(ctx, path, &value); err != nil {
		return nil, err
	}
	config := cloudObject(value["config"])
	if len(cloudArray(config["ingress"])) == 0 {
		return nil, cloudConflict("The Tunnel has no usable ingress configuration.")
	}
	return config, nil
}

func (a *desktopAgent) cloudWaitConnector(ctx context.Context, client desktopCloud, input desktopRemoteInput, requireLocal bool) error {
	_, _, _, tunnel, _ := cloudAPPaths(input)
	for attempt := 0; attempt < 20; attempt++ {
		var connections []map[string]any
		if err := client.get(ctx, tunnel+"/connections", &connections); err != nil {
			return err
		}
		summary := a.connectorSummary(connections)
		if summary["multipleLocations"] == true {
			return cloudConflict("The Tunnel has connectors on other machines too. No route was published.")
		}
		if summary["local"] == true || !requireLocal && input.ConfirmLocal {
			return nil
		}
		if !requireLocal {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(750 * time.Millisecond):
		}
	}
	return cloudConflict("The connector did not confirm a local connection. Check cloudflared and retry.")
}

func (a *desktopAgent) cloudInstallNative(ctx context.Context, r *desktopDeploymentReceipt, persist func() error) error {
	if a.systemd != nil {
		return a.systemd.install(ctx, r, persist)
	}
	owner, err := desktopGeneration()
	if err != nil {
		return err
	}
	probe, err := desktopGeneration()
	if err != nil {
		return err
	}
	extra, err := desktopGeneration()
	if err != nil {
		return err
	}
	r.Probe = probe + extra
	config := a.currentConfig()
	config.Port = r.Input.Port
	env := environmentMap(desktopChildEnvironment(a.home, config))
	env["CODEX_WEBUI_AUTH_MODE"] = "cloudflare-access"
	env["CODEX_WEBUI_PUBLIC_ORIGIN"] = "https://" + r.Input.Hostname
	env["CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN"] = r.TeamDomain
	env["CODEX_WEBUI_CF_ACCESS_AUD"] = r.AUD
	env["CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL"] = r.Input.Email
	env["CODEX_WEBUI_SETUP_PROBE"] = r.Probe
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	r.Local = &desktopOwnedEnvironment{Owner: owner, Environment: string(data)}
	if err := persist(); err != nil {
		return err
	}
	if err := writeDesktopJSON(filepath.Join(a.directory, "protected-gateway.json"), r.Local); err != nil {
		return err
	}
	if err := a.activateProtected(r); err != nil {
		return err
	}
	return cloudProtectedReady(ctx, r)
}

func cloudProtectedReady(ctx context.Context, r *desktopDeploymentReceipt) error {
	if r.Probe == "" {
		return cloudConflict("The native service protection could not be verified.")
	}
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/api/setup/ready", r.Input.Port)
	for attempt := 0; attempt < 30; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return err
		}
		request.Header.Set("X-Setup-Probe", r.Probe)
		if response, err := client.Do(request); err == nil {
			var data struct{ Mode, PublicOrigin, Audience, AllowedEmail string }
			readErr := json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&data)
			response.Body.Close()
			if readErr == nil && response.StatusCode == 200 && data.Mode == "cloudflare-access" && data.PublicOrigin == "https://"+r.Input.Hostname && data.Audience == r.AUD && data.AllowedEmail == r.Input.Email {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
	return desktopFailure(500, "", "The native service did not confirm Access protection. The public route was not enabled.")
}

func cloudPublicCheck(ctx context.Context, host, team string) string {
	if !desktopHostname.MatchString(host) || !desktopTeamDomain.MatchString(team) {
		return "pending"
	}
	client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+host+"/", nil)
	if err != nil {
		return "pending"
	}
	request.Header.Set("Cache-Control", "no-cache")
	response, err := client.Do(request)
	if err != nil {
		return "pending"
	}
	response.Body.Close()
	if response.StatusCode < 300 || response.StatusCode >= 400 {
		return "pending"
	}
	u, err := url.Parse(response.Header.Get("Location"))
	if err != nil {
		return "pending"
	}
	u = request.URL.ResolveReference(u)
	if u.Scheme == "https" && u.User == nil && (u.Host == team || u.Host == host) && strings.HasPrefix(u.Path, "/cdn-cgi/access/") {
		return "login-required"
	}
	return "pending"
}

func (a *desktopAgent) cloudComplete(ctx context.Context, r *desktopDeploymentReceipt) {
	verification := cloudPublicCheck(ctx, r.Input.Hostname, r.TeamDomain)
	a.managed.mu.Lock()
	defer a.managed.mu.Unlock()
	a.managed.phase = "complete"
	a.managed.hostname = r.Input.Hostname
	a.managed.verification = verification
}

func (a *desktopAgent) cloudApply(ctx context.Context, client desktopCloud, plan *desktopCloudPlan) error {
	create := plan.Input.TunnelMode == "create"
	snapshot, err := a.cloudSnapshot(ctx, client, plan.Input, create)
	if err != nil {
		return err
	}
	if !cloudSame(snapshot, plan.Snapshot) {
		return cloudConflict("Cloudflare configuration changed since the preview. Refresh the preview.")
	}
	if err := a.cloudPreflight(plan.Input.Port, nil); err != nil {
		return err
	}
	old, err := a.readDeployment()
	if err != nil {
		return err
	}
	if old != nil && old.Phase != "removed" {
		return cloudConflict("A managed deployment already exists.")
	}
	id, err := desktopGeneration()
	if err != nil {
		return err
	}
	r := &desktopDeploymentReceipt{Version: 1, Phase: "applying", Input: plan.Input, SourceInput: &plan.Input, AppName: "Codex Remote Web " + id, TeamDomain: snapshot.TeamDomain}
	persist := func() error { return a.cloudSave(r) }
	if err := persist(); err != nil {
		return err
	}
	err = func() error {
		input := &r.Input
		base, _, dnsPath, _, _ := cloudAPPaths(*input)
		if create {
			binary, err := a.connectorBinary()
			if err != nil {
				return err
			}
			r.CreatedTunnel, r.CreatedTunnelName = true, input.TunnelName+" ("+id+")"
			if err := persist(); err != nil {
				return err
			}
			var tunnel map[string]any
			if err := client.result(ctx, http.MethodPost, base+"/cfd_tunnel", map[string]any{"name": r.CreatedTunnelName, "config_src": "cloudflare"}, &tunnel); err != nil {
				return err
			}
			input.TunnelID = cloudString(tunnel["id"])
			if !desktopResourceID.MatchString(input.TunnelID) {
				return cloudConflict("Cloudflare did not return a Tunnel identity.")
			}
			r.CreatedTunnelID = input.TunnelID
			if err := persist(); err != nil {
				return err
			}
			_, _, _, tunnelPath, configPath := cloudAPPaths(*input)
			if err := client.result(ctx, http.MethodPut, configPath, map[string]any{"config": snapshot.Config}, nil); err != nil {
				return err
			}
			snapshot.Config, err = cloudReadTunnelConfig(ctx, client, configPath)
			if err != nil {
				return err
			}
			r.InitialTunnelConfig = snapshot.Config
			token := cloudString(tunnel["token"])
			if token == "" {
				if err := client.get(ctx, tunnelPath+"/token", &token); err != nil {
					return err
				}
			}
			if len(token) < 16 || len(token) > 16384 || strings.ContainsAny(token, "\x00\r\n") {
				return cloudConflict("Invalid connector token")
			}
			if a.systemd != nil {
				if err := a.systemd.installConnector(binary, token, r, persist); err != nil {
					return err
				}
			} else {
				r.Connector = &desktopOwnedConnector{Binary: binary, Owner: id}
				if err := persist(); err != nil {
					return err
				}
				if err := writeDesktopJSON(filepath.Join(a.directory, "tunnel-token.json"), map[string]string{"owner": id, "token": token}); err != nil {
					return err
				}
				if err := a.startConnector(r.Connector); err != nil {
					return err
				}
			}
			if err := a.cloudWaitConnector(ctx, client, *input, true); err != nil {
				return err
			}
			a.cloudStep("Dedicated Tunnel connected to this machine")
		}
		if err := cloudMakeApp(ctx, client, r); err != nil {
			return err
		}
		if err := persist(); err != nil {
			return err
		}
		policies, err := cloudReadPolicies(ctx, client, r)
		if err != nil {
			return err
		}
		if len(policies) != 1 || !cloudPolicyValid(policies[0], input.Email) {
			return cloudConflict("The Access policy does not match the selected single identity.")
		}
		r.Policy = policies[0]
		if err := persist(); err != nil {
			return err
		}
		a.cloudStep("Access application created")
		if err := a.cloudInstallNative(ctx, r, persist); err != nil {
			return err
		}
		a.cloudStep("Protected native service is ready")
		// Recheck DNS, ingress, connector placement, and the Access ownership
		// immediately before publishing the boundary.
		fresh, err := a.cloudSnapshot(ctx, client, *input, false)
		if err != nil {
			return err
		}
		if fresh.TeamDomain != r.TeamDomain || !cloudSame(fresh.Config, snapshot.Config) || len(fresh.DNS) != 0 || len(fresh.Apps) != 1 || !cloudOwnApp(fresh.Apps[0], r) {
			return cloudConflict("Cloudflare configuration changed during setup. No route was added.")
		}
		if err := a.cloudWaitConnector(ctx, client, *input, create); err != nil {
			return err
		}
		r.Route = cloudRoute(*input, r.TeamDomain, r.AUD)
		r.RouteIntent = true
		if err := persist(); err != nil {
			return err
		}
		_, _, _, _, configPath := cloudAPPaths(*input)
		fresh.Config["ingress"] = append([]any{r.Route}, cloudArray(fresh.Config["ingress"])...)
		if err := client.result(ctx, http.MethodPut, configPath, map[string]any{"config": fresh.Config}, nil); err != nil {
			return err
		}
		verified, err := cloudReadTunnelConfig(ctx, client, configPath)
		if err != nil {
			return err
		}
		if !cloudSame(verified, fresh.Config) {
			return cloudConflict("The protected Tunnel route could not be verified.")
		}
		a.cloudStep("Protected Tunnel route added")
		r.DNSIntent = true
		if err := persist(); err != nil {
			return err
		}
		if err := cloudCreateDNS(ctx, client, r); err != nil {
			return err
		}
		if err := persist(); err != nil {
			return err
		}
		records, err := client.list(ctx, cloudDNSQuery(dnsPath, input.Hostname))
		if err != nil {
			return err
		}
		if len(records) != 1 || !cloudOwnDNS(records[0], r) {
			return cloudConflict("The new DNS record could not be verified.")
		}
		a.cloudStep("DNS record created")
		r.Phase = "complete"
		if err := persist(); err != nil {
			return err
		}
		a.cloudComplete(ctx, r)
		return nil
	}()
	if err == nil {
		return nil
	}
	rollback, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if cleanupErr := a.cloudCleanup(rollback, client, r); cleanupErr == nil {
		r.Phase = "removed"
		a.cloudStep("Changes from this attempt were removed")
	} else {
		r.Phase = "cleanup-required"
		a.cloudStep("Some changes need cleanup. Use Remove managed deployment after reconnecting.")
	}
	return errors.Join(err, persist())
}

func (a *desktopAgent) cloudCleanup(ctx context.Context, client desktopCloud, r *desktopDeploymentReceipt) error {
	if r.Version != 1 || !validCloudInput(r.Input, r.CreatedTunnel && r.Input.TunnelID == "") || !strings.HasPrefix(r.AppName, "Codex Remote Web ") {
		return cloudConflict("The deployment receipt could not be verified. Cleanup stopped.")
	}
	base, appsPath, dnsPath, _, configPath := cloudAPPaths(r.Input)
	if r.RouteIntent {
		if !desktopResourceID.MatchString(r.Input.TunnelID) || r.Route == nil {
			return cloudConflict("The protected route receipt is incomplete.")
		}
		config, err := cloudReadTunnelConfig(ctx, client, configPath)
		if err != nil {
			return err
		}
		before := cloudArray(config["ingress"])
		remaining := make([]any, 0, len(before))
		for _, rule := range before {
			if cloudString(cloudObject(rule)["hostname"]) != r.Input.Hostname {
				remaining = append(remaining, rule)
				continue
			}
			if !cloudSame(rule, r.Route) {
				return cloudConflict("The managed Tunnel route was edited. Cleanup stopped to preserve the change.")
			}
		}
		if len(remaining) != len(before) {
			config["ingress"] = remaining
			if err := client.result(ctx, http.MethodPut, configPath, map[string]any{"config": config}, nil); err != nil {
				return err
			}
		}
	}
	if r.DNSIntent {
		records, err := client.list(ctx, cloudDNSQuery(dnsPath, r.Input.Hostname))
		if err != nil {
			return err
		}
		for _, record := range records {
			id := cloudString(record["id"])
			if !desktopResourceID.MatchString(id) || cloudString(record["name"]) != r.Input.Hostname || record["type"] != "CNAME" || cloudString(record["content"]) != r.Input.TunnelID+".cfargotunnel.com" || record["proxied"] != true || cloudString(record["comment"]) != r.AppName || r.DNSID != "" && id != r.DNSID {
				return cloudConflict("DNS was edited. Cleanup stopped to preserve the change.")
			}
		}
		for _, record := range records {
			if err := client.result(ctx, http.MethodDelete, dnsPath+"/"+cloudString(record["id"]), nil, nil); err != nil {
				return err
			}
		}
	}
	apps, err := client.list(ctx, appsPath)
	if err != nil {
		return err
	}
	for _, app := range apps {
		id := cloudString(app["id"])
		if r.AppID != "" && id != r.AppID || r.AppID == "" && (cloudString(app["name"]) != r.AppName || cloudString(app["domain"]) != r.Input.Hostname) {
			continue
		}
		if !desktopResourceID.MatchString(id) || r.AppID != "" && !cloudOwnApp(app, r) {
			return cloudConflict("The Access app was edited. Cleanup stopped to preserve the change.")
		}
		if r.Policy != nil {
			policies, err := cloudReadPolicies(ctx, client, r)
			if err != nil {
				return err
			}
			if len(policies) != 1 || !cloudSame(policies[0], r.Policy) {
				return cloudConflict("The Access policy was edited. Cleanup stopped to preserve the change.")
			}
		}
		if err := client.result(ctx, http.MethodDelete, appsPath+"/"+id, nil, nil); err != nil {
			return err
		}
	}
	if r.Local != nil {
		if a.systemd != nil {
			if err := a.systemd.removeService(r.Local); err != nil {
				return err
			}
		} else {
			path := filepath.Join(a.directory, "protected-gateway.json")
			if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
				if err := a.assertOwnedDeployment(r); err != nil {
					return err
				}
			}
			a.protected.stop()
			if err := removeDesktopFile(path); err != nil {
				return err
			}
		}
	}
	if r.CreatedTunnel {
		tunnels, err := client.list(ctx, base+"/cfd_tunnel?is_deleted=false")
		if err != nil {
			return err
		}
		for _, tunnel := range tunnels {
			id := cloudString(tunnel["id"])
			name := cloudString(tunnel["name"])
			if (r.CreatedTunnelID == "" || id != r.CreatedTunnelID) && name != r.CreatedTunnelName {
				continue
			}
			if name != r.CreatedTunnelName || !desktopResourceID.MatchString(id) || r.CreatedTunnelID != "" && id != r.CreatedTunnelID {
				return cloudConflict("The dedicated Tunnel was edited. Cleanup stopped to preserve it.")
			}
			path := base + "/cfd_tunnel/" + id
			var current map[string]any
			if err := client.get(ctx, path+"/configurations", &current); err != nil {
				return err
			}
			config := cloudObject(current["config"])
			if r.InitialTunnelConfig != nil && !cloudSame(config, r.InitialTunnelConfig) {
				return cloudConflict("The dedicated Tunnel now contains other configuration. It was preserved.")
			}
			if r.InitialTunnelConfig == nil {
				for _, rule := range cloudArray(config["ingress"]) {
					fields := cloudObject(rule)
					if fields["hostname"] != nil || fields["path"] != nil || fields["service"] != "http_status:404" {
						return cloudConflict("The dedicated Tunnel now contains other routes. It was preserved.")
					}
				}
			}
			if err := a.cloudRemoveConnector(r.Connector); err != nil {
				return err
			}
			if err := client.result(ctx, http.MethodDelete, path, nil, nil); err != nil {
				return err
			}
		}
		return a.cloudRemoveConnector(r.Connector)
	}
	return nil
}

func (a *desktopAgent) cloudRemoveConnector(owner *desktopOwnedConnector) error {
	if owner == nil {
		return nil
	}
	if a.systemd != nil {
		return a.systemd.removeConnector(owner)
	}
	path := filepath.Join(a.directory, "tunnel-token.json")
	var current struct{ Owner string }
	if found, err := readDesktopJSON(path, &current); err != nil {
		return err
	} else if found && (current.Owner == "" || current.Owner != owner.Owner) {
		return cloudConflict("Connector ownership changed. Cleanup stopped.")
	}
	a.connector.stop()
	a.managed.mu.Lock()
	a.managed.connectorID = ""
	a.managed.mu.Unlock()
	return removeDesktopFile(path)
}

func (a *desktopAgent) cloudDoctor(ctx context.Context) (any, error) {
	r, err := a.readDeployment()
	if err != nil {
		return nil, err
	}
	if r == nil || r.Phase == "removed" {
		return map[string]any{"installed": false, "checks": []any{}}, nil
	}
	client, err := a.cloudClient()
	if err != nil {
		return nil, err
	}
	valid := validCloudInput(r.Input, false)
	protected := valid && a.assertOwnedDeployment(r) == nil && cloudProtectedReady(ctx, r) == nil
	resources := false
	if valid {
		input := r.Input
		input.ConfirmLocal = true
		if snapshot, err := a.cloudSnapshot(ctx, client, input, false); err == nil && len(snapshot.Apps) == 1 && cloudOwnApp(snapshot.Apps[0], r) && len(snapshot.DNS) == 1 && cloudOwnDNS(snapshot.DNS[0], r) {
			for _, rule := range cloudArray(snapshot.Config["ingress"]) {
				if cloudSame(rule, r.Route) {
					policies, err := cloudReadPolicies(ctx, client, r)
					resources = err == nil && len(policies) == 1 && cloudPolicyValid(policies[0], r.Input.Email)
					break
				}
			}
		}
	}
	return map[string]any{"installed": true, "hostname": r.Input.Hostname, "phase": r.Phase, "checks": []map[string]any{{"label": "Native service requires Access", "ok": protected}, {"label": "Cloudflare resources match this deployment", "ok": resources}, {"label": "Public address redirects to Access login", "ok": valid && cloudPublicCheck(ctx, r.Input.Hostname, r.TeamDomain) == "login-required"}}}, nil
}
