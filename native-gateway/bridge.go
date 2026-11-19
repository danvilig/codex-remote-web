package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	maxNativeMessage = 32 << 20
	maxPending       = 32
	maxLateReplies   = 64
	writeTimeout     = 3 * time.Second
	lateReplyWindow  = 5 * time.Minute
)

var (
	errDisconnected = errors.New("Codex App Server is disconnected")
	errBusy         = errors.New("Too many pending Codex requests")
	errTimeout      = errors.New("Codex request timed out")
)

type nativeError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *nativeError) Error() string { return e.Message }

type nativeResponse struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *nativeError    `json:"error"`
}

func (r nativeResponse) value() (json.RawMessage, error) {
	if r.Error != nil {
		return nil, r.Error
	}
	return r.Result, nil
}

type lateNativeResponse struct {
	handle func(json.RawMessage, error)
	timer  *time.Timer
}

type nativeTransport interface {
	ReadMessage() (int, []byte, error)
	SetWriteDeadline(time.Time) error
	WriteJSON(any) error
	Close() error
}

type nativeConn struct {
	ws       nativeTransport
	write    chan struct{}
	done     chan struct{}
	mu       sync.Mutex
	closed   bool
	nextID   uint64
	pending  map[uint64]chan nativeResponse
	late     map[uint64]lateNativeResponse
	lateWork int
	onNative func(*nativeConn, json.RawMessage)
}

func connectNative(ctx context.Context, socket string) (*nativeConn, error) {
	ws, err := nativeSocket(ctx, socket)
	if err != nil {
		return nil, err
	}
	return newNativeConn(ws, nil), nil
}

func nativeSocket(ctx context.Context, socket string) (nativeTransport, error) {
	if !filepath.IsAbs(socket) || strings.ContainsAny(socket, "\x00\r\n") {
		return nil, errors.New("App Server socket must be an absolute local path")
	}
	dialer := websocket.Dialer{
		HandshakeTimeout: 3 * time.Second,
		NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}
	ws, response, err := dialer.DialContext(ctx, "ws://localhost/", nil)
	if err != nil {
		if response != nil {
			_ = response.Body.Close()
		}
		return nil, err
	}
	ws.SetReadLimit(maxNativeMessage)
	return ws, nil
}

func newNativeConn(transport nativeTransport, cb func(*nativeConn, json.RawMessage)) *nativeConn {
	c := &nativeConn{ws: transport, done: make(chan struct{}), write: make(chan struct{}, 1), pending: make(map[uint64]chan nativeResponse), late: make(map[uint64]lateNativeResponse), onNative: cb}
	go c.read()
	return c
}

func (c *nativeConn) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	for _, late := range c.late {
		late.timer.Stop()
	}
	clear(c.late)
	close(c.done)
	_ = c.ws.Close()
}

func (c *nativeConn) read() {
	defer c.close()
	for {
		kind, data, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		if kind != websocket.TextMessage {
			continue
		}
		var frame struct {
			Method string `json:"method"`
		}
		if json.Unmarshal(data, &frame) != nil {
			continue
		}
		if frame.Method != "" {
			if c.onNative != nil {
				c.onNative(c, data)
			}
			continue
		}
		var message nativeResponse
		if json.Unmarshal(data, &message) != nil || (message.Result == nil && message.Error == nil) {
			continue
		}
		idText := string(message.ID)
		if len(idText) > 0 && idText[0] == '"' && json.Unmarshal(message.ID, &idText) != nil {
			continue
		}
		id, err := strconv.ParseUint(idText, 10, 64)
		if err != nil || id == 0 {
			continue
		}
		c.mu.Lock()
		if reply := c.pending[id]; reply != nil {
			delete(c.pending, id)
			reply <- message
		} else if late, ok := c.late[id]; ok {
			delete(c.late, id)
			late.timer.Stop()
			c.lateWork++
			go c.handleLate(late.handle, message)
		}
		c.mu.Unlock()
	}
}

func (c *nativeConn) handleLate(handle func(json.RawMessage, error), message nativeResponse) {
	defer func() { c.mu.Lock(); c.lateWork--; c.mu.Unlock() }()
	handle(message.value())
}

func (c *nativeConn) send(ctx context.Context, payload any) error {
	select {
	case <-ctx.Done():
		return errTimeout
	case <-c.done:
		return errDisconnected
	case c.write <- struct{}{}:
	}
	defer func() { <-c.write }()
	if ctx.Err() != nil {
		return errTimeout
	}
	deadline := time.Now().Add(writeTimeout)
	if earlier, ok := ctx.Deadline(); ok && earlier.Before(deadline) {
		deadline = earlier
	}
	if c.ws.SetWriteDeadline(deadline) != nil || c.ws.WriteJSON(payload) != nil {
		c.close()
		return errDisconnected
	}
	return nil
}

func (c *nativeConn) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	return c.requestWithLate(ctx, method, params, nil)
}

func (c *nativeConn) requestWithLate(ctx context.Context, method string, params any, late func(json.RawMessage, error)) (json.RawMessage, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errDisconnected
	}
	if len(c.pending) >= maxPending {
		c.mu.Unlock()
		return nil, errBusy
	}
	c.nextID++
	id := c.nextID
	reply := make(chan nativeResponse, 1)
	c.pending[id] = reply
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()
	payload := struct {
		ID     uint64 `json:"id"`
		Method string `json:"method"`
		Params any    `json:"params"`
	}{id, method, params}
	if err := c.send(ctx, payload); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		c.mu.Lock()
		// The reader may already have matched the response while the request
		// was expiring. Prefer that response over creating a late entry.
		select {
		case message := <-reply:
			c.mu.Unlock()
			return message.value()
		default:
		}
		delete(c.pending, id)
		if late != nil && !c.closed && len(c.late)+c.lateWork < maxLateReplies {
			timer := time.AfterFunc(lateReplyWindow, func() {
				c.mu.Lock()
				defer c.mu.Unlock()
				delete(c.late, id)
			})
			c.late[id] = lateNativeResponse{handle: late, timer: timer}
		}
		c.mu.Unlock()
		return nil, errTimeout
	case <-c.done:
		select {
		case message := <-reply:
			return message.value()
		default:
			return nil, errDisconnected
		}
	case message := <-reply:
		return message.value()
	}
}

type bridge struct {
	mu       sync.RWMutex
	conn     *nativeConn
	onNative func(*nativeConn, json.RawMessage)
	onStatus func()
}

func (b *bridge) current() *nativeConn {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.conn != nil {
		select {
		case <-b.conn.done:
			return nil
		default:
		}
	}
	return b.conn
}

func (b *bridge) request(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	conn := b.current()
	if conn == nil {
		return nil, errDisconnected
	}
	return conn.request(ctx, method, params)
}

func (b *bridge) run(ctx context.Context, socket, version string, delay time.Duration) {
	b.runMode(ctx, "shared", socket, "", version, delay)
}

func (b *bridge) runMode(ctx context.Context, mode, socket, cwd, version string, delay time.Duration) {
	for ctx.Err() == nil {
		b.session(ctx, mode, socket, cwd, version)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (b *bridge) session(ctx context.Context, mode, socket, cwd, version string) {
	startup, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var transport nativeTransport
	var err error
	if mode == "isolated" {
		transport, err = openIsolated(cwd)
	} else {
		transport, err = nativeSocket(startup, socket)
	}
	if err != nil {
		return
	}
	conn := newNativeConn(transport, b.onNative)
	defer conn.close()
	params := map[string]any{
		"clientInfo":   map[string]string{"name": "codex-remote-web", "title": "Codex Remote Web", "version": version},
		"capabilities": map[string]bool{"experimentalApi": true},
	}
	if _, err := conn.request(startup, "initialize", params); err != nil {
		return
	}
	if err := conn.send(startup, map[string]any{"method": "initialized", "params": struct{}{}}); err != nil {
		return
	}
	cancel()
	b.mu.Lock()
	b.conn = conn
	b.mu.Unlock()
	if b.onStatus != nil {
		b.onStatus()
	}
	defer func() {
		b.mu.Lock()
		b.conn = nil
		b.mu.Unlock()
		if b.onStatus != nil {
			b.onStatus()
		}
	}()
	select {
	case <-ctx.Done():
	case <-conn.done:
	}
}

func decodeOne[T any](r io.Reader, target *T) error {
	d := json.NewDecoder(r)
	if err := d.Decode(target); err != nil {
		return err
	}
	if d.Decode(new(json.RawMessage)) != io.EOF {
		return errors.New("Expected one JSON message")
	}
	return nil
}
