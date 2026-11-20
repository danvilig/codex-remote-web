package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"time"
)

type desktopChangeSource struct {
	Config map[string]any `json:"config"`
	DNS    map[string]any `json:"dns"`
	Policy map[string]any `json:"policy"`
	App    map[string]any `json:"app"`
}

type desktopCloudChange struct {
	Previous     *desktopDeploymentReceipt `json:"previous"`
	Candidate    *desktopDeploymentReceipt `json:"candidate"`
	Source       desktopChangeSource       `json:"source"`
	AppIntent    bool                      `json:"appIntent,omitempty"`
	PolicyIntent bool                      `json:"policyIntent,omitempty"`
	NativeIntent bool                      `json:"nativeIntent,omitempty"`
	RouteIntent  bool                      `json:"routeIntent,omitempty"`
	DNSIntent    bool                      `json:"dnsIntent,omitempty"`
	Committed    bool                      `json:"committed,omitempty"`
}

func cloudClone[T any](value T) T {
	var clone T
	b, _ := json.Marshal(value)
	_ = json.Unmarshal(b, &clone)
	return clone
}

func cloudCompareFields(a, b map[string]any, ignored ...string) bool {
	a, b = cloudClone(a), cloudClone(b)
	for _, name := range ignored {
		delete(a, name)
		delete(b, name)
	}
	return cloudSame(a, b)
}

func cloudSamePolicy(a, b map[string]any) bool {
	return cloudCompareFields(a, b, "created_at", "updated_at")
}
func cloudSameDNS(a, b map[string]any) bool {
	return cloudCompareFields(a, b, "created_on", "modified_on", "comment_modified_on", "tags_modified_on", "meta")
}
func cloudSameApp(a, b map[string]any) bool {
	return cloudCompareFields(a, b, "created_at", "updated_at")
}
func cloudSamePlace(a, b desktopRemoteInput) bool {
	return a.ZoneID == b.ZoneID && a.Hostname == b.Hostname
}
func cloudSameRoute(a, b desktopRemoteInput) bool {
	return a.TunnelID == b.TunnelID && a.Hostname == b.Hostname
}

func cloudVerifyPolicy(ctx context.Context, client desktopCloud, r *desktopDeploymentReceipt) (map[string]any, error) {
	policies, err := cloudReadPolicies(ctx, client, r)
	if err != nil {
		return nil, err
	}
	if len(policies) != 1 {
		return nil, cloudConflict("The managed deployment does not have one Access policy.")
	}
	return policies[0], nil
}

func cloudSourceState(ctx context.Context, client desktopCloud, r *desktopDeploymentReceipt) (desktopChangeSource, error) {
	var source desktopChangeSource
	if !validCloudInput(r.Input, false) || !desktopResourceID.MatchString(r.AppID) {
		return source, cloudConflict("The existing deployment receipt is invalid.")
	}
	_, appPath, dnsPath, _, configPath := cloudAPPaths(r.Input)
	policy, err := cloudVerifyPolicy(ctx, client, r)
	if err != nil {
		return source, err
	}
	if !cloudSamePolicy(policy, r.Policy) || !cloudPolicyValid(policy, r.Input.Email) {
		return source, cloudConflict("The Access policy was edited. No update was applied.")
	}
	source.Policy = policy
	if err := client.get(ctx, appPath+"/"+r.AppID, &source.App); err != nil {
		return source, err
	}
	if !cloudOwnApp(source.App, r) {
		return source, cloudConflict("The managed Access application changed.")
	}
	source.Config, err = cloudReadTunnelConfig(ctx, client, configPath)
	if err != nil {
		return source, err
	}
	matching := 0
	for _, rule := range cloudArray(source.Config["ingress"]) {
		if cloudString(cloudObject(rule)["hostname"]) == r.Input.Hostname {
			matching++
			if !cloudSame(rule, r.Route) {
				return source, cloudConflict("The managed Tunnel route was edited.")
			}
		}
	}
	if matching != 1 {
		return source, cloudConflict("The managed Tunnel route could not be verified.")
	}
	records, err := client.list(ctx, cloudDNSQuery(dnsPath, r.Input.Hostname))
	if err != nil {
		return source, err
	}
	if len(records) != 1 || !cloudOwnDNS(records[0], r) {
		return source, cloudConflict("DNS was edited. No update was applied.")
	}
	source.DNS = records[0]
	return source, nil
}

func (a *desktopAgent) cloudPreviewChange(ctx context.Context, client desktopCloud, body json.RawMessage, old *desktopDeploymentReceipt) (any, error) {
	if old == nil || old.Phase != "complete" || desktopPendingChange(old.ConfigurationChange) || desktopPendingChange(old.IdentityChange) {
		return nil, cloudConflict("Complete or recover the managed deployment before changing its configuration.")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil || fields == nil {
		return nil, desktopFailure(400, "", "Select a valid Cloudflare resource.")
	}
	identity := len(fields) == 1 && fields["email"] != nil
	base := desktopRemoteInput{}
	if identity {
		base = old.Input
		base.TunnelMode = ""
	}
	input, err := a.cloudInput(ctx, client, body, base)
	if err != nil {
		return nil, err
	}
	if input.TunnelMode == "create" || input.AccountID != old.Input.AccountID {
		return nil, cloudConflict("Select an existing Tunnel in the current Cloudflare account.")
	}
	if cloudSamePlace(input, old.Input) && input.TunnelID == old.Input.TunnelID && input.Email == old.Input.Email && input.Port == old.Input.Port {
		return map[string]bool{"unchanged": true}, nil
	}
	if err := a.assertOwnedDeployment(old); err != nil {
		return nil, err
	}
	if err := a.cloudPreflight(input.Port, old); err != nil {
		return nil, err
	}
	source, err := cloudSourceState(ctx, client, old)
	if err != nil {
		return nil, err
	}
	var snapshot desktopCloudSnapshot
	if !identity {
		snapshot, err = a.cloudSnapshot(ctx, client, input, false)
		if err != nil {
			return nil, err
		}
		if snapshot.TeamDomain != old.TeamDomain {
			return nil, cloudConflict("The Cloudflare Team Domain changed.")
		}
		if err := cloudTargetAvailable(snapshot, input, old); err != nil {
			return nil, err
		}
	}
	id, err := desktopGeneration()
	if err != nil {
		return nil, err
	}
	plan := &desktopCloudPlan{ID: id, Input: input, Snapshot: snapshot, Source: source, Previous: old, Identity: identity, Expires: time.Now().Add(10 * time.Minute)}
	a.managed.mu.Lock()
	a.managed.plan = plan
	a.managed.mu.Unlock()
	if identity {
		return map[string]any{"id": id, "hostname": input.Hostname, "previousEmail": old.Input.Email, "email": input.Email, "changes": []string{"Update the single allowed email in Cloudflare Access.", "Restart the protected service with the new identity. Existing connections and web terminals will disconnect."}}, nil
	}
	differences := []map[string]string{}
	for _, item := range [][3]string{{"Public hostname", old.Input.Hostname, input.Hostname}, {"Domain", old.Input.ZoneID, input.ZoneID}, {"Existing Tunnel", old.Input.TunnelID, input.TunnelID}, {"Local service port", fmt.Sprint(old.Input.Port), fmt.Sprint(input.Port)}, {"Allowed email", old.Input.Email, input.Email}} {
		if item[1] != item[2] {
			differences = append(differences, map[string]string{"label": item[0], "before": item[1], "after": item[2]})
		}
	}
	return map[string]any{"id": id, "kind": "configuration", "hostname": input.Hostname, "service": fmt.Sprintf("127.0.0.1:%d", input.Port), "differences": differences, "changes": []string{"Restart the protected service and move the managed Cloudflare route. Existing connections and web terminals will disconnect.", "Remove the previous hostname resources only after the new protected route is ready. Other resources are preserved."}}, nil
}

func cloudWritePolicy(ctx context.Context, client desktopCloud, receipt *desktopDeploymentReceipt, allowed, desired map[string]any) (map[string]any, error) {
	current, err := cloudVerifyPolicy(ctx, client, receipt)
	if err != nil {
		return nil, err
	}
	if cloudSamePolicy(current, desired) {
		return current, nil
	}
	policyID := cloudString(current["id"])
	if !cloudSamePolicy(current, allowed) || !desktopResourceID.MatchString(policyID) {
		return nil, cloudConflict("The Access policy changed. The edit was preserved.")
	}
	_, appPath, _, _, _ := cloudAPPaths(receipt.Input)
	payload := map[string]any{}
	for _, key := range []string{"name", "decision", "include", "exclude", "require", "precedence", "session_duration", "approval_groups", "approval_required", "isolation_required", "purpose_justification_prompt", "purpose_justification_required"} {
		if value, ok := desired[key]; ok {
			payload[key] = value
		}
	}
	if err := client.result(ctx, http.MethodPut, appPath+"/"+receipt.AppID+"/policies/"+policyID, payload, nil); err != nil {
		return nil, err
	}
	verified, err := cloudVerifyPolicy(ctx, client, receipt)
	if err != nil {
		return nil, err
	}
	if !cloudSamePolicy(verified, desired) {
		return nil, cloudConflict("The updated Access policy could not be verified.")
	}
	return verified, nil
}

func cloudChangeRoute(ctx context.Context, client desktopCloud, r *desktopDeploymentReceipt, next map[string]any, allowed ...map[string]any) error {
	_, _, _, _, path := cloudAPPaths(r.Input)
	config, err := cloudReadTunnelConfig(ctx, client, path)
	if err != nil {
		return err
	}
	before := cloudArray(config["ingress"])
	after := []any{}
	if next != nil {
		after = append(after, next)
	}
	for _, rule := range before {
		host := cloudString(cloudObject(rule)["hostname"])
		if host != r.Input.Hostname {
			if next != nil && cloudMatchesHost(host, r.Input.Hostname) {
				return cloudConflict("This hostname conflicts with an existing Tunnel route.")
			}
			after = append(after, rule)
			continue
		}
		match := false
		for _, value := range allowed {
			if value != nil && cloudSame(value, rule) {
				match = true
				break
			}
		}
		if !match {
			return cloudConflict("The managed Tunnel route was edited. Recovery stopped to preserve it.")
		}
	}
	if !cloudSame(before, after) {
		config["ingress"] = after
		if err := client.result(ctx, http.MethodPut, path, map[string]any{"config": config}, nil); err != nil {
			return err
		}
	}
	verified, err := cloudReadTunnelConfig(ctx, client, path)
	if err != nil {
		return err
	}
	if !cloudSame(verified["ingress"], after) {
		return cloudConflict("The managed Tunnel route could not be verified.")
	}
	return nil
}

func cloudChangeDNS(ctx context.Context, client desktopCloud, r *desktopDeploymentReceipt, expected map[string]any, from, to string) error {
	_, _, path, _, _ := cloudAPPaths(r.Input)
	records, err := client.list(ctx, cloudDNSQuery(path, r.Input.Hostname))
	if err != nil {
		return err
	}
	if len(records) != 1 || !desktopResourceID.MatchString(r.DNSID) {
		return cloudConflict("DNS was edited. Recovery stopped to preserve it.")
	}
	old, new := cloudClone(expected), cloudClone(expected)
	old["content"] = from
	new["content"] = to
	if cloudSameDNS(records[0], new) {
		return nil
	}
	if !cloudSameDNS(records[0], old) {
		return cloudConflict("DNS was edited. Recovery stopped to preserve it.")
	}
	if err := client.result(ctx, http.MethodPatch, path+"/"+r.DNSID, map[string]string{"content": to}, nil); err != nil {
		return err
	}
	verified, err := client.list(ctx, cloudDNSQuery(path, r.Input.Hostname))
	if err != nil {
		return err
	}
	if len(verified) != 1 || !cloudSameDNS(verified[0], new) {
		return cloudConflict("The DNS record could not be verified.")
	}
	return nil
}

func cloudDeleteChangeDNS(ctx context.Context, client desktopCloud, r *desktopDeploymentReceipt, expected map[string]any) error {
	_, _, path, _, _ := cloudAPPaths(r.Input)
	records, err := client.list(ctx, cloudDNSQuery(path, r.Input.Hostname))
	if err != nil {
		return err
	}
	for _, record := range records {
		id := cloudString(record["id"])
		if (r.DNSID == "" || id != r.DNSID) && cloudString(record["comment"]) != r.AppName {
			continue
		}
		owned := *r
		if owned.DNSID == "" {
			owned.DNSID = id
		}
		if !desktopResourceID.MatchString(id) || !cloudOwnDNS(record, &owned) || expected != nil && !cloudSameDNS(record, expected) {
			return cloudConflict("DNS was edited. Recovery stopped to preserve it.")
		}
		if err := client.result(ctx, http.MethodDelete, path+"/"+id, nil, nil); err != nil {
			return err
		}
	}
	return nil
}

func cloudDeleteChangeApp(ctx context.Context, client desktopCloud, r *desktopDeploymentReceipt, expected map[string]any) error {
	_, path, _, _, _ := cloudAPPaths(r.Input)
	apps, err := client.list(ctx, path)
	if err != nil {
		return err
	}
	for _, listed := range apps {
		id := cloudString(listed["id"])
		if (r.AppID == "" || id != r.AppID) && cloudString(listed["name"]) != r.AppName {
			continue
		}
		if !desktopResourceID.MatchString(id) {
			return cloudConflict("The Access app identity could not be verified.")
		}
		var app map[string]any
		if err := client.get(ctx, path+"/"+id, &app); err != nil {
			return err
		}
		owned := *r
		if owned.AppID == "" {
			owned.AppID, owned.AUD = id, cloudString(app["aud"])
		}
		if !cloudOwnApp(app, &owned) || expected != nil && !cloudSameApp(app, expected) {
			return cloudConflict("The Access app was edited. Recovery stopped to preserve it.")
		}
		policy, err := cloudVerifyPolicy(ctx, client, &owned)
		if err != nil {
			return err
		}
		if !cloudPolicyValid(policy, r.Input.Email) || r.Policy != nil && !cloudSamePolicy(policy, r.Policy) {
			return cloudConflict("The Access policy was edited. Recovery stopped to preserve it.")
		}
		if err := client.result(ctx, http.MethodDelete, path+"/"+id, nil, nil); err != nil {
			return err
		}
	}
	return nil
}

func (a *desktopAgent) saveCloudChange(current *desktopDeploymentReceipt, change *desktopCloudChange) error {
	data, err := json.Marshal(change)
	if err != nil {
		return err
	}
	current.ConfigurationChange = data
	return a.cloudSave(current)
}

func (a *desktopAgent) cloudChange(ctx context.Context, client desktopCloud, plan *desktopCloudPlan) error {
	current, err := a.readDeployment()
	if err != nil {
		return err
	}
	if !cloudSame(current, plan.Previous) {
		return cloudConflict("The deployment changed. Preview the change again.")
	}
	old := plan.Previous
	if err := a.assertOwnedDeployment(old); err != nil {
		return err
	}
	if err := a.cloudPreflight(plan.Input.Port, old); err != nil {
		return err
	}
	source, err := cloudSourceState(ctx, client, old)
	if err != nil {
		return err
	}
	if !cloudSame(source, plan.Source) {
		return cloudConflict("Cloudflare configuration changed since the preview. Refresh the preview.")
	}
	if !plan.Identity {
		snapshot, err := a.cloudSnapshot(ctx, client, plan.Input, false)
		if err != nil {
			return err
		}
		if !cloudSame(snapshot, plan.Snapshot) {
			return cloudConflict("Cloudflare configuration changed since the preview. Refresh the preview.")
		}
		if err := cloudTargetAvailable(snapshot, plan.Input, old); err != nil {
			return err
		}
	}
	next := cloudClone(old)
	next.Input = plan.Input
	next.SourceInput = &plan.Input
	if next.CreatedTunnel && next.CreatedTunnelID == "" {
		next.CreatedTunnelID = old.Input.TunnelID
	}
	if plan.Identity && old.SourceInput != nil {
		sourceInput := *old.SourceInput
		sourceInput.Email = next.Input.Email
		next.SourceInput = &sourceInput
	}
	newHost := next.Input.Hostname != old.Input.Hostname
	if newHost {
		next.AppName = "Codex Remote Web " + plan.ID
		next.AppID, next.AUD, next.DNSID = "", "", ""
		next.Policy, next.AppSnapshot = nil, nil
	}
	current.Phase = "updating"
	change := &desktopCloudChange{Previous: old, Candidate: next, Source: source}
	persist := func() error { return a.saveCloudChange(current, change) }
	if err := persist(); err != nil {
		return err
	}
	err = func() error {
		if newHost {
			change.AppIntent = true
			if err := persist(); err != nil {
				return err
			}
			if err := cloudMakeApp(ctx, client, next); err != nil {
				return err
			}
			if err := persist(); err != nil {
				return err
			}
			policy, err := cloudVerifyPolicy(ctx, client, next)
			if err != nil {
				return err
			}
			if !cloudPolicyValid(policy, next.Input.Email) {
				return cloudConflict("The Access policy does not match the selected single identity.")
			}
			next.Policy = policy
			_, path, _, _, _ := cloudAPPaths(next.Input)
			if err := client.get(ctx, path+"/"+next.AppID, &next.AppSnapshot); err != nil {
				return err
			}
			if err := persist(); err != nil {
				return err
			}
		} else if next.Input.Email != old.Input.Email {
			next.Policy = cloudClone(old.Policy)
			next.Policy["include"] = cloudEmailRules(next.Input.Email)
			change.PolicyIntent = true
			if err := persist(); err != nil {
				return err
			}
			policy, err := cloudWritePolicy(ctx, client, old, old.Policy, next.Policy)
			if err != nil {
				return err
			}
			next.Policy = policy
			if err := persist(); err != nil {
				return err
			}
		}
		next.Route = cloudRoute(next.Input, next.TeamDomain, next.AUD)
		if plan.Identity {
			next.Route = old.Route
		}
		environment, err := a.cloudUpdatedEnvironment(old, next)
		if err != nil {
			return err
		}
		next.Local.Environment = environment
		change.NativeIntent = true
		if err := persist(); err != nil {
			return err
		}
		if err := a.cloudConfigureLocal(ctx, next, old.Local.Environment); err != nil {
			return err
		}
		a.cloudStep("Protected service configuration updated")
		if !plan.Identity {
			fresh, err := a.cloudSnapshot(ctx, client, next.Input, false)
			if err != nil {
				return err
			}
			if fresh.TeamDomain != next.TeamDomain || len(fresh.Apps) != 1 || !cloudOwnApp(fresh.Apps[0], next) {
				return cloudConflict("Another Access application conflicts with the new hostname.")
			}
			if err := cloudWaitExpectedDNS(fresh.DNS, old, next); err != nil {
				return err
			}
			change.RouteIntent = true
			if err := persist(); err != nil {
				return err
			}
			var allowed []map[string]any
			if cloudSameRoute(old.Input, next.Input) {
				allowed = append(allowed, old.Route)
			}
			if err := cloudChangeRoute(ctx, client, next, next.Route, allowed...); err != nil {
				return err
			}
			a.cloudStep("Protected Tunnel route updated")
			change.DNSIntent = true
			if err := persist(); err != nil {
				return err
			}
			if cloudSamePlace(old.Input, next.Input) {
				if err := cloudChangeDNS(ctx, client, old, source.DNS, old.Input.TunnelID+".cfargotunnel.com", next.Input.TunnelID+".cfargotunnel.com"); err != nil {
					return err
				}
			} else {
				if err := cloudCreateDNS(ctx, client, next); err != nil {
					return err
				}
				if err := persist(); err != nil {
					return err
				}
			}
			_, _, path, _, _ := cloudAPPaths(next.Input)
			records, err := client.list(ctx, cloudDNSQuery(path, next.Input.Hostname))
			if err != nil {
				return err
			}
			if len(records) != 1 || !cloudOwnDNS(records[0], next) {
				return cloudConflict("The new DNS record could not be verified.")
			}
		}
		change.Committed = true
		if err := persist(); err != nil {
			return err
		}
		return a.finishCloudChange(ctx, client, change)
	}()
	if err == nil {
		a.cloudStep("Cloudflare configuration updated")
		a.cloudComplete(ctx, next)
		return nil
	}
	rollback, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if recoverErr := a.restoreCloudChange(rollback, client, change); recoverErr != nil {
		current.Phase = "change-recovery-required"
		return errors.Join(err, persist())
	}
	if change.Committed {
		a.cloudComplete(rollback, next)
		return nil
	}
	a.cloudStep("Previous configuration restored")
	return err
}

func cloudWaitExpectedDNS(records []map[string]any, old, next *desktopDeploymentReceipt) error {
	if cloudSamePlace(old.Input, next.Input) {
		if len(records) == 1 && cloudOwnDNS(records[0], old) {
			return nil
		}
	} else if len(records) == 0 {
		return nil
	}
	return cloudConflict("DNS changed during the update.")
}

func (a *desktopAgent) finishCloudChange(ctx context.Context, client desktopCloud, change *desktopCloudChange) error {
	old, next := change.Previous, change.Candidate
	if !cloudSameRoute(old.Input, next.Input) {
		if err := cloudChangeRoute(ctx, client, old, nil, old.Route); err != nil {
			return err
		}
	}
	if !cloudSamePlace(old.Input, next.Input) {
		if err := cloudDeleteChangeDNS(ctx, client, old, change.Source.DNS); err != nil {
			return err
		}
	}
	if old.AppID != next.AppID {
		if err := cloudDeleteChangeApp(ctx, client, old, change.Source.App); err != nil {
			return err
		}
	}
	next.Phase = "complete"
	return a.cloudSave(next)
}

func (a *desktopAgent) restoreCloudChange(ctx context.Context, client desktopCloud, change *desktopCloudChange) error {
	old, next := change.Previous, change.Candidate
	if old == nil || next == nil || old.Local == nil || next.Local == nil || !validCloudInput(old.Input, false) || !validCloudInput(next.Input, false) || old.Input.AccountID != next.Input.AccountID {
		return cloudConflict("The configuration recovery record could not be verified.")
	}
	if err := a.assertOwnedDeployment(next, old.Local.Environment); err != nil {
		return err
	}
	if change.Committed {
		if err := a.assertOwnedDeployment(next); err != nil {
			return err
		}
		if _, err := cloudSourceState(ctx, client, next); err != nil {
			return err
		}
		return a.finishCloudChange(ctx, client, change)
	}
	if change.RouteIntent {
		if cloudSameRoute(old.Input, next.Input) {
			if err := cloudChangeRoute(ctx, client, old, old.Route, old.Route, next.Route); err != nil {
				return err
			}
		} else if err := cloudChangeRoute(ctx, client, next, nil, next.Route); err != nil {
			return err
		}
	}
	if change.DNSIntent {
		if cloudSamePlace(old.Input, next.Input) {
			if err := cloudChangeDNS(ctx, client, old, change.Source.DNS, next.Input.TunnelID+".cfargotunnel.com", old.Input.TunnelID+".cfargotunnel.com"); err != nil {
				return err
			}
		} else if err := cloudDeleteChangeDNS(ctx, client, next, nil); err != nil {
			return err
		}
	}
	if change.PolicyIntent {
		if _, err := cloudWritePolicy(ctx, client, old, next.Policy, old.Policy); err != nil {
			return err
		}
	}
	if change.NativeIntent {
		if err := a.cloudConfigureLocal(ctx, old, next.Local.Environment); err != nil {
			return err
		}
	}
	if change.AppIntent {
		if err := cloudDeleteChangeApp(ctx, client, next, next.AppSnapshot); err != nil {
			return err
		}
	}
	old.Phase = "complete"
	return a.cloudSave(old)
}

func (a *desktopAgent) cloudRecover(ctx context.Context, client desktopCloud, r *desktopDeploymentReceipt) error {
	if desktopPendingChange(r.ConfigurationChange) {
		var change desktopCloudChange
		if json.Unmarshal(r.ConfigurationChange, &change) != nil {
			return cloudConflict("The configuration recovery record could not be verified.")
		}
		if err := a.restoreCloudChange(ctx, client, &change); err != nil {
			return err
		}
		if change.Committed {
			r = change.Candidate
		} else {
			r = change.Previous
		}
	} else if desktopPendingChange(r.IdentityChange) {
		var change struct {
			Input              desktopRemoteInput
			Local              *desktopOwnedEnvironment
			Policy, NextPolicy map[string]any
		}
		if json.Unmarshal(r.IdentityChange, &change) != nil || change.Local == nil || !validCloudInput(change.Input, false) || !validCloudInput(r.Input, false) || change.Input.AccountID != r.Input.AccountID {
			return cloudConflict("The identity recovery record could not be verified.")
		}
		if err := a.assertOwnedDeployment(r, change.Local.Environment); err != nil {
			return err
		}
		if _, err := cloudWritePolicy(ctx, client, r, change.NextPolicy, change.Policy); err != nil {
			return err
		}
		currentEnvironment := r.Local.Environment
		r.Input, r.Local, r.Policy = change.Input, change.Local, change.Policy
		if err := a.cloudConfigureLocal(ctx, r, currentEnvironment); err != nil {
			return err
		}
		r.Phase, r.IdentityChange = "complete", nil
		if err := a.cloudSave(r); err != nil {
			return err
		}
	} else {
		return cloudConflict("No configuration change needs recovery.")
	}
	a.cloudStep("Configuration recovery completed")
	a.cloudComplete(ctx, r)
	return nil
}

func (a *desktopAgent) cloudUpdatedEnvironment(old, next *desktopDeploymentReceipt) (string, error) {
	if a.systemd != nil {
		return a.systemd.updatedEnvironment(old, next)
	}
	var environment map[string]string
	if err := json.Unmarshal([]byte(old.Local.Environment), &environment); err != nil || environment == nil {
		return "", cloudConflict("The protected gateway environment is invalid.")
	}
	environment["PORT"] = fmt.Sprint(next.Input.Port)
	environment["CODEX_WEBUI_PUBLIC_ORIGIN"] = "https://" + next.Input.Hostname
	environment["CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL"] = next.Input.Email
	environment["CODEX_WEBUI_CF_ACCESS_AUD"] = next.AUD
	data, err := json.Marshal(environment)
	return string(data), err
}

func (a *desktopAgent) cloudConfigureLocal(ctx context.Context, r *desktopDeploymentReceipt, alternatives ...string) error {
	if a.systemd != nil {
		return a.systemd.configure(ctx, r, alternatives...)
	}
	if err := a.assertOwnedDeployment(r, alternatives...); err != nil {
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
