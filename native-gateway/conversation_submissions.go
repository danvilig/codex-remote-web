package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"sync"
	"time"
	"unicode/utf16"
)

const submissionStoreLimit = 32 << 20

var submissionUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type conversationOwner struct {
	PID      int    `json:"pid"`
	Host     string `json:"host"`
	Stamp    string `json:"stamp,omitempty"`
	Instance string `json:"instance"`
}

func uuidConversation() string {
	var id [16]byte
	_, _ = rand.Read(id[:])
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}

func newConversationOwner() conversationOwner {
	host, _ := os.Hostname()
	return conversationOwner{PID: os.Getpid(), Host: host, Stamp: conversationStamp(os.Getpid()), Instance: uuidConversation()}
}

func (owner conversationOwner) alive(host string) bool {
	if owner.Host != host || owner.PID < 1 {
		return false
	}
	return processAlive(owner.PID, owner.Stamp)
}

func readConversationPrivate(path string, limit int) ([]byte, error) {
	file, err := desktopOpen(path, os.O_RDONLY, limit, true)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, int64(limit)+1))
	if len(data) > limit {
		return nil, errors.New("Private state is too large")
	}
	return data, err
}

// Both gateways coordinate through the same .sqlite inode. Pre-SQLite marker
// files still need checking so a running old process cannot be bypassed.
func lockConversation(directory, name, host string, timeout time.Duration) (func(), error) {
	if err := ensureDesktopDirectory(directory); err != nil {
		return nil, conversationFailure("PRIVATE_LOCK_UNSAFE", err.Error())
	}
	legacy, err := readConversationPrivate(filepath.Join(directory, name), 1<<20)
	if err == nil {
		var marker struct {
			Owner *conversationOwner `json:"owner"`
		}
		if json.Unmarshal(legacy, &marker) != nil || marker.Owner == nil || marker.Owner.alive(host) {
			return nil, conversationFailure("PRIVATE_LOCK_LEGACY_BUSY", "An older gateway may still own this lock. Stop it before upgrading.")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, conversationFailure("PRIVATE_LOCK_UNSAFE", err.Error())
	}
	release, err := lockDesktop(directory, name, timeout)
	if code := desktopErrorCode(err); code != "" {
		return nil, conversationFailure(code, err.Error())
	}
	return release, err
}

type submissionRecordError struct {
	Code    any    `json:"code"`
	Message string `json:"message"`
}

type submissionReceipt struct {
	ID           string                 `json:"id"`
	Status       string                 `json:"status"`
	Method       string                 `json:"method"`
	ThreadID     string                 `json:"threadId"`
	TargetTurnID string                 `json:"targetTurnId,omitempty"`
	TurnID       string                 `json:"turnId,omitempty"`
	Result       json.RawMessage        `json:"result,omitempty"`
	Error        *submissionRecordError `json:"error,omitempty"`
	CreatedAt    string                 `json:"createdAt,omitempty"`
	UpdatedAt    string                 `json:"updatedAt,omitempty"`
	ReconciledAt string                 `json:"reconciledAt,omitempty"`
}

type submissionRecord struct {
	submissionReceipt
	Digest string            `json:"digest"`
	Owner  conversationOwner `json:"owner"`
}

type submissionState struct {
	Format   int                `json:"format"`
	Receipts []submissionRecord `json:"receipts"`
}

type submissionInput struct {
	id, method, threadID, target, digest string
	params                               json.RawMessage
}

type pendingSubmission struct {
	digest  string
	done    chan struct{}
	receipt submissionReceipt
	err     error
}

type submissionStore struct {
	directory       string
	owner           conversationOwner
	request         func(context.Context, string, json.RawMessage) (json.RawMessage, error)
	requestWithLate func(context.Context, string, json.RawMessage, func(json.RawMessage, error)) (json.RawMessage, error)
	connected       func() bool
	notify          func(submissionReceipt)
	mu              sync.Mutex
	inflight        map[string]*pendingSubmission
}

func newSubmissionStore(root string, request func(context.Context, string, json.RawMessage) (json.RawMessage, error), connected func() bool, notify func(submissionReceipt)) *submissionStore {
	if notify == nil {
		notify = func(submissionReceipt) {}
	}
	return &submissionStore{directory: filepath.Join(root, "remote-web-submissions"), owner: newConversationOwner(), request: request, connected: connected, notify: notify, inflight: make(map[string]*pendingSubmission)}
}

func conversationHash(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

// Match the original JavaScript canonical digest, including JSON.stringify's
// escaping and UTF-16 ordering. This keeps retries stable across upgrades.
func writeConversationJSONString(out *bytes.Buffer, text string) {
	out.WriteByte('"')
	for _, r := range text {
		switch r {
		case '"', '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(out, `\u%04x`, r)
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
}

func canonicalConversation(out *bytes.Buffer, value any) error {
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		slices.SortFunc(keys, func(a, b string) int {
			return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
		})
		out.WriteByte('{')
		for i, key := range keys {
			if i != 0 {
				out.WriteByte(',')
			}
			writeConversationJSONString(out, key)
			out.WriteByte(':')
			if err := canonicalConversation(out, v[key]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	case []any:
		out.WriteByte('[')
		for i, item := range v {
			if i != 0 {
				out.WriteByte(',')
			}
			if err := canonicalConversation(out, item); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case string:
		writeConversationJSONString(out, v)
	default:
		if number, ok := v.(float64); ok && number == 0 {
			v = float64(0)
		}
		data, err := json.Marshal(v)
		if err != nil {
			return err
		}
		out.Write(data)
	}
	return nil
}

func parseSubmission(method string, params json.RawMessage) (submissionInput, error) {
	var body map[string]any
	invalid := conversationFailure("SUBMISSION_INVALID", "Unsupported submission parameters")
	if (method != "turn/start" && method != "turn/steer") || json.Unmarshal(params, &body) != nil || body == nil {
		return submissionInput{}, invalid
	}
	thread, _ := body["threadId"].(string)
	target, _ := body["expectedTurnId"].(string)
	input, _ := body["input"].([]any)
	if thread == "" || len(utf16.Encode([]rune(thread))) > 300 || len(input) == 0 || (method == "turn/steer" && target == "") {
		return submissionInput{}, invalid
	}
	id, ok := body["clientUserMessageId"].(string)
	if body["clientUserMessageId"] == nil {
		id, ok = uuidConversation(), true
	}
	if !ok || !submissionUUID.MatchString(id) {
		return submissionInput{}, conversationFailure("SUBMISSION_INVALID", "A submission UUID is required")
	}
	body["clientUserMessageId"] = id
	var canonical bytes.Buffer
	if canonicalConversation(&canonical, map[string]any{"method": method, "params": body}) != nil || canonical.Len() > 2<<20 {
		return submissionInput{}, conversationFailure("SUBMISSION_INVALID", "Invalid or oversized submission payload")
	}
	return submissionInput{id: id, method: method, threadID: thread, target: target, digest: conversationHash(canonical.Bytes()), params: conversationObject(body)}, nil
}

func conversationTimestamp() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func (s *submissionStore) transaction(edit func(*submissionState) (bool, error)) error {
	release, err := lockConversation(s.directory, "store.lock", s.owner.Host, 5*time.Second)
	if err != nil {
		return err
	}
	defer release()
	path := filepath.Join(s.directory, "receipts.json")
	state := submissionState{Format: 1, Receipts: []submissionRecord{}}
	data, err := readConversationPrivate(path, submissionStoreLimit)
	if err == nil {
		if json.Unmarshal(data, &state) != nil || state.Format != 1 || state.Receipts == nil || len(state.Receipts) > 10000 {
			return conversationFailure("SUBMISSION_STORAGE_UNSAFE", "Invalid submission state")
		}
		seen := make(map[string]bool, len(state.Receipts))
		for _, receipt := range state.Receipts {
			switch receipt.Status {
			case "prepared", "dispatching", "accepted", "rejected", "unknown":
			default:
				return conversationFailure("SUBMISSION_STORAGE_UNSAFE", "Invalid submission status")
			}
			if seen[receipt.ID] || !submissionUUID.MatchString(receipt.ID) || len(receipt.Digest) != 64 {
				return conversationFailure("SUBMISSION_STORAGE_UNSAFE", "Invalid submission identity")
			}
			seen[receipt.ID] = true
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return conversationFailure("SUBMISSION_STORAGE_UNSAFE", "Unsafe submission state")
	}
	changed, err := edit(&state)
	if err != nil || !changed {
		return err
	}
	data, err = json.Marshal(state)
	if err != nil {
		return err
	}
	if len(data) > submissionStoreLimit {
		return conversationFailure("SUBMISSION_STORAGE_FULL", "Submission storage limit reached")
	}
	return writeDesktopFile(path, data)
}

func (s *submissionStore) recoverState(state *submissionState) bool {
	changed := false
	for i := range state.Receipts {
		receipt := &state.Receipts[i]
		if (receipt.Status != "prepared" && receipt.Status != "dispatching") || receipt.Owner.alive(s.owner.Host) {
			continue
		}
		if receipt.Status == "prepared" {
			receipt.Status = "rejected"
			receipt.Error = &submissionRecordError{"SUBMISSION_NOT_DISPATCHED", "The gateway stopped before dispatch. This submission was not sent."}
		} else {
			receipt.Status = "unknown"
			receipt.Error = &submissionRecordError{"SUBMISSION_UNKNOWN", "Native acceptance could not be confirmed. This submission was not replayed."}
		}
		receipt.UpdatedAt = conversationTimestamp()
		changed = true
	}
	return changed
}

func (s *submissionStore) get(id string) (*submissionReceipt, error) {
	var result *submissionReceipt
	err := s.transaction(func(state *submissionState) (bool, error) {
		changed := s.recoverState(state)
		for _, row := range state.Receipts {
			if row.ID == id {
				result = &row.submissionReceipt
				break
			}
		}
		return changed, nil
	})
	return result, err
}

func (s *submissionStore) listPending(thread string) ([]submissionReceipt, error) {
	list := []submissionReceipt{}
	err := s.transaction(func(state *submissionState) (bool, error) {
		changed := s.recoverState(state)
		for _, row := range state.Receipts {
			if (thread == "" || thread == row.ThreadID) && (row.Status == "prepared" || row.Status == "dispatching" || row.Status == "unknown") {
				list = append(list, row.submissionReceipt)
			}
		}
		return changed, nil
	})
	return list, err
}

func (s *submissionStore) update(id string, change func(*submissionRecord) bool) (submissionReceipt, error) {
	var result submissionReceipt
	err := s.transaction(func(state *submissionState) (bool, error) {
		for i := range state.Receipts {
			row := &state.Receipts[i]
			if row.ID != id {
				continue
			}
			changed := change(row)
			if changed {
				row.UpdatedAt = conversationTimestamp()
			}
			result = row.submissionReceipt
			return changed, nil
		}
		return false, conversationFailure("SUBMISSION_NOT_FOUND", "Submission receipt not found")
	})
	if err == nil {
		s.notify(result)
	}
	return result, err
}

func (s *submissionStore) submit(ctx context.Context, input submissionInput, beforeDispatch func() (bool, error)) (submissionReceipt, error) {
	s.mu.Lock()
	if existing := s.inflight[input.id]; existing != nil {
		s.mu.Unlock()
		if input.digest != existing.digest {
			return submissionReceipt{}, conversationFailure("SUBMISSION_CONFLICT", "Submission UUID was already used for different content")
		}
		select {
		case <-existing.done:
			return existing.receipt, existing.err
		case <-ctx.Done():
			return submissionReceipt{}, ctx.Err()
		}
	}
	pending := &pendingSubmission{digest: input.digest, done: make(chan struct{})}
	s.inflight[input.id] = pending
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.inflight, input.id)
		close(pending.done)
		s.mu.Unlock()
	}()
	// A browser disconnect cannot cancel a dispatch that was durably reserved.
	pending.receipt, pending.err = s.dispatch(context.WithoutCancel(ctx), input, beforeDispatch)
	return pending.receipt, pending.err
}

func (s *submissionStore) dispatch(ctx context.Context, input submissionInput, beforeDispatch func() (bool, error)) (submissionReceipt, error) {
	var receipt submissionReceipt
	created := false
	err := s.transaction(func(state *submissionState) (bool, error) {
		changed := s.recoverState(state)
		for _, row := range state.Receipts {
			if row.ID == input.id {
				if row.Digest != input.digest {
					return false, conversationFailure("SUBMISSION_CONFLICT", "Submission UUID was already used for different content")
				}
				receipt = row.submissionReceipt
				return changed, nil
			}
		}
		if !s.connected() {
			return false, conversationFailure("SUBMISSION_UNAVAILABLE", "Connect to Codex before sending")
		}
		if len(state.Receipts) >= 10000 {
			return false, conversationFailure("SUBMISSION_STORAGE_FULL", "Submission receipt capacity reached")
		}
		now := conversationTimestamp()
		receipt = submissionReceipt{ID: input.id, Status: "prepared", Method: input.method, ThreadID: input.threadID, TargetTurnID: input.target, CreatedAt: now, UpdatedAt: now}
		state.Receipts = append(state.Receipts, submissionRecord{submissionReceipt: receipt, Owner: s.owner, Digest: input.digest})
		created = true
		return true, nil
	})
	if err != nil || !created {
		return receipt, err
	}
	s.notify(receipt)
	reject := func(message string) (submissionReceipt, error) {
		return s.update(input.id, func(row *submissionRecord) bool {
			if row.Status != "prepared" || row.Owner.Instance != s.owner.Instance {
				return false
			}
			row.Status = "rejected"
			row.Error = &submissionRecordError{"SUBMISSION_NOT_DISPATCHED", message}
			return true
		})
	}
	release, err := lockConversation(s.directory, "thread-"+conversationHash([]byte(input.threadID))+".lock", s.owner.Host, 2*time.Minute)
	if err != nil {
		return reject(err.Error())
	}
	defer release()
	if !s.connected() {
		return reject("The gateway disconnected before dispatch. This submission was not sent.")
	}
	if beforeDispatch != nil {
		ready, err := beforeDispatch()
		if err != nil {
			return reject(err.Error())
		}
		if !ready {
			deferred := submissionReceipt{}
			err := s.transaction(func(state *submissionState) (bool, error) {
				for i, row := range state.Receipts {
					if row.ID != input.id {
						continue
					}
					if row.Status != "prepared" || row.Owner.Instance != s.owner.Instance {
						deferred = row.submissionReceipt
						return false, nil
					}
					state.Receipts = slices.Delete(state.Receipts, i, i+1)
					deferred = submissionReceipt{ID: input.id, Status: "deferred", ThreadID: input.threadID, Method: input.method}
					return true, nil
				}
				return false, conversationFailure("SUBMISSION_NOT_FOUND", "Submission receipt not found")
			})
			if err == nil {
				s.notify(deferred)
			}
			return deferred, err
		}
	}
	receipt, err = s.update(input.id, func(row *submissionRecord) bool {
		if row.Status != "prepared" || row.Owner.Instance != s.owner.Instance {
			return false
		}
		row.Status = "dispatching"
		return true
	})
	if err != nil || receipt.Status != "dispatching" {
		return receipt, err
	}
	var result json.RawMessage
	var callError error
	if s.requestWithLate != nil {
		result, callError = s.requestWithLate(ctx, input.method, input.params, func(result json.RawMessage, err error) {
			_, _ = s.settle(input.id, result, err, true)
		})
	} else {
		result, callError = s.request(ctx, input.method, input.params)
	}
	return s.settle(input.id, result, callError, false)
}

func (s *submissionStore) settle(id string, result json.RawMessage, callError error, late bool) (submissionReceipt, error) {
	return s.update(id, func(row *submissionRecord) bool {
		if (row.Status != "dispatching" && !(late && row.Status == "unknown")) || row.Owner.Instance != s.owner.Instance {
			return false
		}
		if callError == nil {
			var ids struct {
				TurnID string `json:"turnId"`
				Turn   struct {
					ID string `json:"id"`
				} `json:"turn"`
			}
			_ = json.Unmarshal(result, &ids)
			row.Status, row.Result, row.TurnID, row.Error = "accepted", result, ids.Turn.ID, nil
			if row.TurnID == "" {
				row.TurnID = ids.TurnID
			}
			return true
		}
		var native *nativeError
		if errors.As(callError, &native) {
			code := conversationRPCError(nil, callError).Code
			row.Status, row.Error = "rejected", &submissionRecordError{code, native.Message}
		} else if late {
			return false
		} else if errors.Is(callError, errBusy) {
			row.Status, row.Error = "rejected", &submissionRecordError{"SUBMISSION_NOT_DISPATCHED", callError.Error()}
		} else {
			row.Status = "unknown"
			row.Error = &submissionRecordError{"SUBMISSION_UNKNOWN", "Native acceptance could not be confirmed. This submission was not replayed."}
		}
		return true
	})
}

func (s *submissionStore) reconcile(ctx context.Context, id string) (*submissionReceipt, error) {
	receipt, err := s.get(id)
	if err != nil || receipt == nil || receipt.Status != "unknown" || !s.connected() {
		return receipt, err
	}
	params := map[string]any{"threadId": receipt.ThreadID, "limit": 50, "sortDirection": "desc", "itemsView": "full"}
	seen := make(map[string]bool)
	for page := 0; page < 20; page++ {
		result, err := s.request(ctx, "thread/turns/list", conversationObject(params))
		if err != nil {
			break
		}
		var list struct {
			Data       []json.RawMessage `json:"data"`
			NextCursor string            `json:"nextCursor"`
		}
		if json.Unmarshal(result, &list) != nil {
			break
		}
		for _, raw := range list.Data {
			var turn struct {
				ID    string `json:"id"`
				Items []struct {
					Type     string `json:"type"`
					ClientID string `json:"clientId"`
				} `json:"items"`
			}
			if json.Unmarshal(raw, &turn) != nil || turn.ID == "" {
				continue
			}
			for _, item := range turn.Items {
				if item.Type == "userMessage" && item.ClientID == id {
					result, err := s.update(id, func(row *submissionRecord) bool {
						if row.Status != "unknown" {
							return false
						}
						row.ReconciledAt = conversationTimestamp()
						row.Status, row.TurnID, row.Error = "accepted", turn.ID, nil
						if row.Method == "turn/steer" {
							row.Result = conversationObject(map[string]string{"turnId": turn.ID})
						} else {
							row.Result = conversationObject(map[string]json.RawMessage{"turn": raw})
						}
						return true
					})
					return &result, err
				}
			}
		}
		if list.NextCursor == "" || seen[list.NextCursor] {
			break
		}
		seen[list.NextCursor] = true
		params["cursor"] = list.NextCursor
	}
	return s.get(id)
}

func submissionResult(receipt submissionReceipt) (json.RawMessage, error) {
	if receipt.Status == "accepted" {
		return receipt.Result, nil
	}
	code := any("SUBMISSION_UNKNOWN")
	message := "Delivery could not be confirmed. It was not replayed."
	if receipt.Error != nil && receipt.Error.Message != "" {
		message = receipt.Error.Message
	}
	if receipt.Status == "rejected" {
		code = "SUBMISSION_REJECTED"
		if receipt.Error != nil && receipt.Error.Code != nil {
			code = receipt.Error.Code
			if number, ok := code.(float64); ok {
				code, _ = strconv.Atoi(strconv.FormatFloat(number, 'f', 0, 64))
			}
		}
	}
	return nil, &conversationError{code: code, message: message, data: conversationObject(map[string]string{"submissionId": receipt.ID, "status": receipt.Status})}
}

func (c *conversation) submissionRPC(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	if c.submissions == nil {
		return nil, conversationFailure("SUBMISSION_STORAGE_UNSAFE", "A private Codex state directory is required")
	}
	var filters struct {
		ID       string `json:"id"`
		ThreadID string `json:"threadId"`
	}
	switch method {
	case "host/submissions/get", "host/submissions/list", "host/submissions/reconcile":
		if json.Unmarshal(params, &filters) != nil {
			return nil, conversationFailure("SUBMISSION_INVALID", "Invalid submission lookup")
		}
	}
	var result any
	var err error
	switch method {
	case "host/submissions/get":
		result, err = c.submissions.get(filters.ID)
	case "host/submissions/list":
		var rows []submissionReceipt
		rows, err = c.submissions.listPending(filters.ThreadID)
		result = map[string]any{"data": rows}
	case "host/submissions/reconcile":
		result, err = c.submissions.reconcile(ctx, filters.ID)
	default:
		input, err := parseSubmission(method, params)
		if err != nil {
			return nil, err
		}
		receipt, err := c.submissions.submit(ctx, input, nil)
		if err != nil {
			return nil, err
		}
		return submissionResult(receipt)
	}
	if err != nil {
		return nil, err
	}
	return marshalConversation(result)
}
