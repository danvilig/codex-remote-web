package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func scheduleFixtureState(t *testing.T, s *conversationScheduler, status string) scheduleState {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		state, err := s.read()
		if err != nil {
			t.Fatal(err)
		}
		if len(state.Runs) != 0 && state.Runs[len(state.Runs)-1].Status == status {
			return state
		}
		if time.Now().After(deadline) {
			t.Fatalf("run did not become %s: %+v", status, state.Runs)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func TestConversationSchedulerReservesAndDisablesInterruptedRun(t *testing.T) {
	socket, peers := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b := new(bridge)
	c := newConversation(b, t.TempDir(), nil)
	s := c.scheduler
	s.resolveCwd = func(input string) (string, error) { return input, nil }
	b.onNative = c.onNative
	go b.run(ctx, socket, "test", time.Millisecond)
	peer := acceptSession(t, peers, b)
	model, enabled, interval := "", true, int64(86400000)
	when := scheduleDate(time.Now().Add(time.Hour))
	task := &scheduleTask{Name: "Fixture", Prompt: "Scheduled task", Cwd: "/fixture", Model: &model, Sandbox: "read-only", IntervalMS: &interval, NextRunAt: when, Enabled: &enabled}
	create := scheduleMutation{Action: "create", Confirmed: true, RequestID: testSubmission, Task: task}
	if _, err := s.mutate(create); err != nil {
		t.Fatal(err)
	}
	if result, err := s.mutate(create); err != nil || strings.Contains(string(result), "creationKey") {
		t.Fatalf("create retry returned private state: %s %v", result, err)
	}
	state, err := s.read()
	if err != nil || len(state.Jobs) != 1 {
		t.Fatalf("manual create was not deduplicated: %+v %v", state, err)
	}
	job := state.Jobs[0]
	start := scheduleMutation{Action: "run", Confirmed: true, ID: job.ID, Revision: job.Revision, RequestID: testSubmission2}
	if _, err = s.mutate(start); err != nil {
		t.Fatal(err)
	}
	if _, err = s.mutate(start); err != nil {
		t.Fatal(err)
	}
	native := getRequest(t, peer)
	if native.Method != "thread/start" || !strings.Contains(string(native.Params), `"sandbox":"read-only"`) || !strings.Contains(string(native.Params), `"approvalPolicy":"on-request"`) {
		t.Fatalf("scheduler widened native execution policy: %+v", native)
	}
	sendResult(t, peer, native.ID, map[string]any{"thread": map[string]string{"id": "scheduled-thread"}})
	native = getRequest(t, peer)
	if native.Method != "turn/start" || !strings.Contains(string(native.Params), `"threadId":"scheduled-thread"`) {
		t.Fatalf("invalid scheduled turn: %+v", native)
	}
	sendResult(t, peer, native.ID, map[string]any{"turn": map[string]string{"id": "scheduled-turn"}})
	state = scheduleFixtureState(t, s, "running")
	if len(state.Runs) != 1 {
		t.Fatalf("request identity launched multiple runs: %+v", state.Runs)
	}
	if err := peer.WriteJSON(json.RawMessage(`{"id":17,"method":"item/commandExecution/requestApproval","params":{"threadId":"scheduled-thread"}}`)); err != nil {
		t.Fatal(err)
	}
	s.process(next(t, s.events))
	scheduleFixtureState(t, s, "waiting")
	_ = peer.Close()
	waitState(t, b, false)
	s.interrupted()
	state = scheduleFixtureState(t, s, "interrupted")
	if *state.Jobs[0].Enabled || state.Jobs[0].Revision <= job.Revision || !strings.Contains(state.Runs[0].Error, "not replayed") {
		t.Fatalf("disconnect did not pause job safely: %+v", state)
	}
	_ = acceptSession(t, peers, b)
	s.tick(b.current())
	state = scheduleFixtureState(t, s, "interrupted")
	if len(state.Runs) != 1 {
		t.Fatalf("reconnection dispatched an interrupted run: %+v", state.Runs)
	}
}

func TestConversationSchedulerRecordsMissedWindowWithoutRunning(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b := new(bridge)
	socket, peers := fixture(t)
	go b.run(ctx, socket, "test", time.Millisecond)
	_ = acceptSession(t, peers, b)
	c := newConversation(b, t.TempDir(), nil)
	s := c.scheduler
	s.resolveCwd = func(input string) (string, error) { return input, nil }
	now := time.Date(2026, time.November, 19, 8, 0, 0, 0, time.UTC)
	s.clock = func() time.Time { return now }
	model, enabled, interval := "", true, int64(3600000)
	if _, err := s.mutate(scheduleMutation{Action: "create", Confirmed: true, RequestID: testSubmission, Task: &scheduleTask{Name: "Test", Prompt: "Test", Cwd: "/test", Model: &model, Sandbox: "read-only", IntervalMS: &interval, Enabled: &enabled, NextRunAt: scheduleDate(now.Add(time.Minute))}}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(3 * time.Minute)
	s.tick(b.current())
	state := scheduleFixtureState(t, s, "missed")
	if len(state.Runs) != 1 || state.Runs[0].ThreadID != nil || state.Jobs[0].NextRunAt != "2026-11-19T09:01:00.000Z" || !*state.Jobs[0].Enabled {
		t.Fatalf("missed schedule was not advanced safely: %+v", state)
	}
}
