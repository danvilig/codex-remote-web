package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

type desktopCloudFixture func(*http.Request) (*http.Response, error)

func (f desktopCloudFixture) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func cloudFixtureResponse(result any) (*http.Response, error) {
	body, err := json.Marshal(map[string]any{"success": true, "result": result})
	if err != nil {
		return nil, err
	}
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
}

func TestDesktopCloudPreviewKeepsMutationsBehindConfirmation(t *testing.T) {
	home := t.TempDir()
	directory := desktopDirectory(home)
	if err := ensureDesktopDirectory(directory); err != nil {
		t.Fatal(err)
	}
	probe, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	probe.Close()
	const account, zone, token = "account-0001", "zone-0000001", "fixture_cloudflare_token"
	const prefix = "/client/v4"
	var conflict atomic.Bool
	client := desktopCloud{token: token, transport: desktopCloudFixture(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodGet || request.Host != "api.cloudflare.com" || request.Header.Get("Authorization") != "Bearer "+token {
			return nil, fmt.Errorf("Unconfirmed or misdirected request: %s %s", request.Method, request.URL.Path)
		}
		switch request.URL.Path {
		case prefix + "/zones/" + zone:
			return cloudFixtureResponse(map[string]any{"name": "fixture.example", "account": map[string]string{"id": account}})
		case prefix + "/accounts/" + account + "/access/organizations":
			return cloudFixtureResponse(map[string]string{"auth_domain": "fixture.cloudflareaccess.com"})
		case prefix + "/accounts/" + account + "/access/apps":
			if conflict.Load() {
				return cloudFixtureResponse([]any{map[string]string{"id": "foreign-app", "domain": "*.fixture.example"}})
			}
			return cloudFixtureResponse([]any{})
		case prefix + "/zones/" + zone + "/dns_records":
			if request.URL.Query().Get("name") != "owner.fixture.example" {
				return nil, fmt.Errorf("Unexpected DNS lookup")
			}
			return cloudFixtureResponse([]any{})
		default:
			return nil, fmt.Errorf("Unexpected fixture URL: %s", request.URL.Path)
		}
	})}
	a := &desktopAgent{home: home, directory: directory}
	a.config, _ = parseDesktopConfig(nil, home)
	a.config.Cloudflared = "/fixture/cloudflared"
	a.managed.client = client
	body := json.RawMessage(fmt.Sprintf(`{"accountId":%q,"zoneId":%q,"subdomain":"Owner","email":"EXAMPLE@example.com","port":%d,"tunnelMode":"create"}`, account, zone, port))
	result, err := a.cloudPreview(t.Context(), body, false)
	if err != nil {
		t.Fatal(err)
	}
	if preview := result.(map[string]any); preview["hostname"] != "owner.fixture.example" || preview["id"] == "" {
		t.Fatalf("Unexpected preview: %#v", preview)
	}
	if receipt, err := a.readDeployment(); err != nil || receipt != nil {
		t.Fatalf("A preview must not create deployment state: %v %v", receipt, err)
	}
	conflict.Store(true)
	if _, err := a.cloudPreview(t.Context(), body, false); desktopSafeError(err).Status != 409 {
		t.Fatalf("A conflicting wildcard app should block preview: %v", err)
	}
	if a.managed.plan != nil {
		t.Fatal("An older preview must not remain actionable")
	}
}

func TestDesktopCloudRouteRecoveryPreservesForeignRoutes(t *testing.T) {
	input := desktopRemoteInput{AccountID: "account-0001", ZoneID: "zone-0000001", TunnelID: "tunnel-00001", Hostname: "owner.fixture.example", Email: "owner@fixture.example", Port: 8898}
	owned := cloudRoute(input, "fixture.cloudflareaccess.com", "fixture-audience")
	foreign := map[string]any{"hostname": "other.fixture.example", "service": "http://127.0.0.1:8453"}
	catchall := map[string]any{"service": "http_status:404"}
	config := map[string]any{"ingress": []any{owned, foreign, catchall}, "originRequest": map[string]any{"connectTimeout": "2s"}}
	writes := 0
	client := desktopCloud{token: "fixture_cloudflare_token", transport: desktopCloudFixture(func(request *http.Request) (*http.Response, error) {
		if request.Method == http.MethodPut {
			var update struct{ Config map[string]any }
			if err := json.NewDecoder(request.Body).Decode(&update); err != nil {
				return nil, err
			}
			config = update.Config
			writes++
		} else if request.Method != http.MethodGet {
			return nil, fmt.Errorf("Unexpected method: %s", request.Method)
		}
		return cloudFixtureResponse(map[string]any{"config": config})
	})}
	r := &desktopDeploymentReceipt{Input: input, Route: owned}
	if err := cloudChangeRoute(context.Background(), client, r, nil, owned); err != nil {
		t.Fatal(err)
	}
	if writes != 1 || !cloudSame(config["ingress"], []any{foreign, catchall}) || !cloudSame(config["originRequest"], map[string]any{"connectTimeout": "2s"}) {
		t.Fatalf("Recovery edited foreign settings: %#v", config)
	}
	edited := cloudClone(owned)
	edited["service"] = "http://127.0.0.1:9911"
	config["ingress"] = []any{edited, foreign, catchall}
	if err := cloudChangeRoute(context.Background(), client, r, nil, owned); desktopSafeError(err).Status != 409 || writes != 1 {
		t.Fatalf("An edited managed route should be retained: %v %d", err, writes)
	}
}
