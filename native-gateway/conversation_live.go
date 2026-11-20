package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

type conversationLiveStore struct {
	mu      sync.Mutex
	entries map[string]*liveRollout
}

type liveRollout struct {
	file          os.FileInfo
	offset        int64
	active        bool
	turn          map[string]any
	items         []map[string]any
	indexes       map[string]int
	commands      map[string]string
	activeCommand string
	lastEvent     any
	userSeq       int
	patchSeq      int
	itemBytes     int
}

func newConversationLiveStore() *conversationLiveStore {
	return &conversationLiveStore{entries: make(map[string]*liveRollout)}
}

func liveText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	var text []string
	for _, value := range liveList(value) {
		part := liveObject(value)
		for _, key := range []string{"text", "input_text", "output_text"} {
			if s := liveString(part[key]); s != "" {
				text = append(text, s)
				break
			}
		}
	}
	return strings.Join(text, "\n")
}

func liveString(value any) string         { text, _ := value.(string); return text }
func liveObject(value any) map[string]any { out, _ := value.(map[string]any); return out }
func liveList(value any) []any            { out, _ := value.([]any); return out }

func (state *liveRollout) upsert(item map[string]any) {
	id := liveString(item["id"])
	if id == "" || state.turn == nil {
		return
	}
	if index, existed := state.indexes[id]; existed {
		old := state.items[index]
		next := maps.Clone(old)
		maps.Copy(next, item)
		if size := state.itemBytes + len(conversationObject(next)) - len(conversationObject(old)); size <= 8<<20 {
			state.itemBytes = size
			state.items[index] = next
		}
	} else if len(state.items) < 2000 {
		if size := state.itemBytes + len(conversationObject(item)); size <= 8<<20 {
			state.itemBytes = size
			state.indexes[id] = len(state.items)
			state.items = append(state.items, item)
		}
	}
}

var liveCommandProperty = regexp.MustCompile(`(?:^|[,\s{])cmd\s*:\s*("(?:\\.|[^"\\])*")`)

func liveCommand(input string) string {
	if !strings.Contains(input, "tools.exec_command") {
		return ""
	}
	match := liveCommandProperty.FindStringSubmatch(input)
	var command string
	if len(match) == 2 {
		_ = json.Unmarshal([]byte(match[1]), &command)
	}
	return command
}

func (state *liveRollout) finishCommand(value any) {
	index, exists := state.indexes[state.activeCommand]
	if !exists {
		return
	}
	text := liveText(value)
	status := "completed"
	lower := strings.ToLower(text)
	if strings.Contains(lower, "script running with") {
		status = "inProgress"
	} else if strings.Contains(lower, "script failed") || strings.Contains(lower, "script error") {
		status = "failed"
	}
	item := maps.Clone(state.items[index])
	for line := range strings.SplitSeq(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "{") {
			var payload struct {
				ExitCode *int `json:"exit_code"`
			}
			if json.Unmarshal([]byte(line), &payload) == nil && payload.ExitCode != nil {
				item["exitCode"] = *payload.ExitCode
				if *payload.ExitCode != 0 {
					status = "failed"
				}
			}
		}
	}
	if where := strings.LastIndex(text, "\nOutput:\n"); where >= 0 {
		item["aggregatedOutput"] = text[where+9:]
	}
	item["status"] = status
	state.upsert(item)
	if status != "inProgress" {
		state.activeCommand = ""
	}
}

func liveChangeDiff(change map[string]any) string {
	if diff := liveString(change["unified_diff"]); diff != "" {
		return diff
	}
	content, ok := change["content"].(string)
	if !ok {
		return ""
	}
	lines := strings.Split(strings.TrimSuffix(strings.ReplaceAll(content, "\r\n", "\n"), "\n"), "\n")
	if content == "" {
		lines = nil
	}
	var head, prefix string
	switch change["type"] {
	case "add":
		head, prefix = fmt.Sprintf("@@ -0,0 +1,%d @@", len(lines)), "+"
	case "delete":
		head, prefix = fmt.Sprintf("@@ -1,%d +0,0 @@", len(lines)), "-"
	default:
		return ""
	}
	if len(lines) == 0 {
		return head + "\n"
	}
	return head + "\n" + prefix + strings.Join(lines, "\n"+prefix) + "\n"
}

func (state *liveRollout) apply(data []byte) {
	var row struct {
		Type      string         `json:"type"`
		Timestamp string         `json:"timestamp"`
		Payload   map[string]any `json:"payload"`
	}
	if json.Unmarshal(data, &row) != nil {
		return
	}
	if row.Timestamp != "" {
		state.lastEvent = row.Timestamp
	}
	p := row.Payload
	kind, turnID := liveString(p["type"]), liveString(p["turn_id"])
	if row.Type == "event_msg" && kind == "task_started" {
		state.active, state.items, state.indexes, state.commands = true, []map[string]any{}, make(map[string]int), make(map[string]string)
		state.activeCommand, state.userSeq, state.patchSeq, state.itemBytes = "", 0, 0, 0
		state.turn = map[string]any{"id": turnID, "status": "inProgress", "itemsView": "full"}
		if started, ok := p["started_at"].(float64); ok {
			state.turn["startedAt"] = started
		}
		return
	}
	if state.turn == nil || !state.active {
		return
	}
	if row.Type == "event_msg" {
		switch kind {
		case "task_complete":
			if turnID == state.turn["id"] {
				state.active, state.turn, state.items, state.indexes, state.commands = false, nil, nil, nil, nil
			}
		case "user_message":
			state.userSeq++
			if text := strings.TrimSpace(liveString(p["message"])); state.userSeq > 1 && text != "" {
				state.upsert(map[string]any{"id": fmt.Sprintf("host-user-%s-%d", state.turn["id"], state.userSeq), "type": "userMessage", "content": []map[string]string{{"type": "text", "text": text}}, "status": "completed"})
			}
		case "patch_apply_end":
			if turnID != "" && turnID != state.turn["id"] {
				return
			}
			changes := []map[string]any{}
			for path, raw := range liveObject(p["changes"]) {
				change := liveObject(raw)
				typ := liveString(change["type"])
				if typ == "" {
					typ = "update"
				}
				changes = append(changes, map[string]any{"path": path, "kind": map[string]any{"type": typ, "move_path": change["move_path"]}, "diff": liveChangeDiff(change)})
			}
			if len(changes) == 0 {
				return
			}
			status := liveString(p["status"])
			if p["success"] == false {
				status = "failed"
			} else if status == "" {
				status = "completed"
			}
			output := liveString(p["stderr"])
			if output == "" {
				output = liveString(p["stdout"])
			}
			state.patchSeq++
			state.upsert(map[string]any{"id": fmt.Sprintf("host-patch-%s-%d", state.turn["id"], state.patchSeq), "type": "fileChange", "status": status, "changes": changes, "aggregatedOutput": output})
		}
		return
	}
	if row.Type != "response_item" {
		return
	}
	id, call := liveString(p["id"]), liveString(p["call_id"])
	switch kind {
	case "message":
		text := liveText(p["content"])
		if p["role"] != "assistant" || text == "" {
			return
		}
		if id == "" {
			id = fmt.Sprintf("host-message-%d", state.offset)
		}
		phase := liveString(p["phase"])
		if phase == "" {
			phase = "final_answer"
		}
		state.upsert(map[string]any{"id": id, "type": "agentMessage", "text": text, "phase": phase})
	case "reasoning":
		if text := liveText(p["summary"]); text != "" {
			if id == "" {
				id = fmt.Sprintf("host-reasoning-%d", state.offset)
			}
			state.upsert(map[string]any{"id": id, "type": "reasoning", "summary": []string{text}, "status": "completed"})
		}
	case "custom_tool_call":
		if command := liveCommand(liveString(p["input"])); command != "" {
			if id == "" {
				id = call
			}
			if call != "" {
				state.commands[call] = id
			}
			state.activeCommand = id
			state.upsert(map[string]any{"id": id, "type": "commandExecution", "command": command, "status": "inProgress", "aggregatedOutput": ""})
		}
	case "custom_tool_call_output", "function_call_output":
		if command := state.commands[call]; command != "" {
			state.activeCommand = command
		}
		state.finishCommand(p["output"])
	}
}

func (s *conversationLiveStore) read(rootPath, path string) (json.RawMessage, error) {
	rootPath = filepath.Clean(rootPath)
	path = filepath.Clean(path)
	canonicalRoot := workspaceCanonical(rootPath)
	if workspaceWithin(path, rootPath) {
		if rel, err := filepath.Rel(rootPath, path); err == nil {
			path = filepath.Join(canonicalRoot, rel)
		}
	}
	if !filepath.IsAbs(path) || !workspaceWithin(path, canonicalRoot) || filepath.Ext(path) != ".jsonl" {
		return nil, conversationFailure("INVALID_REQUEST", "Thread rollout is outside the Codex sessions directory")
	}
	parent, err := workspaceOpenDirectory(canonicalRoot, filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	file, err := parent.OpenFile(filepath.Base(path), os.O_RDONLY|noFollow|noBlock, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !fileOwned(file, info, 0) {
		return nil, conversationFailure("INVALID_REQUEST", "Unsafe thread rollout")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := s.entries[path]
	if entry == nil || !os.SameFile(entry.file, info) || entry.offset > info.Size() {
		if len(s.entries) >= 8 {
			clear(s.entries)
		}
		entry = &liveRollout{file: info}
		s.entries[path] = entry
	}
	const window = 16 << 20
	if info.Size()-entry.offset > window {
		entry = &liveRollout{file: info, offset: info.Size() - window}
		s.entries[path] = entry
	}
	if _, err := file.Seek(entry.offset, io.SeekStart); err != nil {
		return nil, err
	}
	reader := bufio.NewReaderSize(io.LimitReader(file, info.Size()-entry.offset), 64<<10)
	var line bytes.Buffer
	oversized := false
	var consumed int64
	for {
		chunk, err := reader.ReadSlice('\n')
		consumed += int64(len(chunk))
		if line.Len()+len(chunk) <= 2<<20 && !oversized {
			line.Write(chunk)
		} else {
			oversized = true
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		entry.offset += consumed
		if !oversized {
			entry.apply(line.Bytes())
		}
		line.Reset()
		oversized, consumed = false, 0
	}
	if entry.active {
		entry.turn["items"] = entry.items
	}
	return marshalConversation(map[string]any{"active": entry.active, "turn": entry.turn, "lastEventAt": entry.lastEvent})
}

func (c *conversation) liveRPC(ctx context.Context, params json.RawMessage) (json.RawMessage, error) {
	var input struct {
		ThreadID string `json:"threadId"`
	}
	if c.live == nil || json.Unmarshal(params, &input) != nil || !conversationID(input.ThreadID) {
		return nil, conversationFailure("INVALID_REQUEST", "Invalid thread ID")
	}
	result, err := c.request(ctx, "thread/read", conversationObject(map[string]any{"threadId": input.ThreadID, "includeTurns": false}))
	if err != nil {
		return nil, err
	}
	var state struct{ Thread struct{ Path string } }
	if json.Unmarshal(result, &state) != nil || state.Thread.Path == "" {
		return marshalConversation(map[string]any{"active": false, "turn": nil, "lastEventAt": nil})
	}
	return c.live.read(filepath.Join(c.privateRoot, "sessions"), state.Thread.Path)
}
