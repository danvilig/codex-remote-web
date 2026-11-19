package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAccountIdentityNativeReadAndRefresh(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	b := new(bridge)
	socket, peers := fixture(t)
	go b.run(ctx, socket, "test", time.Millisecond)
	peer := acceptSession(t, peers, b)
	account := newAccountCache(b, t.TempDir())
	mux := http.NewServeMux()
	account.register(mux)
	request := func(path string, forwarded bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "http://localhost"+path, nil)
		r.RemoteAddr = "127.0.0.1:12345"
		if forwarded {
			r.Header.Set("X-Forwarded-For", "192.0.2.1")
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if result := request("/api/account", true); result.Code != 403 {
		t.Fatalf("forwarded profile request got %d", result.Code)
	}
	for _, refresh := range []string{"false", "true"} {
		path := "/api/account"
		if refresh == "true" {
			path += "?refresh=1"
		}
		results := make(chan *httptest.ResponseRecorder, 1)
		go func() { results <- request(path, false) }()
		req := getRequest(t, peer)
		if req.Method != "account/read" || string(req.Params) != `{"refreshToken":`+refresh+`}` {
			t.Fatalf("wrong native profile request: %+v", req)
		}
		sendResult(t, peer, req.ID, map[string]any{"account": map[string]string{"type": "apiKey", "email": "fixture@example.invalid", "planType": "test"}})
		result := next(t, results)
		if result.Code != 200 || !strings.Contains(result.Body.String(), `"displayName":"API key"`) || strings.Contains(result.Body.String(), "example.invalid") {
			t.Fatalf("wrong public identity: %d %s", result.Code, result.Body.String())
		}
	}
	_ = peer.Close()
	waitState(t, b, false)
	if result := request("/api/account/avatar?refresh=1", false); result.Code != 502 {
		t.Fatalf("failed avatar read got %d", result.Code)
	}
	if result := request("/api/account", false); result.Code != 200 || !strings.Contains(result.Body.String(), `"type":"unknown"`) {
		t.Fatalf("failed refresh retained an old identity: %d %s", result.Code, result.Body.String())
	}
}
