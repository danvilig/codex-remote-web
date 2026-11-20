package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testSubmission = "12345678-1234-4567-8abc-123456789abc"
const testSubmission2 = "23456789-1234-4567-8abc-123456789abc"

func conversationErrorIs(err error, code string) bool {
	var failure *conversationError
	return errors.As(err, &failure) && failure.code == code
}

func TestConversationApprovalUsesOriginalConnectionAndID(t *testing.T) {
	socket, peers := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b := new(bridge)
	events := make(chan json.RawMessage, 16)
	c := newConversation(b, t.TempDir(), func(event any) { events <- conversationObject(event) })
	b.onNative = c.onNative
	go b.run(ctx, socket, "test", time.Millisecond)
	peer := acceptSession(t, peers, b)
	request := json.RawMessage(`{"id":"\u0061pprove","method":"item/tool/requestUserInput","params":{"threadId":"thread","questions":[{"id":"one","options":[{"label":"First"}]}]}}`)
	if err := peer.WriteJSON(request); err != nil {
		t.Fatal(err)
	}
	var msg struct{ Payload nativeApproval }
	if err := json.Unmarshal(next(t, events), &msg); err != nil || msg.Payload.Epoch == "" || len(c.requestList()) != 1 {
		t.Fatalf("missing pending request: %+v %v", msg, err)
	}
	answer := conversationAnswer{RequestID: json.RawMessage(`"approve"`), RequestEpoch: msg.Payload.Epoch, Result: json.RawMessage(`{"answers":{"one":{"answers":["Invalid"]}}}`)}
	if err := c.respond(ctx, answer); !conversationErrorIs(err, "INVALID_REQUEST") || len(c.requestList()) != 1 {
		t.Fatalf("invalid answer changed pending approvals: %v", err)
	}
	answer.Result = json.RawMessage(`{"answers":{"one":{"answers":["First"]}}}`)
	results := make(chan error, 2)
	go func() { results <- c.respond(ctx, answer) }()
	go func() { results <- c.respond(ctx, answer) }()
	first, second := next(t, results), next(t, results)
	if (first == nil) == (second == nil) {
		t.Fatalf("expected a single approval response: %v, %v", first, second)
	}
	_ = peer.SetReadDeadline(time.Now().Add(3 * time.Second))
	var received struct{ ID, Result json.RawMessage }
	if err := peer.ReadJSON(&received); err != nil || string(received.ID) != `"\u0061pprove"` || string(received.Result) != string(answer.Result) {
		t.Fatalf("original approval ID or result changed: %+v %v", received, err)
	}
	if event := next(t, events); !strings.Contains(string(event), `"method":"serverRequest/resolved"`) {
		t.Fatalf("missing resolution: %s", event)
	}
	_ = peer.Close()
	waitState(t, b, false)
	peer = acceptSession(t, peers, b)
	if err := peer.WriteJSON(request); err != nil {
		t.Fatal(err)
	}
	_ = next(t, events)
	if err := c.respond(ctx, answer); !conversationErrorIs(err, "REQUEST_STALE") || len(c.requestList()) != 1 {
		t.Fatalf("stale approval reached current request: %v", err)
	}
	if result := c.dispatch(ctx, browserRequest{ID: json.RawMessage(`1`), Method: "thread/inject_items"}); result.Code != "METHOD_NOT_ALLOWED" {
		t.Fatalf("browser forwarded an internal native call: %+v", result)
	}
}

func TestConversationSubmissionRetryAndReconcile(t *testing.T) {
	root := t.TempDir()
	var sends atomic.Int32
	var match atomic.Bool
	started, proceed := make(chan struct{}), make(chan struct{})
	request := func(_ context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
		if method == "thread/turns/list" {
			client := testSubmission2
			if match.Load() {
				client = testSubmission
			}
			return conversationObject(map[string]any{"data": []any{map[string]any{"id": "turn", "items": []any{map[string]string{"type": "userMessage", "clientId": client}}}}}), nil
		}
		if err := json.Unmarshal(params, &map[string]any{}); err != nil || !strings.Contains(string(params), testSubmission) {
			return nil, errors.New("missing native client ID")
		}
		if sends.Add(1) == 1 {
			close(started)
			<-proceed
		}
		return nil, errDisconnected
	}
	store := newSubmissionStore(root, request, func() bool { return true }, nil)
	input, err := parseSubmission("turn/start", json.RawMessage(`{"threadId":"thread","input":[{"type":"text","text":"test"}],"clientUserMessageId":"`+testSubmission+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		receipt submissionReceipt
		err     error
	}
	results := make(chan outcome, 2)
	submit := func() { receipt, err := store.submit(t.Context(), input, nil); results <- outcome{receipt, err} }
	go submit()
	<-started
	go submit()
	close(proceed)
	for range 2 {
		if result := next(t, results); result.err != nil || result.receipt.Status != "unknown" {
			t.Fatalf("disconnect must leave uncertain delivery: %+v", result)
		}
	}
	upgraded := newSubmissionStore(root, request, func() bool { return true }, nil)
	if receipt, err := upgraded.submit(t.Context(), input, nil); err != nil || receipt.Status != "unknown" || sends.Load() != 1 {
		t.Fatalf("uncertain native request was retried: %+v %v, sends %d", receipt, err, sends.Load())
	}
	changed := input
	changed.digest = strings.Repeat("a", 64)
	if _, err := upgraded.submit(t.Context(), changed, nil); !conversationErrorIs(err, "SUBMISSION_CONFLICT") {
		t.Fatalf("changed content reused a UUID: %v", err)
	}
	if result, err := upgraded.reconcile(t.Context(), input.id); err != nil || result.Status != "unknown" {
		t.Fatalf("unmatched client ID was accepted: %+v %v", result, err)
	}
	match.Store(true)
	if result, err := upgraded.reconcile(t.Context(), input.id); err != nil || result.Status != "accepted" || result.TurnID != "turn" || result.ReconciledAt == "" {
		t.Fatalf("matching client ID did not reconcile: %+v %v", result, err)
	}
}

func TestConversationSubmissionSettlesLateNativeReplies(t *testing.T) {
	for _, nativeReject := range []bool{false, true} {
		t.Run(fmt.Sprintf("nativeReject=%t", nativeReject), func(t *testing.T) {
			socket, peers := fixture(t)
			ctx, stopBridge := context.WithCancel(t.Context())
			defer stopBridge()
			b := new(bridge)
			c := newConversation(b, t.TempDir(), nil)
			go b.run(ctx, socket, "test", time.Millisecond)
			peer := acceptSession(t, peers, b)
			nativeContext, expire := context.WithCancel(t.Context())
			defer expire()
			c.submissions.requestWithLate = func(_ context.Context, method string, params json.RawMessage, late func(json.RawMessage, error)) (json.RawMessage, error) {
				return requestConversationWithLate(nativeContext, b.current(), method, params, late)
			}
			params := json.RawMessage(`{"threadId":"thread","input":[{"type":"text","text":"late response fixture"}],"clientUserMessageId":"` + testSubmission + `"}`)
			request := browserRequest{Type: "rpc", ID: json.RawMessage(`41`), Method: "turn/start", Params: params}
			outcome := make(chan browserResponse, 1)
			go func() { outcome <- c.dispatch(ctx, request) }()
			native := getRequest(t, peer)
			if native.Method != "turn/start" || !strings.Contains(string(native.Params), testSubmission) {
				t.Fatalf("wrong dispatch: %+v", native)
			}
			expire()
			if response := next(t, outcome); response.Code != "SUBMISSION_UNKNOWN" {
				t.Fatalf("no provisional unknown receipt: %+v", response)
			}
			out := map[string]any{"id": fmt.Sprint(native.ID)}
			want := "accepted"
			if nativeReject {
				out["error"] = map[string]any{"code": -32000, "message": "fixture rejected"}
				want = "rejected"
			} else {
				out["result"] = map[string]any{"turn": map[string]string{"id": "late-turn"}}
			}
			if err := peer.WriteJSON(out); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(3 * time.Second)
			for {
				receipt, err := c.submissions.get(testSubmission)
				if err != nil {
					t.Fatal(err)
				}
				if receipt.Status == want {
					if nativeReject && (receipt.Error == nil || receipt.Error.Message != "fixture rejected") {
						t.Fatalf("native rejection lost: %+v", receipt)
					}
					if !nativeReject && (receipt.Error != nil || receipt.TurnID != "late-turn") {
						t.Fatalf("native acceptance lost: %+v", receipt)
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("late native result did not settle receipt: %+v", receipt)
				}
				time.Sleep(time.Millisecond)
			}
			before := b.current().nextID
			response := c.dispatch(ctx, request)
			if nativeReject && (response.Code != -32000 || response.NativeCode == nil || *response.NativeCode != -32000) {
				t.Fatalf("native code was not kept on retry: %+v", response)
			}
			if !nativeReject && (response.Type != "rpc/result" || !strings.Contains(string(response.Result), "late-turn")) {
				t.Fatalf("native result was not kept on retry: %+v", response)
			}
			if after := b.current().nextID; before != after {
				t.Fatal("retry sent another native mutation")
			}
		})
	}
}

func TestQueueRecoveryDoesNotRetrySendingEntry(t *testing.T) {
	c := newConversation(new(bridge), t.TempDir(), nil)
	q := c.delivery
	old := conversationOwner{PID: 1, Host: "previous-host", Instance: "old"}
	if err := q.transaction(func(s *deliveryQueueState) (bool, error) {
		s.Entries = append(s.Entries,
			deliveryQueueRecord{deliveryQueueEntry: deliveryQueueEntry{ID: testSubmission, ThreadID: "thread", Status: "sending", Version: 1}, Owner: &old, Claim: &old},
			deliveryQueueRecord{deliveryQueueEntry: deliveryQueueEntry{ID: testSubmission2, ThreadID: "thread", Status: "queued", Version: 1}, Owner: &old},
		)
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	entries, err := q.list("thread")
	if err != nil || len(entries) != 2 || entries[0].Status != "unknown" || entries[1].Status != "paused" {
		t.Fatalf("restart recovery changed dispatch guarantees: %+v %v", entries, err)
	}
	if _, err := q.mutate(t.Context(), "resume", conversationObject(map[string]any{"id": testSubmission2, "version": entries[1].Version})); !conversationErrorIs(err, "QUEUE_DELIVERY_UNCONFIRMED") {
		t.Fatalf("later queue entry passed an unknown dispatch: %v", err)
	}
}

func TestConversationLiveRolloutKeepsPartialLineAndRoot(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "rollout.jsonl")
	begin := `{"type":"event_msg","timestamp":"one","payload":{"type":"task_started","turn_id":"turn"}}` + "\n"
	partial := `{"type":"response_item","timestamp":"two","payload":{"type":"message","role":"assistant","content":[{"text":"hello"}]}}`
	if err := os.WriteFile(path, []byte(begin+partial[:40]), 0600); err != nil {
		t.Fatal(err)
	}
	store := newConversationLiveStore()
	result, err := store.read(root, path)
	if err != nil || !strings.Contains(string(result), `"items":[]`) {
		t.Fatalf("partial line reached live conversation: %s %v", result, err)
	}
	if err := os.WriteFile(path, []byte(begin+partial+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err = store.read(root, path)
	if err != nil || !strings.Contains(string(result), `"text":"hello"`) {
		t.Fatalf("complete appended record was not restored: %s %v", result, err)
	}
	outside := filepath.Join(t.TempDir(), "outside.jsonl")
	if err := os.WriteFile(outside, []byte(begin), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked.jsonl")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if _, err := store.read(root, link); err == nil {
		t.Fatal("thread rollout escaped the sessions directory")
	}
}

func TestConversationSideChatPromotesWithoutReplaying(t *testing.T) {
	socket, peers := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b := new(bridge)
	c := newConversation(b, t.TempDir(), nil)
	c.sideChats.resolveCwd = func(input string) (string, error) { return input, nil }
	b.onNative = c.onNative
	go b.run(ctx, socket, "test", time.Millisecond)
	peer := acceptSession(t, peers, b)
	type outcome struct {
		value json.RawMessage
		err   error
	}
	call := func(action string) <-chan outcome {
		result := make(chan outcome, 1)
		go func() {
			params := sideChatInput{Action: action, SessionID: testSubmission}
			if action == "create" {
				params.Cwd = "/fixture"
			}
			value, err := c.sideChats.handle(ctx, params)
			result <- outcome{value, err}
		}()
		return result
	}
	created := call("create")
	native := getRequest(t, peer)
	if native.Method != "thread/start" || !strings.Contains(string(native.Params), `"ephemeral":true`) {
		t.Fatalf("side chat did not use a temporary native thread: %+v", native)
	}
	sendResult(t, peer, native.ID, map[string]any{"thread": map[string]any{"id": "side", "cwd": "/fixture", "ephemeral": true}})
	if result := next(t, created); result.err != nil {
		t.Fatal(result.err)
	}
	for _, payload := range []string{
		`{"method":"turn/started","params":{"threadId":"side","turn":{"id":"turn","status":"inProgress"}}}`,
		`{"method":"item/completed","params":{"threadId":"side","turnId":"turn","item":{"id":"input","type":"userMessage","content":[{"type":"text","text":"Question"}]}}}`,
		`{"method":"item/agentMessage/delta","params":{"threadId":"side","turnId":"turn","itemId":"assistant","delta":"Answer"}}`,
		`{"method":"item/completed","params":{"threadId":"side","turnId":"turn","item":{"id":"tool","type":"commandExecution","command":"fixture only","status":"completed"}}}`,
		`{"method":"turn/completed","params":{"threadId":"side","turn":{"id":"turn","status":"completed"}}}`,
	} {
		if err := peer.WriteJSON(json.RawMessage(payload)); err != nil {
			t.Fatal(err)
		}
	}
	cutoff := time.Now().Add(3 * time.Second)
	for {
		snapshot := next(t, call("snapshot"))
		if strings.Contains(string(snapshot.value), `"status":"completed"`) && strings.Contains(string(snapshot.value), `"activeTurnId":""`) {
			break
		}
		if time.Now().After(cutoff) {
			t.Fatalf("side chat did not recover native events: %s %v", snapshot.value, snapshot.err)
		}
		time.Sleep(time.Millisecond)
	}
	promoted := call("promote")
	native = getRequest(t, peer)
	if native.Method != "thread/start" || !strings.Contains(string(native.Params), `"ephemeral":false`) {
		t.Fatalf("side chat did not create a persistent prefix: %+v", native)
	}
	sendResult(t, peer, native.ID, map[string]any{"thread": map[string]any{"id": "saved", "cwd": "/fixture", "ephemeral": false}})
	native = getRequest(t, peer)
	if native.Method != "thread/inject_items" || !strings.Contains(string(native.Params), `"threadId":"saved"`) || !strings.Contains(string(native.Params), `"output_text"`) || !strings.Contains(string(native.Params), `Side chat tool record: commandExecution`) {
		t.Fatalf("side chat tool history was not saved as text: %+v", native)
	}
	sendResult(t, peer, native.ID, struct{}{})
	if result := next(t, promoted); result.err != nil || !strings.Contains(string(result.value), `"id":"saved"`) {
		t.Fatalf("promotion failed: %+v", result)
	}
	if result := next(t, call("promote")); result.err != nil || !strings.Contains(string(result.value), `"id":"saved"`) {
		t.Fatalf("finished promotion was not idempotent: %+v", result)
	}
}

func TestConversationLockInteroperatesWithBunSQLite(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun runtime is absent; package does not require it")
	}
	dir := filepath.Join(t.TempDir(), "private")
	if err := ensureDesktopDirectory(dir); err != nil {
		t.Fatal(err)
	}
	host, _ := os.Hostname()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	path := filepath.Join(dir, "store.lock.sqlite")
	release, err := lockConversation(dir, "store.lock", host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(release)
	tryBun := func() (string, error) {
		out, err := exec.CommandContext(ctx, bun, "-e", `import { Database } from "bun:sqlite";
const db = new Database(process.argv[1]); db.exec("PRAGMA busy_timeout = 0");
try { db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); console.log("available"); }
catch (err) { if (err.code !== "SQLITE_BUSY" && err.code !== "SQLITE_LOCKED") throw err; console.log("busy"); }`, path).CombinedOutput()
		return strings.TrimSpace(string(out)), err
	}
	if result, err := tryBun(); result != "busy" || err != nil {
		t.Fatalf("Go lock did not block Bun: %q %v", result, err)
	}
	release()
	if result, err := tryBun(); result != "available" || err != nil {
		t.Fatalf("Bun lock did not resume: %q %v", result, err)
	}
}
