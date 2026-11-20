package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func TestHTTPBridgeChecksLeaseAfterReadingBody(t *testing.T) {
	for _, path := range []string{"/api/rpc", "/api/codex/respond"} {
		t.Run(path, func(t *testing.T) {
			for _, tc := range []struct {
				name   string
				delay  time.Duration
				status int
			}{
				{"active", 0, http.StatusOK},
				{"expired", 2 * time.Second, http.StatusUnauthorized},
			} {
				t.Run(tc.name, func(t *testing.T) {
					synctest.Test(t, func(t *testing.T) {
						calls := 0
						app := &gatewayApp{mux: http.NewServeMux(), dispatch: func(context.Context, browserRequest) any {
							calls++
							return map[string]string{"type": "ack"}
						}}
						app.registerCore()
						body, input := io.Pipe()
						defer body.Close()
						go func() {
							defer input.Close()
							time.Sleep(tc.delay)
							_, _ = io.WriteString(input, `{}`)
						}()
						const origin = "https://fixture.example"
						response := httptest.NewRecorder()
						request := httptest.NewRequest(http.MethodPost, origin+path, body)
						app.serveAuthenticated(response, request, "cloudflare-access", origin, func(*http.Request) authResult {
							return authResult{ok: true, origin: origin, expires: time.Now().Add(time.Second)}
						})
						if response.Code != tc.status {
							t.Fatalf("HTTP %d: %s", response.Code, response.Body)
						}
						if tc.status == http.StatusUnauthorized {
							if calls != 0 || !strings.Contains(response.Body.String(), `"code":"AUTH_EXPIRED"`) {
								t.Fatalf("expired request: dispatched %d times, response %s", calls, response.Body)
							}
						} else if calls != 1 {
							t.Fatalf("active request dispatched %d times", calls)
						}
					})
				})
			}
		})
	}
}

func TestHTTPHistoryReadOutlastsServerWriteTimeout(t *testing.T) {
	const defaultTimeout = 500 * time.Millisecond
	app := &gatewayApp{
		local: &localAuthenticator{}, mux: http.NewServeMux(),
		dispatch: func(_ context.Context, message browserRequest) any {
			time.Sleep(defaultTimeout + 100*time.Millisecond)
			return map[string]string{"method": message.Method}
		},
	}
	app.registerCore()
	server := httptest.NewUnstartedServer(app)
	server.Config.WriteTimeout = defaultTimeout
	server.Start()
	defer server.Close()
	client := server.Client()
	client.Timeout = 5 * time.Second
	response, err := client.Post(server.URL+"/api/rpc", "application/json", strings.NewReader(`{"id":1,"method":"thread/read"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK || string(data) != "{\"method\":\"thread/read\"}\n" {
		t.Fatalf("history reply HTTP %d: %q (%v)", response.StatusCode, data, err)
	}
}
