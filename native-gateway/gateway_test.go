package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type fixtureRequest struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func fixture(t *testing.T) (string, <-chan *websocket.Conn) {
	t.Helper()
	// macOS Unix sockets can have at most 103 path bytes. Avoid the relatively
	// long macOS default temp path plus a subdirectory named after the test.
	temp := "/tmp"
	if runtime.GOOS == "windows" {
		temp = os.TempDir()
	}
	dir, err := os.MkdirTemp(temp, "cg-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socket := filepath.Join(dir, "c.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	peers := make(chan *websocket.Conn)
	stop := make(chan struct{})
	upgrader := websocket.Upgrader{}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err == nil {
			select {
			case peers <- ws:
			case <-stop:
				_ = ws.Close()
			}
		}
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { close(stop); _ = server.Close(); _ = listener.Close() })
	return socket, peers
}

func next[T any](t *testing.T, values <-chan T) T {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("fixture timed out")
		var zero T
		return zero
	}
}

func getRequest(t *testing.T, peer *websocket.Conn) fixtureRequest {
	t.Helper()
	_ = peer.SetReadDeadline(time.Now().Add(3 * time.Second))
	var req fixtureRequest
	if err := peer.ReadJSON(&req); err != nil {
		t.Fatal(err)
	}
	return req
}

func sendResult(t *testing.T, peer *websocket.Conn, id uint64, result any) {
	t.Helper()
	if err := peer.WriteJSON(map[string]any{"id": id, "result": result}); err != nil {
		t.Fatal(err)
	}
}

func waitState(t *testing.T, b *bridge, want bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for (b.current() != nil) != want {
		if time.Now().After(deadline) {
			t.Fatalf("bridge connected state did not become %v", want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func acceptSession(t *testing.T, peers <-chan *websocket.Conn, b *bridge) *websocket.Conn {
	t.Helper()
	peer := next(t, peers)
	t.Cleanup(func() { _ = peer.Close() })
	req := getRequest(t, peer)
	if req.Method != "initialize" || req.ID == 0 || !strings.Contains(string(req.Params), `"experimentalApi":true`) {
		t.Fatalf("invalid startup: %+v", req)
	}
	if b.current() != nil {
		t.Fatal("bridge exposed app server before initialization")
	}
	sendResult(t, peer, req.ID, struct{}{})
	if req := getRequest(t, peer); req.Method != "initialized" || req.ID != 0 {
		t.Fatalf("invalid initialized notification: %+v", req)
	}
	waitState(t, b, true)
	return peer
}

func TestBridgeCorrelatesAndReconnectsWithoutReplay(t *testing.T) {
	socket, peers := fixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	b := new(bridge)
	done := make(chan struct{})
	go func() { defer close(done); b.run(ctx, socket, "test", 10*time.Millisecond) }()
	first := acceptSession(t, peers, b)
	type outcome struct {
		result json.RawMessage
		err    error
	}
	call := func(method string) <-chan outcome {
		ch := make(chan outcome, 1)
		go func() { r, err := b.request(ctx, method, json.RawMessage(`{}`)); ch <- outcome{r, err} }()
		return ch
	}
	list := call("thread/list")
	listReq := getRequest(t, first)
	read := call("thread/read")
	readReq := getRequest(t, first)
	if listReq.ID == readReq.ID {
		t.Fatal("in-flight IDs collided")
	}
	sendResult(t, first, readReq.ID, "detail")
	sendResult(t, first, listReq.ID, "list")
	if r := next(t, read); r.err != nil || string(r.result) != `"detail"` {
		t.Fatalf("read reply: %+v", r)
	}
	if r := next(t, list); r.err != nil || string(r.result) != `"list"` {
		t.Fatalf("list reply: %+v", r)
	}
	pending := call("thread/read")
	if req := getRequest(t, first); req.Method != "thread/read" {
		t.Fatalf("wrong pending request: %+v", req)
	}
	_ = first.Close()
	if r := next(t, pending); !errors.Is(r.err, errDisconnected) {
		t.Fatalf("pending disconnect reply: %+v", r)
	}
	second := acceptSession(t, peers, b)
	reconnected := call("model/list")
	req := getRequest(t, second)
	if req.Method != "model/list" {
		t.Fatalf("request replayed after reconnect: %+v", req)
	}
	sendResult(t, second, req.ID, []string{})
	if r := next(t, reconnected); r.err != nil {
		t.Fatal(r.err)
	}
	cancel()
	next(t, done)
	// A fresh independent connection shows the gateway did not shut down the
	// shared daemon, even though it owned and closed its own WebSocket.
	probe, err := connectNative(t.Context(), socket)
	if err != nil {
		t.Fatal(err)
	}
	defer probe.close()
	_ = next(t, peers).Close()
}

func TestGatewayBrowserContract(t *testing.T) {
	socket, peers := fixture(t)
	b := new(bridge)
	go b.run(t.Context(), socket, "test", time.Second)
	peer := acceptSession(t, peers, b)
	server := httptest.NewUnstartedServer(nil)
	server.Config.Handler = gatewayHandler(b, server.Listener.Addr().String(), "test-secret", "test")
	server.Start()
	defer server.Close()
	client := &http.Client{Timeout: 4 * time.Second}
	for _, test := range []struct {
		token, origin, method string
		status                int
		code                  string
	}{
		{"", server.URL, "thread/list", 401, ""},
		{"test-secret", "https://other.example", "thread/list", 403, ""},
		{"test-secret", server.URL, "turn/start", 200, "METHOD_NOT_ALLOWED"},
		{"test-secret", server.URL, "thread/read", 200, ""},
	} {
		answered := make(chan error, 1)
		if test.method == "thread/read" {
			go func() {
				_ = peer.SetReadDeadline(time.Now().Add(3 * time.Second))
				var request fixtureRequest
				err := peer.ReadJSON(&request)
				if err == nil && request.Method != "thread/read" {
					err = errors.New("unexpected request forwarded to Codex")
				}
				if err == nil {
					err = peer.WriteJSON(map[string]any{"id": request.ID, "result": map[string]string{"id": "thread-A"}})
				}
				answered <- err
			}()
		}
		body := strings.NewReader(`{"id":"browser-id","params":{},"method":"` + test.method + `"}`)
		req, err := http.NewRequest(http.MethodPost, server.URL+"/api/rpc", body)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", test.origin)
		req.Header.Set("Authorization", "Bearer "+test.token)
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(res.Body)
		_ = res.Body.Close()
		if err != nil || res.StatusCode != test.status {
			t.Fatalf("HTTP %d: %s (%v)", res.StatusCode, data, err)
		}
		if test.code != "" && !strings.Contains(string(data), `"code":"`+test.code+`"`) {
			t.Fatalf("unexpected code: %s", data)
		}
		if test.method == "thread/read" {
			if err := next(t, answered); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(data), `"type":"rpc/result","id":"browser-id","result":{"id":"thread-A"}`) {
				t.Fatalf("wrong browser result: %s", data)
			}
		}
	}
	address := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
	dialer := websocket.Dialer{HandshakeTimeout: time.Second}
	headers := http.Header{"Authorization": {"Bearer test-secret"}}
	ws, response, err := dialer.Dial(address, headers)
	if err == nil {
		_ = ws.Close()
		t.Fatal("upgraded without an Origin")
	}
	if response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("missing-origin response: %v", err)
	}
	_ = response.Body.Close()
	headers.Set("Origin", server.URL)
	ws, _, err = dialer.Dial(address, headers)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	_ = ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	var status map[string]string
	if err := ws.ReadJSON(&status); err != nil || status["type"] != "bridge/status" || status["status"] != "connected" {
		t.Fatalf("unexpected status: %v (%v)", status, err)
	}
	if err := ws.WriteJSON(map[string]any{"type": "rpc", "id": 12, "method": "thread/start"}); err != nil {
		t.Fatal(err)
	}
	var reply browserResponse
	if err := ws.ReadJSON(&reply); err != nil || reply.Code != "METHOD_NOT_ALLOWED" || string(reply.ID) != "12" {
		t.Fatalf("unexpected rejection: %+v (%v)", reply, err)
	}
}
