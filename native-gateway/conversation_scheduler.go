package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf16"
)

const schedulerStateLimit = 2 << 20

type scheduleTask struct {
	Name       string  `json:"name"`
	Prompt     string  `json:"prompt"`
	Cwd        string  `json:"cwd"`
	Model      *string `json:"model"`
	Sandbox    string  `json:"sandbox"`
	IntervalMS *int64  `json:"intervalMs"`
	NextRunAt  string  `json:"nextRunAt"`
	Enabled    *bool   `json:"enabled"`
}

type scheduleJob struct {
	scheduleTask
	ID          string `json:"id"`
	CreationKey string `json:"creationKey,omitempty"`
	Revision    int    `json:"revision"`
	CreatedAt   string `json:"createdAt"`
}

type scheduleRun struct {
	ID              string             `json:"id"`
	JobID           string             `json:"jobId"`
	Name            string             `json:"name"`
	Status          string             `json:"status"`
	StartedAt       string             `json:"startedAt"`
	FinishedAt      *string            `json:"finishedAt"`
	ThreadID        *string            `json:"threadId"`
	TurnID          *string            `json:"turnId"`
	Trigger         string             `json:"trigger"`
	RequestID       *string            `json:"requestId"`
	Owner           *conversationOwner `json:"owner,omitempty"`
	CancelRequested bool               `json:"cancelRequested,omitempty"`
	InterruptSent   bool               `json:"interruptSent,omitempty"`
	Error           string             `json:"error,omitempty"`
}

type scheduleState struct {
	Format   int           `json:"format"`
	Revision int           `json:"revision"`
	Jobs     []scheduleJob `json:"jobs"`
	Runs     []scheduleRun `json:"runs"`
}

type scheduleMutation struct {
	Action    string        `json:"action"`
	Confirmed bool          `json:"confirmed"`
	ID        string        `json:"id"`
	Revision  int           `json:"revision"`
	RequestID string        `json:"requestId"`
	Task      *scheduleTask `json:"task"`
}

type scheduleEvent struct {
	conn   *nativeConn
	method string
	params deliveryTurnEvent
}

type conversationScheduler struct {
	c          *conversation
	directory  string
	owner      conversationOwner
	clock      func() time.Time
	resolveCwd func(string) (string, error)
	events     chan scheduleEvent
}

var scheduleRequestID = regexp.MustCompile(`^[a-zA-Z0-9-]{16,80}$`)
var scheduleConflict = conversationFailure("SCHEDULE_CONFLICT", "Schedule changed or already running. Reload before trying again.")

func newConversationScheduler(c *conversation) *conversationScheduler {
	return &conversationScheduler{c: c, directory: filepath.Join(c.privateRoot, "remote-web-scheduler"), owner: newConversationOwner(), clock: time.Now, events: make(chan scheduleEvent, 64)}
}

func scheduleDate(t time.Time) string      { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func scheduleParse(value string) time.Time { t, _ := time.Parse(time.RFC3339Nano, value); return t }
func scheduleString(value *string) string {
	if value != nil {
		return *value
	}
	return ""
}
func (r scheduleRun) active() bool {
	return r.Status == "starting" || r.Status == "running" || r.Status == "waiting" || r.Status == "stopping"
}

func (s *conversationScheduler) path() string { return filepath.Join(s.directory, "schedules.json") }

func (s *conversationScheduler) read() (scheduleState, error) {
	state := scheduleState{Format: 1, Jobs: []scheduleJob{}, Runs: []scheduleRun{}}
	data, err := readConversationPrivate(s.path(), schedulerStateLimit)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if json.Unmarshal(data, &state) != nil || state.Format != 1 || state.Jobs == nil || state.Runs == nil || len(state.Jobs) > 30 || len(state.Runs) > 200 {
		return state, conversationFailure("SCHEDULE_STATE_UNSAFE", "Invalid scheduler state")
	}
	for _, job := range state.Jobs {
		if job.IntervalMS == nil || job.Enabled == nil || job.Model == nil || !scheduleInterval(*job.IntervalMS) || scheduleParse(job.NextRunAt).IsZero() || (job.Sandbox != "read-only" && job.Sandbox != "workspace-write") {
			return state, conversationFailure("SCHEDULE_STATE_UNSAFE", "Invalid scheduler job")
		}
	}
	return state, nil
}

func (s *conversationScheduler) transaction(change func(*scheduleState) (bool, error)) error {
	release, err := lockConversation(s.directory, "write.lock", s.owner.Host, 5*time.Second)
	if err != nil {
		return err
	}
	defer release()
	state, err := s.read()
	if err != nil {
		return err
	}
	dirty, err := change(&state)
	if err != nil || !dirty {
		return err
	}
	state.Revision++
	extra := len(state.Runs) - 200
	state.Runs = slices.DeleteFunc(state.Runs, func(run scheduleRun) bool {
		if extra > 0 && !run.active() {
			extra--
			return true
		}
		return false
	})
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if len(data) > schedulerStateLimit || len(state.Runs) > 200 {
		return conversationFailure("SCHEDULE_STATE_FULL", "Scheduler storage limit reached")
	}
	return writeDesktopFile(s.path(), data)
}

func (s *conversationScheduler) public(state *scheduleState) json.RawMessage {
	jobs := append([]scheduleJob{}, state.Jobs...)
	for i := range jobs {
		jobs[i].CreationKey = ""
	}
	runs := append([]scheduleRun{}, state.Runs...)
	for i := range runs {
		runs[i].Owner = nil
	}
	zone := time.Local.String()
	if zone == "Local" {
		if path, err := os.Readlink("/etc/localtime"); err == nil {
			if _, name, ok := strings.Cut(path, "/zoneinfo/"); ok {
				zone = name
			}
		}
		if zone == "Local" {
			zone, _ = s.clock().Zone()
		}
	}
	return conversationObject(map[string]any{"jobs": jobs, "runs": runs, "serverTime": scheduleDate(s.clock()), "timezone": zone})
}

func scheduleInterval(interval int64) bool {
	return interval == 0 || interval == 3600000 || interval == 86400000 || interval == 604800000
}

func (s *conversationScheduler) validate(task *scheduleTask) (scheduleTask, error) {
	if task == nil || s.resolveCwd == nil || task.Model == nil || task.IntervalMS == nil || task.Enabled == nil || !scheduleInterval(*task.IntervalMS) || (task.Sandbox != "read-only" && task.Sandbox != "workspace-write") || len(utf16.Encode([]rune(*task.Model))) > 160 {
		return scheduleTask{}, conversationFailure("SCHEDULE_INVALID", "Unsupported schedule settings")
	}
	copy := *task
	copy.Name, copy.Prompt = strings.TrimSpace(task.Name), strings.TrimSpace(task.Prompt)
	if copy.Name == "" || copy.Prompt == "" || len(utf16.Encode([]rune(task.Name))) > 160 || len(task.Prompt) > 16000 || task.Cwd == "" {
		return scheduleTask{}, conversationFailure("SCHEDULE_INVALID", "Enter a task name, prompt and project")
	}
	var err error
	if copy.Cwd, err = s.resolveCwd(copy.Cwd); err != nil {
		return scheduleTask{}, err
	}
	now, at := s.clock(), scheduleParse(task.NextRunAt)
	if at.IsZero() || at.Before(now.Add(-time.Second)) || at.After(now.Add(366*24*time.Hour)) {
		return scheduleTask{}, conversationFailure("SCHEDULE_INVALID", "Choose a future start time")
	}
	copy.NextRunAt = scheduleDate(at)
	return copy, nil
}

func (s *conversationScheduler) disable(state *scheduleState, id string) {
	for i := range state.Jobs {
		if job := &state.Jobs[i]; job.ID == id {
			job.Revision++
			job.Enabled = new(bool)
			return
		}
	}
}

func (s *conversationScheduler) recover(state *scheduleState, own bool) bool {
	dirty := false
	for i := range state.Runs {
		run := &state.Runs[i]
		if !run.active() {
			continue
		}
		if own {
			if run.Owner == nil || run.Owner.Instance != s.owner.Instance {
				continue
			}
		} else if run.Owner != nil && run.Owner.alive(s.owner.Host) {
			continue
		}
		t := scheduleDate(s.clock())
		run.Status, run.FinishedAt, run.Error = "interrupted", &t, "The gateway stopped. This run was not replayed."
		s.disable(state, run.JobID)
		dirty = true
	}
	return dirty
}

func (s *conversationScheduler) reserve(state *scheduleState, job scheduleJob, trigger string, key *string) scheduleRun {
	run := scheduleRun{ID: uuidConversation(), JobID: job.ID, Name: job.Name, Status: "starting", StartedAt: scheduleDate(s.clock()), Trigger: trigger, RequestID: key, Owner: &s.owner}
	state.Runs = append(state.Runs, run)
	return run
}

func (s *conversationScheduler) mutate(input scheduleMutation) (json.RawMessage, error) {
	if !input.Confirmed {
		return nil, conversationFailure("SCHEDULE_INVALID", "Confirm a supported schedule change")
	}
	conn := s.c.bridge.current()
	if conn == nil && input.Action != "pause" && input.Action != "stop" && input.Action != "delete" {
		return nil, errDisconnected
	}
	var result json.RawMessage
	var launch, interrupt scheduleRun
	err := s.transaction(func(state *scheduleState) (bool, error) {
		dirty := s.recover(state, false)
		switch input.Action {
		case "create":
			if !scheduleRequestID.MatchString(input.RequestID) {
				return false, conversationFailure("SCHEDULE_INVALID", "Request identity required")
			}
			if slices.ContainsFunc(state.Jobs, func(job scheduleJob) bool { return job.CreationKey == input.RequestID }) {
				result = s.public(state)
				return dirty, nil
			}
			if len(state.Jobs) >= 30 {
				return false, conversationFailure("SCHEDULE_INVALID", "At most 30 schedules are supported")
			}
			task, err := s.validate(input.Task)
			if err != nil {
				return false, err
			}
			state.Jobs = append(state.Jobs, scheduleJob{scheduleTask: task, ID: uuidConversation(), CreationKey: input.RequestID, Revision: 1, CreatedAt: scheduleDate(s.clock())})
		case "stop":
			i := slices.IndexFunc(state.Runs, func(run scheduleRun) bool { return run.ID == input.ID && run.active() })
			if i < 0 {
				return false, scheduleConflict
			}
			run := &state.Runs[i]
			run.CancelRequested, run.Status = true, "stopping"
			if !run.InterruptSent && scheduleString(run.TurnID) != "" && run.Owner != nil && run.Owner.Instance == s.owner.Instance && conn != nil {
				run.InterruptSent = true
				interrupt = *run
			}
		case "run", "delete", "update", "pause", "resume":
			i := slices.IndexFunc(state.Jobs, func(job scheduleJob) bool { return job.ID == input.ID && job.Revision == input.Revision })
			if i < 0 {
				return false, scheduleConflict
			}
			job := &state.Jobs[i]
			switch input.Action {
			case "run":
				if !scheduleRequestID.MatchString(input.RequestID) {
					return false, conversationFailure("SCHEDULE_INVALID", "Request identity required")
				}
				if slices.ContainsFunc(state.Runs, func(run scheduleRun) bool { return scheduleString(run.RequestID) == input.RequestID }) {
					result = s.public(state)
					return dirty, nil
				}
				if slices.ContainsFunc(state.Runs, scheduleRun.active) {
					return false, scheduleConflict
				}
				launch = s.reserve(state, *job, "manual", &input.RequestID)
			case "delete", "update":
				if slices.ContainsFunc(state.Runs, func(run scheduleRun) bool { return run.JobID == job.ID && run.active() }) {
					return false, scheduleConflict
				}
				if input.Action == "delete" {
					state.Jobs = slices.Delete(state.Jobs, i, i+1)
				} else {
					task, err := s.validate(input.Task)
					if err != nil {
						return false, err
					}
					job.scheduleTask = task
					job.Revision++
				}
			default:
				enabled := input.Action == "resume"
				job.Enabled = &enabled
				if enabled && !scheduleParse(job.NextRunAt).After(s.clock()) {
					job.NextRunAt = scheduleDate(s.clock().Add(time.Minute))
				}
				job.Revision++
			}
		default:
			return false, conversationFailure("SCHEDULE_INVALID", "Confirm a supported schedule change")
		}
		result = s.public(state)
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	if launch.ID != "" {
		s.launchAsync(conn, launch.ID)
	}
	if interrupt.ID != "" {
		go s.interrupt(conn, interrupt)
	}
	return result, nil
}

func (s *conversationScheduler) update(id string, change func(*scheduleRun, *scheduleState)) (result scheduleRun, err error) {
	err = s.transaction(func(state *scheduleState) (bool, error) {
		for i := range state.Runs {
			run := &state.Runs[i]
			if run.ID == id && run.active() && run.Owner != nil && run.Owner.Instance == s.owner.Instance {
				change(run, state)
				result = *run
				return true, nil
			}
		}
		return false, nil
	})
	return
}

func (s *conversationScheduler) launchAsync(conn *nativeConn, id string) {
	go s.launch(conn, id)
}

func (s *conversationScheduler) launch(conn *nativeConn, id string) {
	if err := s.launchRun(conn, id); err != nil {
		_, _ = s.update(id, func(run *scheduleRun, state *scheduleState) {
			t := scheduleDate(s.clock())
			run.Status, run.FinishedAt, run.Error = "interrupted", &t, "Execution could not be confirmed. This run was not retried."
			s.disable(state, run.JobID)
		})
	}
}

func (s *conversationScheduler) launchRun(conn *nativeConn, id string) error {
	state, err := s.read()
	if err != nil {
		return err
	}
	i := slices.IndexFunc(state.Runs, func(run scheduleRun) bool {
		return run.ID == id && run.active() && run.Owner != nil && run.Owner.Instance == s.owner.Instance
	})
	if i < 0 {
		return nil
	}
	run := state.Runs[i]
	j := slices.IndexFunc(state.Jobs, func(job scheduleJob) bool { return job.ID == run.JobID })
	if j < 0 || conn == nil || conn != s.c.bridge.current() || s.resolveCwd == nil {
		return errDisconnected
	}
	job := state.Jobs[j]
	cwd, err := s.resolveCwd(job.Cwd)
	if err != nil {
		return err
	}
	params := map[string]any{"cwd": cwd, "sandbox": job.Sandbox, "approvalPolicy": "on-request"}
	if model := scheduleString(job.Model); model != "" {
		params["model"] = model
	}
	ctx := context.Background()
	started, err := sideChatRequest(ctx, conn, "thread/start", params)
	if err != nil {
		return err
	}
	thread := liveString(liveObject(started["thread"])["id"])
	if thread == "" {
		return conversationFailure("SCHEDULE_INVALID", "Missing thread")
	}
	run, err = s.update(id, func(run *scheduleRun, _ *scheduleState) {
		run.ThreadID = &thread
		if run.CancelRequested {
			t := scheduleDate(s.clock())
			run.Status, run.FinishedAt = "interrupted", &t
		}
	})
	if err != nil || run.ID == "" || run.CancelRequested {
		return err
	}
	if conn != s.c.bridge.current() {
		return errDisconnected
	}
	started, err = sideChatRequest(ctx, conn, "turn/start", map[string]any{"threadId": thread, "input": []any{map[string]any{"type": "text", "text": job.Prompt, "text_elements": []any{}}}})
	if err != nil {
		return err
	}
	turn := liveString(liveObject(started["turn"])["id"])
	if turn == "" {
		return conversationFailure("SCHEDULE_INVALID", "Missing turn")
	}
	run, err = s.update(id, func(run *scheduleRun, _ *scheduleState) {
		run.TurnID = &turn
		if run.CancelRequested {
			run.Status, run.InterruptSent = "stopping", true
		} else if run.Status != "waiting" {
			run.Status = "running"
		}
	})
	if err == nil && run.CancelRequested {
		s.interrupt(conn, run)
	}
	return err
}

func (s *conversationScheduler) interrupt(conn *nativeConn, run scheduleRun) {
	_, err := sideChatRequest(context.Background(), conn, "turn/interrupt", map[string]any{"threadId": scheduleString(run.ThreadID), "turnId": scheduleString(run.TurnID)})
	if err != nil {
		_, _ = s.update(run.ID, func(run *scheduleRun, _ *scheduleState) {
			run.InterruptSent = false
			run.Error = "The stop request could not be confirmed. Retrying while connected."
		})
	}
}

func (s *conversationScheduler) tick(conn *nativeConn) {
	if conn == nil || conn != s.c.bridge.current() {
		return
	}
	if _, err := os.Lstat(s.path()); err != nil {
		return
	}
	var launch scheduleRun
	var interrupts []scheduleRun
	if err := s.transaction(func(state *scheduleState) (bool, error) {
		dirty := s.recover(state, false)
		for i := range state.Runs {
			run := &state.Runs[i]
			if run.active() && run.CancelRequested && scheduleString(run.TurnID) != "" && run.Owner != nil && run.Owner.Instance == s.owner.Instance && !run.InterruptSent {
				run.InterruptSent = true
				interrupts = append(interrupts, *run)
				dirty = true
			}
		}
		now := s.clock()
		for i := range state.Jobs {
			job := &state.Jobs[i]
			at := scheduleParse(job.NextRunAt)
			if !*job.Enabled || at.After(now) {
				continue
			}
			if now.Sub(at) > time.Minute {
				finished := scheduleDate(now)
				state.Runs = append(state.Runs, scheduleRun{ID: uuidConversation(), JobID: job.ID, Name: job.Name, Status: "missed", StartedAt: job.NextRunAt, FinishedAt: &finished, Trigger: "scheduled", Error: "The scheduled time passed while execution was unavailable."})
			} else if !slices.ContainsFunc(state.Runs, scheduleRun.active) {
				launch = s.reserve(state, *job, "scheduled", nil)
			} else {
				continue
			}
			if *job.IntervalMS == 0 {
				job.Enabled = new(bool)
			} else {
				interval := time.Duration(*job.IntervalMS) * time.Millisecond
				job.NextRunAt = scheduleDate(at.Add((now.Sub(at)/interval + 1) * interval))
			}
			job.Revision++
			dirty = true
		}
		return dirty, nil
	}); err != nil {
		return
	}
	for _, run := range interrupts {
		go s.interrupt(conn, run)
	}
	if launch.ID != "" {
		s.launchAsync(conn, launch.ID)
	}
}

func (s *conversationScheduler) observe(conn *nativeConn, method string, raw json.RawMessage) {
	switch method {
	case "turn/completed", "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput":
	default:
		return
	}
	var params deliveryTurnEvent
	if json.Unmarshal(raw, &params) != nil || params.ThreadID == "" {
		return
	}
	select {
	case s.events <- scheduleEvent{conn: conn, method: method, params: params}:
	default:
		conn.close()
	}
}

func (s *conversationScheduler) process(event scheduleEvent) {
	if event.conn != s.c.bridge.current() {
		return
	}
	if _, err := os.Lstat(s.path()); err != nil {
		return
	}
	_ = s.transaction(func(state *scheduleState) (bool, error) {
		for i := range state.Runs {
			run := &state.Runs[i]
			if !run.active() || run.Owner == nil || run.Owner.Instance != s.owner.Instance || scheduleString(run.ThreadID) != event.params.ThreadID {
				continue
			}
			if event.method == "turn/completed" {
				if run.TurnID != nil && *run.TurnID != event.params.Turn.ID {
					continue
				}
				status := event.params.Turn.Status
				if status != "completed" && status != "failed" {
					status = "interrupted"
				}
				t := scheduleDate(s.clock())
				run.Status, run.FinishedAt = status, &t
				if run.TurnID == nil && event.params.Turn.ID != "" {
					run.TurnID = &event.params.Turn.ID
				}
			} else if run.Status != "stopping" {
				run.Status = "waiting"
			}
			return true, nil
		}
		return false, nil
	})
}

func (s *conversationScheduler) interrupted() {
	if _, err := os.Lstat(s.path()); err == nil {
		_ = s.transaction(func(state *scheduleState) (bool, error) { return s.recover(state, true), nil })
	}
}

func (s *conversationScheduler) run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	defer s.interrupted()
	var previous *nativeConn
	var lastTick time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case event := <-s.events:
			s.process(event)
		case <-ticker.C:
			conn := s.c.bridge.current()
			if conn != previous {
				if previous != nil {
					s.interrupted()
				}
				previous, lastTick = conn, time.Time{}
			}
			if conn != nil && time.Since(lastTick) >= 10*time.Second {
				lastTick = time.Now()
				s.tick(conn)
			}
		}
	}
}

func (s *conversationScheduler) register(mux *http.ServeMux, canMutate func(*http.Request) bool, resolveCwd func(string) (string, error)) {
	s.resolveCwd = resolveCwd
	mux.HandleFunc("/api/schedules", func(w http.ResponseWriter, r *http.Request) {
		var result json.RawMessage
		var err error
		switch r.Method {
		case "GET":
			var state scheduleState
			state, err = s.read()
			if err == nil {
				result = s.public(&state)
			}
		case "POST":
			if !canMutate(r) {
				jsonReply(w, 403, map[string]string{"error": "A same-origin workspace request is required."})
				return
			}
			var input scheduleMutation
			if err = conversationDecode(r, w, 65536, &input); err == nil {
				result, err = s.mutate(input)
			}
		default:
			w.Header().Set("Allow", "GET, POST")
			jsonReply(w, 405, map[string]string{"error": "Method not allowed"})
			return
		}
		if err == nil {
			jsonReply(w, 200, result)
			return
		}
		status, text := 400, "Unable to save this schedule. Check the project, time, permissions and Codex connection."
		if errors.Is(err, scheduleConflict) {
			status, text = 409, scheduleConflict.Error()
		} else if r.Method == "GET" {
			text = "Unable to load schedules. Check the server connection and scheduler storage permissions."
		}
		jsonReply(w, status, map[string]string{"error": text})
	})
}
