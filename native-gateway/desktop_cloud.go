package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var (
	desktopResourceID = regexp.MustCompile(`^[a-zA-Z0-9-]{8,64}$`)
	desktopCloudToken = regexp.MustCompile(`^[A-Za-z0-9_.-]{16,512}$`)
	desktopTeamDomain = regexp.MustCompile(`^[a-z0-9-]+\.cloudflareaccess\.com$`)
	desktopHostname   = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
	desktopSubdomain  = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	desktopEmail      = regexp.MustCompile(`^[^\s@*,]+@[^\s@*,]+\.[^\s@*,]+$`)
)

type desktopCloud struct {
	token     string
	transport http.RoundTripper
}

type desktopCloudEnvelope struct {
	Success    bool            `json:"success"`
	Result     json.RawMessage `json:"result"`
	ResultInfo struct {
		TotalPages int `json:"total_pages"`
	} `json:"result_info"`
}

func (c desktopCloud) request(ctx context.Context, method, path string, body any) (desktopCloudEnvelope, error) {
	var data desktopCloudEnvelope
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			return data, err
		}
	}
	networkError := desktopFailure(502, "", "Cloudflare could not be reached. Check your network and retry.")
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, "https://api.cloudflare.com/client/v4"+path, bytes.NewReader(payload))
	if err != nil {
		return data, networkError
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: c.transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return data, networkError
	}
	defer response.Body.Close()
	bodyBytes, err := io.ReadAll(io.LimitReader(response.Body, 4000001))
	if err != nil || len(bodyBytes) > 4000000 || json.Unmarshal(bodyBytes, &data) != nil {
		return data, networkError
	}
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return data, desktopFailure(400, "", "Cloudflare denied access. Check token permissions and account scope.")
	}
	if response.StatusCode == 429 {
		return data, desktopFailure(429, "", "Cloudflare rate limit reached. Try again later.")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || !data.Success {
		return data, desktopFailure(400, "", "Cloudflare rejected the operation. Refresh the preview and retry.")
	}
	return data, nil
}

func (c desktopCloud) result(ctx context.Context, method, path string, body, dest any) error {
	data, err := c.request(ctx, method, path, body)
	if err != nil {
		return err
	}
	if dest != nil && json.Unmarshal(data.Result, dest) != nil {
		return desktopFailure(502, "", "Unexpected Cloudflare response.")
	}
	return nil
}

func (c desktopCloud) get(ctx context.Context, path string, dest any) error {
	return c.result(ctx, http.MethodGet, path, nil, dest)
}

func (c desktopCloud) list(ctx context.Context, path string) ([]map[string]any, error) {
	values := []map[string]any{}
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	for page := 1; page <= 50; page++ {
		data, err := c.request(ctx, http.MethodGet, fmt.Sprintf("%s%spage=%d&per_page=50", path, sep, page), nil)
		if err != nil {
			return nil, err
		}
		var entries []map[string]any
		if json.Unmarshal(data.Result, &entries) != nil || entries == nil {
			return nil, desktopFailure(502, "", "Unexpected Cloudflare response.")
		}
		values = append(values, entries...)
		if data.ResultInfo.TotalPages > 0 && page >= data.ResultInfo.TotalPages || data.ResultInfo.TotalPages == 0 && len(entries) < 50 {
			return values, nil
		}
	}
	return nil, desktopFailure(400, "", "Too many Cloudflare resources. Narrow the API token scope.")
}

func cloudString(value any) string         { text, _ := value.(string); return text }
func cloudObject(value any) map[string]any { object, _ := value.(map[string]any); return object }
func cloudArray(value any) []any           { list, _ := value.([]any); return list }
func cloudSame(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}
func cloudAPPaths(input desktopRemoteInput) (account, applications, dns, tunnel, config string) {
	account = "/accounts/" + input.AccountID
	applications = account + "/access/apps"
	dns = "/zones/" + input.ZoneID + "/dns_records"
	tunnel = account + "/cfd_tunnel/" + input.TunnelID
	config = tunnel + "/configurations"
	return
}
func cloudDNSQuery(path, hostname string) string { return path + "?name=" + url.QueryEscape(hostname) }
func cloudRuleHost(pattern string) string {
	return strings.ToLower(strings.Split(strings.TrimPrefix(strings.TrimPrefix(pattern, "https://"), "http://"), "/")[0])
}
func cloudMatchesHost(pattern, hostname string) bool {
	host := cloudRuleHost(pattern)
	return host == "*" || host == hostname || strings.HasPrefix(host, "*.") && strings.HasSuffix(hostname, host[1:])
}
func cloudAppMatches(app map[string]any, host string) bool {
	if cloudMatchesHost(cloudString(app["domain"]), host) {
		return true
	}
	for _, dest := range cloudArray(app["destinations"]) {
		if cloudMatchesHost(cloudString(cloudObject(dest)["uri"]), host) {
			return true
		}
	}
	return false
}
func cloudConflict(message string) error { return desktopFailure(409, "", message) }
func validCloudInput(input desktopRemoteInput, create bool) bool {
	return desktopResourceID.MatchString(input.AccountID) && desktopResourceID.MatchString(input.ZoneID) &&
		(create || desktopResourceID.MatchString(input.TunnelID)) && input.Port >= 1024 && input.Port <= 65535 &&
		len(input.Hostname) <= 253 && desktopHostname.MatchString(input.Hostname) && len(input.Email) <= 254 && desktopEmail.MatchString(input.Email)
}

type desktopCloudSnapshot struct {
	Config     map[string]any
	Apps, DNS  []map[string]any
	TeamDomain string
	Connectors map[string]any
}

func (a *desktopAgent) connectorSummary(conns []map[string]any) map[string]any {
	a.managed.mu.Lock()
	localID := a.managed.connectorID
	a.managed.mu.Unlock()
	here, elsewhere := 0, 0
	for _, conn := range conns {
		connections := cloudArray(conn["conns"])
		if len(connections) == 0 {
			continue
		}
		id := cloudString(conn["id"])
		if id == "" {
			id = cloudString(cloudObject(connections[0])["client_id"])
		}
		if localID != "" && strings.EqualFold(id, localID) {
			here++
		} else {
			elsewhere++
		}
	}
	return map[string]any{"connectedHere": here, "connectedElsewhere": elsewhere, "local": here > 0, "multipleLocations": here > 0 && elsewhere > 0}
}

func (a *desktopAgent) cloudSnapshot(ctx context.Context, client desktopCloud, input desktopRemoteInput, create bool) (desktopCloudSnapshot, error) {
	var snapshot desktopCloudSnapshot
	base, appPath, dnsPath, tunnelPath, configPath := cloudAPPaths(input)
	var zone, org, tunnel, config map[string]any
	var connections []map[string]any
	var allApps []map[string]any
	jobs := []func() error{
		func() error { return client.get(ctx, "/zones/"+input.ZoneID, &zone) },
		func() error { return client.get(ctx, base+"/access/organizations", &org) },
		func() (err error) { allApps, err = client.list(ctx, appPath); return err },
		func() (err error) {
			snapshot.DNS, err = client.list(ctx, cloudDNSQuery(dnsPath, input.Hostname))
			return err
		},
	}
	if !create {
		jobs = append(jobs, func() error { return client.get(ctx, tunnelPath, &tunnel) }, func() error { return client.get(ctx, configPath, &config) }, func() error { return client.get(ctx, tunnelPath+"/connections", &connections) })
	}
	errs := make(chan error, len(jobs))
	for _, job := range jobs {
		go func() { errs <- job() }()
	}
	var first error
	for range jobs {
		if err := <-errs; first == nil {
			first = err
		}
	}
	if first != nil {
		return snapshot, first
	}
	name := cloudString(zone["name"])
	if name == "" || cloudObject(zone["account"])["id"] != input.AccountID || input.Hostname != name && !strings.HasSuffix(input.Hostname, "."+name) {
		return snapshot, desktopFailure(400, "", "The hostname must belong to the selected account and zone.")
	}
	snapshot.TeamDomain = cloudString(org["auth_domain"])
	if !desktopTeamDomain.MatchString(snapshot.TeamDomain) {
		return snapshot, desktopFailure(400, "", "Cloudflare Team Domain is not configured.")
	}
	for _, app := range allApps {
		if cloudAppMatches(app, input.Hostname) {
			snapshot.Apps = append(snapshot.Apps, app)
		}
	}
	if create {
		snapshot.Config = map[string]any{"ingress": []any{map[string]any{"service": "http_status:404"}}}
		return snapshot, nil
	}
	if tunnel["remote_config"] != true || tunnel["deleted_at"] != nil || tunnel["status"] != "healthy" {
		return snapshot, desktopFailure(400, "", "Select a healthy, remotely managed Tunnel.")
	}
	snapshot.Config = cloudObject(config["config"])
	if len(cloudArray(snapshot.Config["ingress"])) == 0 {
		return snapshot, desktopFailure(400, "", "The Tunnel has no usable ingress configuration.")
	}
	snapshot.Connectors = a.connectorSummary(connections)
	if snapshot.Connectors["multipleLocations"] == true || snapshot.Connectors["local"] != true && !input.ConfirmLocal {
		return snapshot, cloudConflict("The Tunnel could not be verified on this machine alone. Confirm its connector runs here or use a dedicated Tunnel.")
	}
	return snapshot, nil
}
