package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type reviewChange struct {
	Path, FilePath, Diff string
	UnifiedDiff          string `json:"unified_diff"`
	Kind                 json.RawMessage
}

type reviewItem struct {
	Type    string
	Changes []reviewChange
}
type reviewTurn struct {
	ID    string
	Items []reviewItem
}
type reviewKey struct{ thread, turn string }
type reviewEntry struct {
	diff         string
	undone, busy bool
	stamp        uint64
}
type reviewService struct {
	mu      sync.Mutex
	entries map[reviewKey]*reviewEntry
	stamp   uint64
	bridge  *bridge
	root    string
	enabled bool
}

const reviewDiffLimit = 2_000_000

var reviewMode = regexp.MustCompile(`(?m)^(?:(?:(?:new|old|deleted) file )?mode |index [0-9a-f]+\.\.[0-9a-f]+ )(\d+)\r?$`)
var reviewMove = regexp.MustCompile(`(?m)^(?:rename|copy) (?:from|to) `)
var reviewGitHeader = regexp.MustCompile(`(?m)^diff --git `)
var reviewOldHeader = regexp.MustCompile(`(?m)^--- `)
var reviewNewHeader = regexp.MustCompile(`(?m)^\+\+\+ `)

func reviewUnified(changes []reviewChange) string {
	var sections []string
	var size int
	for _, change := range changes {
		path := workspaceDefault(change.Path, change.FilePath)
		diff := strings.TrimRight(workspaceDefault(change.Diff, change.UnifiedDiff), " \t\r\n")
		if path == "" || diff == "" || strings.ContainsAny(path, "\r\n\x00") {
			continue
		}
		if !reviewGitHeader.MatchString(diff) {
			var kind string
			if json.Unmarshal(change.Kind, &kind) != nil {
				var obj struct{ Type string }
				_ = json.Unmarshal(change.Kind, &obj)
				kind = obj.Type
			}
			before, after := "a/"+path, "b/"+path
			if kind == "add" {
				before = "/dev/null"
			}
			if kind == "delete" {
				after = "/dev/null"
			}
			if !reviewOldHeader.MatchString(diff) || !reviewNewHeader.MatchString(diff) {
				diff = "--- " + before + "\n+++ " + after + "\n" + diff
			}
			diff = "diff --git a/" + path + " b/" + path + "\n" + diff
		}
		size += len(diff) + 1
		if size > reviewDiffLimit {
			return ""
		}
		sections = append(sections, diff)
	}
	return strings.Join(sections, "\n")
}

func (s *reviewService) record(thread, turn, diff string) {
	if !s.enabled || thread == "" || turn == "" || len(thread) > 1024 || len(turn) > 1024 || diff == "" || len(diff) > reviewDiffLimit {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stamp++
	key := reviewKey{thread, turn}
	if e := s.entries[key]; e != nil && (e.diff == diff || e.busy) {
		e.stamp = s.stamp
		return
	}
	if s.entries == nil {
		s.entries = make(map[reviewKey]*reviewEntry)
	}
	if len(s.entries) >= 100 && s.entries[key] == nil {
		var oldest reviewKey
		var stamp uint64
		for k, e := range s.entries {
			if !e.busy && (stamp == 0 || e.stamp < stamp) {
				oldest, stamp = k, e.stamp
			}
		}
		if stamp == 0 {
			return
		}
		delete(s.entries, oldest)
	}
	s.entries[key] = &reviewEntry{diff: diff, stamp: s.stamp}
}

func (s *reviewService) clear() { s.mu.Lock(); clear(s.entries); s.mu.Unlock() }

func (s *reviewService) observe(raw json.RawMessage) {
	if !s.enabled {
		return
	}
	var msg struct {
		Method string
		ID     json.RawMessage
		Params struct {
			ThreadID, TurnID, Diff string
			Changes                []reviewChange
			Item                   reviewItem
		}
	}
	if json.Unmarshal(raw, &msg) != nil || len(msg.ID) != 0 {
		return
	}
	p := msg.Params
	switch msg.Method {
	case "turn/diff/updated":
		s.record(p.ThreadID, p.TurnID, p.Diff)
	case "item/fileChange/patchUpdated":
		s.record(p.ThreadID, p.TurnID, reviewUnified(p.Changes))
	case "item/completed":
		if p.Item.Type == "fileChange" {
			s.record(p.ThreadID, p.TurnID, reviewUnified(p.Item.Changes))
		}
	}
}

func (s *reviewService) observeReply(method string, params, data json.RawMessage) {
	if !s.enabled || (method != "thread/read" && method != "thread/resume" && method != "thread/turns/list") {
		return
	}
	var r struct {
		Thread struct {
			ID    string
			Turns []reviewTurn
		}
		Data []reviewTurn
	}
	if json.Unmarshal(data, &r) != nil {
		return
	}
	if r.Thread.ID == "" {
		var p struct{ ThreadID string }
		_ = json.Unmarshal(params, &p)
		r.Thread.ID = p.ThreadID
	}
	turns := r.Thread.Turns
	if turns == nil {
		turns = r.Data
	}
	for _, turn := range turns {
		var changes []reviewChange
		for _, item := range turn.Items {
			if item.Type == "fileChange" {
				changes = append(changes, item.Changes...)
			}
		}
		s.record(r.Thread.ID, turn.ID, reviewUnified(changes))
	}
}

func reviewApply(ctx context.Context, root, cwd, diff, action string) (string, error) {
	if len(diff) > reviewDiffLimit || strings.TrimSpace(diff) == "" {
		return "", errors.New("Missing unified diff")
	}
	for _, match := range reviewMode.FindAllStringSubmatch(diff, -1) {
		if match[1] != "100644" && match[1] != "100755" {
			return "", errors.New("Unsupported review file mode")
		}
	}
	if strings.Contains(diff, "\x00") || reviewMove.MatchString(diff) {
		return "", errors.New("Unsupported review diff")
	}
	dir, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return "", err
	}
	allowed, err := filepath.EvalSymlinks(root)
	if err != nil || !workspaceWithin(dir, allowed) {
		return "", errors.New("Review project outside allowed roots")
	}
	// Avoid Git environment overrides that could redirect patch application.
	env := make([]string, 0, len(os.Environ()))
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "GIT_") {
			env = append(env, value)
		}
	}
	git := func(input string, args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Env, cmd.Dir = env, dir
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.Output()
		return string(out), err
	}
	location, err := git("", "rev-parse", "--show-toplevel")
	if err != nil {
		return "", errors.New("Directory is not a Git repository")
	}
	real, err := filepath.EvalSymlinks(strings.TrimSpace(location))
	if err != nil || real != dir {
		return "", errors.New("Review patch cwd must be the Git repository root")
	}
	paths, err := git(diff, "apply", "--numstat", "-z")
	if err != nil || paths == "" {
		return "", errors.New("Review diff contains no valid file paths")
	}
	for _, line := range strings.Split(strings.TrimSuffix(paths, "\x00"), "\x00") {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 || !filepath.IsLocal(parts[2]) || strings.Contains(parts[2], "\\") {
			return "", errors.New("Review diff contains an unsafe path")
		}
		current := dir
		for _, part := range strings.Split(parts[2], "/") {
			lower := strings.ToLower(part)
			if part == "" || part == "." || part == ".." || strings.HasPrefix(lower, ".git") || lower == "node_modules" || lower == ".env" || strings.HasPrefix(lower, ".env.") {
				return "", errors.New("Review diff targets a protected path")
			}
			current = filepath.Join(current, part)
			info, err := os.Lstat(current)
			if err == nil && info.Mode()&os.ModeSymlink != 0 {
				return "", errors.New("Review diff may not modify a symbolic link")
			}
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return "", err
			}
		}
	}
	args := []string{"apply", "--whitespace=nowarn"}
	if action == "undo" {
		args = append(args, "--reverse")
	}
	if _, err := git(diff, append(append([]string{}, args...), "--check")...); err != nil {
		return "", errors.New("Review diff no longer applies to this repository")
	}
	if _, err := git(diff, args...); err != nil {
		return "", errors.New("Git could not apply the review diff")
	}
	return dir, nil
}

func (s *reviewService) register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/review/patch", func(w http.ResponseWriter, r *http.Request) {
		if !s.enabled {
			setupError(w, 403, "Review writes are disabled by the server")
			return
		}
		contentType, _, parseErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if parseErr != nil || contentType != "application/json" {
			setupError(w, 403, "A same-origin workspace request is required.")
			return
		}
		var input struct{ ThreadID, TurnID, Action string }
		var raw map[string]json.RawMessage
		if decodeOne(http.MaxBytesReader(w, r.Body, 8192), &raw) != nil {
			setupError(w, 400, "Missing review patch parameters")
			return
		}
		for key, value := range raw {
			var target *string
			switch key {
			case "threadId":
				target = &input.ThreadID
			case "turnId":
				target = &input.TurnID
			case "action":
				target = &input.Action
			default:
				setupError(w, 400, "Client-supplied patch data is not allowed")
				return
			}
			if json.Unmarshal(value, target) != nil {
				setupError(w, 400, "Invalid review patch parameters")
				return
			}
		}
		if input.ThreadID == "" || input.TurnID == "" || len(input.ThreadID) > 256 || len(input.TurnID) > 256 || (input.Action != "undo" && input.Action != "reapply") {
			setupError(w, 400, "Missing review patch parameters")
			return
		}
		key := reviewKey{input.ThreadID, input.TurnID}
		s.mu.Lock()
		entry := s.entries[key]
		if entry == nil || entry.busy || entry.undone != (input.Action == "reapply") {
			s.mu.Unlock()
			setupError(w, 400, "Review diff is unavailable or already in progress")
			return
		}
		entry.busy = true
		s.mu.Unlock()
		success := false
		defer func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			entry.busy = false
			if success {
				entry.undone = input.Action == "undo"
			}
		}()
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		payload, _ := json.Marshal(map[string]any{"threadId": input.ThreadID, "includeTurns": false})
		conn := s.bridge.current()
		if conn == nil {
			setupError(w, 400, "Codex App Server is disconnected")
			return
		}
		response, err := conn.request(ctx, "thread/read", payload)
		var result struct{ Thread struct{ Cwd string } }
		if err != nil || json.Unmarshal(response, &result) != nil || !filepath.IsAbs(result.Thread.Cwd) || s.bridge.current() != conn {
			setupError(w, 400, "Thread working directory is unavailable")
			return
		}
		root, err := reviewApply(ctx, s.root, result.Thread.Cwd, entry.diff, input.Action)
		if err != nil {
			setupError(w, 400, fmt.Sprint(err))
			return
		}
		success = true
		jsonReply(w, 200, map[string]any{"ok": true, "action": input.Action, "root": root})
	})
}
