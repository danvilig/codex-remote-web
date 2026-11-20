package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

const maxBrowserMessage = 64 << 10

type browserRequest struct {
	Type         string          `json:"type"`
	ID           json.RawMessage `json:"id"`
	Method       string          `json:"method"`
	Params       json.RawMessage `json:"params"`
	RequestID    json.RawMessage `json:"requestId"`
	RequestEpoch string          `json:"requestEpoch"`
	Result       json.RawMessage `json:"result"`
	Error        json.RawMessage `json:"error"`
}

type browserResponse struct {
	Type       string          `json:"type"`
	ID         json.RawMessage `json:"id,omitempty"`
	Result     json.RawMessage `json:"result,omitempty"`
	Error      string          `json:"error,omitempty"`
	Code       any             `json:"code,omitempty"`
	NativeCode *int            `json:"nativeCode,omitempty"`
	Data       json.RawMessage `json:"data,omitempty"`
}

func reply(ctx context.Context, b *bridge, r browserRequest) browserResponse {
	result := browserResponse{Type: "rpc/error", ID: r.ID}
	if !validBrowserID(r.ID) {
		result.ID, result.Code, result.Error = nil, "INVALID_REQUEST", "Invalid RPC request ID"
		return result
	}
	// Methods that resume a writer, invoke tools or modify data need the
	// existing gateway's delivery and approval contracts. None are forwarded.
	switch r.Method {
	case "thread/list", "thread/read", "thread/turns/list", "model/list", "permissionProfile/list":
	default:
		result.Code, result.Error = "METHOD_NOT_ALLOWED", "RPC method is not available in the native gateway preview"
		return result
	}
	params := bytes.TrimSpace(r.Params)
	if len(params) == 0 || bytes.Equal(params, []byte("null")) {
		params = []byte("{}")
	}
	if !json.Valid(params) || params[0] != '{' {
		result.Code, result.Error = "INVALID_REQUEST", "RPC params must be an object"
		return result
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	value, err := b.request(ctx, r.Method, params)
	if err == nil {
		return browserResponse{Type: "rpc/result", ID: r.ID, Result: value}
	}
	result.Error = err.Error()
	var rpcErr *nativeError
	switch {
	case errors.As(err, &rpcErr):
		result.Code, result.NativeCode, result.Data = rpcErr.Code, &rpcErr.Code, rpcErr.Data
	case errors.Is(err, errTimeout):
		result.Code = "RPC_TIMEOUT"
	case errors.Is(err, errBusy):
		result.Code = "RPC_BUSY"
	default:
		result.Code = "RPC_DISCONNECTED"
	}
	return result
}

func validBrowserID(raw json.RawMessage) bool {
	if len(raw) == 0 || len(raw) > 128 || !json.Valid(raw) {
		return false
	}
	return raw[0] == '"' || raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9')
}

func jsonReply(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func gatewayHandler(b *bridge, host, token, version string) http.Handler {
	wanted := sha256.Sum256([]byte("Bearer " + token))
	origin := "http://" + host
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		jsonReply(w, 200, map[string]any{"ok": true, "codex": b.current() != nil, "name": "codex-remote-web", "version": version, "runtime": "native-go-preview"})
	})
	mux.HandleFunc("POST /api/rpc", func(w http.ResponseWriter, r *http.Request) {
		var payload browserRequest
		if err := decodeOne(http.MaxBytesReader(w, r.Body, maxBrowserMessage), &payload); err != nil {
			jsonReply(w, 400, map[string]string{"error": "Invalid RPC request"})
			return
		}
		jsonReply(w, 200, reply(r.Context(), b, payload))
	})
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == origin }}
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err == nil {
			handleSocket(r.Context(), ws, b)
		}
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Cache-Control", "no-store")
		requestOrigin := r.Header.Get("Origin")
		if r.Host != host || (requestOrigin != "" && requestOrigin != origin) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			jsonReply(w, 403, map[string]string{"error": "A local same-origin request is required"})
			return
		}
		actual := sha256.Sum256([]byte(r.Header.Get("Authorization")))
		if subtle.ConstantTimeCompare(actual[:], wanted[:]) != 1 {
			jsonReply(w, 401, map[string]string{"error": "Authentication required"})
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func handleSocket(parent context.Context, ws *websocket.Conn, b *bridge) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer ws.Close()
	ws.SetReadLimit(maxBrowserMessage)
	requests := make(chan browserRequest, 1)
	go func() {
		defer cancel()
		for {
			kind, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			var payload browserRequest
			if kind != websocket.TextMessage || json.Unmarshal(data, &payload) != nil || payload.Type != "rpc" {
				return
			}
			select {
			case requests <- payload:
			case <-ctx.Done():
				return
			}
		}
	}()
	write := func(payload any) bool {
		return ws.SetWriteDeadline(time.Now().Add(writeTimeout)) == nil && ws.WriteJSON(payload) == nil
	}
	status := ""
	update := func() bool {
		next := "connecting"
		if b.current() != nil {
			next = "connected"
		}
		if next == status {
			return true
		}
		status = next
		return write(map[string]string{"type": "bridge/status", "status": status})
	}
	if !update() {
		return
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !update() {
				return
			}
		case request := <-requests:
			if !write(reply(ctx, b, request)) {
				return
			}
		}
	}
}
