package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Keep this allowlist aligned with src/server/auth/local.js. Routes with a
// gateway-owned protocol never pass through as arbitrary native RPCs.
var browserConversationMethods = map[string]bool{
	"model/list": true, "permissionProfile/list": true, "account/logout": true,
	"thread/list": true, "thread/read": true, "thread/delete": true, "thread/unarchive": true,
	"thread/resume": true, "thread/turns/list": true, "thread/start": true,
	"turn/start": true, "turn/steer": true, "turn/interrupt": true,
}

type conversation struct {
	bridge      *bridge
	privateRoot string
	publish     func(any)
	submissions *submissionStore
	delivery    *deliveryQueue
	live        *conversationLiveStore
	sideChats   *conversationSideChats
	notifier    *conversationNotifier
	scheduler   *conversationScheduler

	mu       sync.Mutex
	conn     *nativeConn
	epoch    string
	sequence uint64
	pending  map[string]*nativeApproval
}

type nativeApproval struct {
	ID         json.RawMessage `json:"id"`
	Method     string          `json:"method"`
	Params     json.RawMessage `json:"params,omitempty"`
	Epoch      string          `json:"requestEpoch"`
	sequence   uint64
	responding bool
}

type conversationAnswer struct {
	RequestID    json.RawMessage `json:"requestId"`
	RequestEpoch string          `json:"requestEpoch"`
	Result       json.RawMessage `json:"result"`
	Error        json.RawMessage `json:"error"`
}

type conversationError struct {
	code    any
	message string
	data    json.RawMessage
}

func (e *conversationError) Error() string { return e.message }

func conversationFailure(code, message string) error {
	return &conversationError{code: code, message: message}
}

func newConversation(b *bridge, privateRoot string, publish func(any)) *conversation {
	if publish == nil {
		publish = func(any) {}
	}
	c := &conversation{bridge: b, privateRoot: privateRoot, publish: publish}
	c.sideChats = newConversationSideChats(c)
	c.notifier = newConversationNotifier()
	if privateRoot != "" {
		c.submissions = newSubmissionStore(privateRoot, c.request, func() bool { return b.current() != nil }, func(receipt submissionReceipt) {
			publish(map[string]any{"type": "submission/changed", "receipt": map[string]any{"id": receipt.ID, "threadId": receipt.ThreadID, "status": receipt.Status, "updatedAt": receipt.UpdatedAt}})
		})
		c.submissions.requestWithLate = func(ctx context.Context, method string, params json.RawMessage, late func(json.RawMessage, error)) (json.RawMessage, error) {
			return requestConversationWithLate(ctx, b.current(), method, params, late)
		}
		c.delivery = newDeliveryQueue(c)
		c.live = newConversationLiveStore()
		c.scheduler = newConversationScheduler(c)
	}
	return c
}

// changeConnection is called with mu held. A pointer identifies a single
// native socket generation, even when the next server repeats request IDs.
func (c *conversation) changeConnection(conn *nativeConn) {
	if c.conn == conn {
		return
	}
	c.conn, c.epoch, c.sequence = conn, rand.Text(), 0
	c.pending = make(map[string]*nativeApproval)
}

func jsonRPCKey(id json.RawMessage) (string, bool) {
	id = bytes.TrimSpace(id)
	if len(id) == 0 || len(id) > 4096 {
		return "", false
	}
	if id[0] == '"' {
		var value string
		if json.Unmarshal(id, &value) != nil {
			return "", false
		}
		return "s:" + value, true
	}
	if id[0] == '-' || id[0] >= '0' && id[0] <= '9' {
		value, err := strconv.ParseFloat(string(id), 64)
		if err == nil {
			if value == 0 {
				value = 0 // JSON's positive and negative zero are the same browser key.
			}
			return "n:" + strconv.FormatFloat(value, 'g', -1, 64), true
		}
	}
	return "", false
}

func (c *conversation) onNative(conn *nativeConn, raw json.RawMessage) {
	var message nativeApproval
	if json.Unmarshal(raw, &message) != nil || message.Method == "" {
		return
	}
	c.mu.Lock()
	if c.bridge.current() != conn {
		c.mu.Unlock()
		return
	}
	c.changeConnection(conn)
	if c.scheduler != nil {
		c.scheduler.observe(conn, message.Method, message.Params)
	}
	if len(message.ID) != 0 {
		key, ok := jsonRPCKey(message.ID)
		if !ok {
			c.mu.Unlock()
			return
		}
		// An unresolved native request ID cannot describe two requests on
		// the same connection. Keep the first one the browser actually saw.
		if previous := c.pending[key]; previous != nil && !previous.responding {
			c.mu.Unlock()
			return
		}
		if len(c.pending) >= maxPending {
			c.mu.Unlock()
			conn.close()
			return
		}
		c.sequence++
		message.Epoch, message.sequence = c.epoch+"-"+strconv.FormatUint(c.sequence, 10), c.sequence
		c.pending[key] = &message
		c.mu.Unlock()
		c.publish(map[string]any{"type": "codex/request", "payload": message})
		return
	}
	if message.Method == "serverRequest/resolved" {
		var params struct {
			ID json.RawMessage `json:"requestId"`
		}
		if json.Unmarshal(message.Params, &params) == nil {
			if key, ok := jsonRPCKey(params.ID); ok {
				delete(c.pending, key)
			}
		}
	}
	c.mu.Unlock()
	c.sideChats.notify(conn, message.Method, message.Params)
	c.publish(map[string]any{"type": "codex/notification", "payload": raw})
	if message.Method == "turn/completed" {
		if c.delivery != nil {
			c.delivery.observeCompletion(message.Params)
		}
		if c.notifier != nil {
			c.notifier.observe(message.Params)
		}
	}
}

func (c *conversation) requestList() []*nativeApproval {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.changeConnection(c.bridge.current())
	list := make([]*nativeApproval, 0, len(c.pending))
	for _, item := range c.pending {
		// The websocket writer encodes the copies after mu is released.
		copy := *item
		list = append(list, &copy)
	}
	// maxPending is small; preserve the arrival order the browser uses.
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j].sequence < list[j-1].sequence; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
	return list
}

func validateConversationInput(params, result json.RawMessage) error {
	var data struct {
		Questions []struct {
			ID      string `json:"id"`
			IsOther bool   `json:"isOther"`
			Options []struct {
				Label string `json:"label"`
			} `json:"options"`
		} `json:"questions"`
	}
	var reply struct {
		Answers map[string]struct {
			Answers []string `json:"answers"`
		} `json:"answers"`
	}
	if json.Unmarshal(result, &reply) != nil || reply.Answers == nil {
		return conversationFailure("INVALID_REQUEST", "Answers are required")
	}
	if len(params) > 0 && json.Unmarshal(params, &data) != nil {
		return conversationFailure("INVALID_REQUEST", "Invalid question data")
	}
	known := make(map[string]bool, len(data.Questions))
	for _, q := range data.Questions {
		known[q.ID] = true
	}
	for id := range reply.Answers {
		if !known[id] {
			return conversationFailure("INVALID_REQUEST", "Unknown question")
		}
	}
	for _, q := range data.Questions {
		values := reply.Answers[q.ID].Answers
		if len(values) != 1 || strings.TrimSpace(values[0]) == "" {
			return conversationFailure("INVALID_REQUEST", "Answer every question")
		}
		if len(q.Options) != 0 && !q.IsOther {
			found := false
			for _, option := range q.Options {
				found = found || values[0] == option.Label
			}
			if !found {
				return conversationFailure("INVALID_REQUEST", "Choose one of the available options")
			}
		}
	}
	return nil
}

func (c *conversation) respond(ctx context.Context, answer conversationAnswer) error {
	key, ok := jsonRPCKey(answer.RequestID)
	if !ok {
		return conversationFailure("INVALID_REQUEST", "Invalid approval request ID")
	}
	c.mu.Lock()
	conn := c.bridge.current()
	c.changeConnection(conn)
	if conn == nil || !strings.HasPrefix(answer.RequestEpoch, c.epoch+"-") {
		c.mu.Unlock()
		return conversationFailure("REQUEST_STALE", "This request belongs to an earlier connection. Refresh pending approvals.")
	}
	approval := c.pending[key]
	if approval == nil || approval.responding {
		c.mu.Unlock()
		return conversationFailure("REQUEST_NOT_PENDING", "This request is no longer pending")
	}
	if approval.Epoch != answer.RequestEpoch {
		c.mu.Unlock()
		return conversationFailure("REQUEST_STALE", "This approval has been replaced. Refresh pending approvals.")
	}
	payload := map[string]any{"id": approval.ID}
	if len(answer.Error) != 0 && !bytes.Equal(bytes.TrimSpace(answer.Error), []byte("null")) {
		var native struct {
			Code    *int   `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(answer.Error, &native) != nil || native.Code == nil || native.Message == "" {
			c.mu.Unlock()
			return conversationFailure("INVALID_REQUEST", "Invalid approval error")
		}
		payload["error"] = answer.Error
	} else {
		if approval.Method == "item/tool/requestUserInput" {
			if err := validateConversationInput(approval.Params, answer.Result); err != nil {
				c.mu.Unlock()
				return err
			}
		}
		if len(answer.Result) == 0 || !json.Valid(answer.Result) {
			c.mu.Unlock()
			return conversationFailure("INVALID_REQUEST", "Invalid approval response")
		}
		payload["result"] = answer.Result
	}
	approval.responding = true
	c.mu.Unlock()
	err := conn.send(ctx, payload)
	c.mu.Lock()
	defer c.mu.Unlock()
	resolved := false
	if c.conn == conn && c.pending[key] == approval {
		if err == nil {
			delete(c.pending, key)
			resolved = c.bridge.current() == conn
		} else {
			approval.responding = false
		}
	}
	if err != nil {
		return err
	}
	if !resolved {
		return nil
	}
	var requestParams struct {
		ThreadID string `json:"threadId"`
	}
	_ = json.Unmarshal(approval.Params, &requestParams)
	params := map[string]any{"requestId": approval.ID}
	if requestParams.ThreadID != "" {
		params["threadId"] = requestParams.ThreadID
	}
	c.publish(map[string]any{"type": "codex/notification", "payload": map[string]any{"method": "serverRequest/resolved", "params": params}})
	return nil
}

func (c *conversation) request(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	return requestConversationNative(ctx, c.bridge.current(), method, params)
}

func requestConversationNative(ctx context.Context, conn *nativeConn, method string, params json.RawMessage) (json.RawMessage, error) {
	return requestConversationWithLate(ctx, conn, method, params, nil)
}

const defaultConversationRequestTimeout = 30 * time.Second

func conversationRequestTimeout(method string) time.Duration {
	switch method {
	case "thread/read", "thread/resume", "thread/turns/list":
		return 90 * time.Second
	default:
		return defaultConversationRequestTimeout
	}
}

func requestConversationWithLate(ctx context.Context, conn *nativeConn, method string, params json.RawMessage, late func(json.RawMessage, error)) (json.RawMessage, error) {
	if conn == nil {
		return nil, errDisconnected
	}
	ctx, cancel := context.WithTimeout(ctx, conversationRequestTimeout(method))
	defer cancel()
	return conn.requestWithLate(ctx, method, params, late)
}

func marshalConversation(value any) (json.RawMessage, error) {
	return json.Marshal(value)
}

func (c *conversation) rpc(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	switch method {
	case "host/requests/list":
		return marshalConversation(map[string]any{"data": c.requestList()})
	case "turn/start", "turn/steer", "host/submissions/get", "host/submissions/list", "host/submissions/reconcile":
		if method == "turn/start" || method == "turn/steer" {
			if result, handled, err := c.sideChats.turn(ctx, method, params); handled {
				return result, err
			}
		}
		return c.submissionRPC(ctx, method, params)
	case "host/delivery/list", "host/delivery/mutate":
		return c.deliveryRPC(ctx, method, params)
	case "host/thread/live":
		return c.liveRPC(ctx, params)
	}
	if !browserConversationMethods[method] {
		return nil, conversationFailure("METHOD_NOT_ALLOWED", "RPC method is not available to browser clients")
	}
	return c.request(ctx, method, params)
}

var nativeThreadMissing = regexp.MustCompile(`(?i)\bthread(?:\s+[0-9a-f-]+)?\s+(?:was\s+)?not found\b`)

func conversationRPCError(id json.RawMessage, err error) browserResponse {
	response := browserResponse{Type: "rpc/error", ID: id, Error: err.Error(), Code: "RPC_DISCONNECTED"}
	var app *conversationError
	var native *nativeError
	switch {
	case errors.As(err, &app):
		response.Code, response.Data = app.code, app.data
		if code, ok := app.code.(int); ok {
			response.NativeCode = &code
		}
	case errors.As(err, &native):
		response.Code, response.NativeCode, response.Data = native.Code, &native.Code, native.Data
		message := strings.ToLower(native.Message)
		if strings.Contains(message, "thread-store conflict") || strings.Contains(message, "already has an active writer") {
			response.Code = "thread_active_writer"
		} else if nativeThreadMissing.MatchString(message) {
			response.Code = "thread_not_found"
		}
	case errors.Is(err, errTimeout), errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		response.Code = "RPC_TIMEOUT"
	case errors.Is(err, errBusy):
		response.Code = "RPC_BUSY"
	}
	return response
}

func (c *conversation) dispatch(ctx context.Context, r browserRequest) browserResponse {
	if r.Type == "ping" {
		return browserResponse{Type: "pong"}
	}
	if r.Type != "rpc" && r.Type != "" {
		return conversationRPCError(r.ID, conversationFailure("INVALID_REQUEST", "Unsupported browser bridge message"))
	}
	if !validBrowserID(r.ID) {
		return conversationRPCError(nil, conversationFailure("INVALID_REQUEST", "Invalid RPC request ID"))
	}
	params := bytes.TrimSpace(r.Params)
	if len(params) == 0 || bytes.Equal(params, []byte("null")) {
		params = []byte("{}")
	}
	if params[0] != '{' || !json.Valid(params) {
		return conversationRPCError(r.ID, conversationFailure("INVALID_REQUEST", "RPC params must be an object"))
	}
	value, err := c.rpc(ctx, r.Method, params)
	if err != nil {
		return conversationRPCError(r.ID, err)
	}
	if value == nil {
		value = []byte("null")
	}
	return browserResponse{Type: "rpc/result", ID: r.ID, Result: value}
}

func conversationObject(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Errorf("encode conversation payload: %w", err))
	}
	return data
}
