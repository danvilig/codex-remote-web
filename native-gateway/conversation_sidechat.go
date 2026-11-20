package main

import (
	"context"
	"encoding/json"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"
)

const sideChatTTL = 10 * time.Minute
const sideChatLimit = 8 << 20

type sideChatInput struct {
	Action         string `json:"action"`
	SessionID      string `json:"sessionId"`
	SourceThreadID string `json:"sourceThreadId"`
	Cwd            string `json:"cwd"`
	TurnID         string `json:"turnId"`
}

type conversationSideChats struct {
	c          *conversation
	resolveCwd func(string) (string, error)
	mu         sync.Mutex
	sessions   map[string]*sideChatSession
}

type sideChatSession struct {
	conn                            *nativeConn
	seen                            time.Time
	thread                          map[string]any
	turns                           []map[string]any
	indices                         map[string]int
	bytes                           int
	overflow, closed                bool
	creating, submitting, promoting chan struct{}
	source                          map[string]any
	sourceItems                     []map[string]any
	sourceHasBoundary               bool
	saveTarget                      map[string]any
	saveUncertain                   bool
	promoted                        bool
}

var sideChatExpired = conversationFailure("SIDE_CHAT_UNAVAILABLE", "Side chat is unavailable or busy")

func newConversationSideChats(c *conversation) *conversationSideChats {
	return &conversationSideChats{c: c, sessions: make(map[string]*sideChatSession)}
}

func (session *sideChatSession) activeTurn() string {
	for _, turn := range session.turns {
		if turn["status"] == "inProgress" {
			return liveString(turn["id"])
		}
	}
	return ""
}

func (session *sideChatSession) snapshot() json.RawMessage {
	return conversationObject(map[string]any{"thread": session.thread, "turns": session.turns, "activeTurnId": session.activeTurn(), "overflow": session.overflow})
}

func (session *sideChatSession) record(turn map[string]any) {
	id := liveString(turn["id"])
	if !conversationID(id) {
		return
	}
	index, existed := session.indices[id]
	next := maps.Clone(turn)
	previousBytes := 0
	if existed {
		old := session.turns[index]
		next = maps.Clone(old)
		maps.Copy(next, turn)
		if len(liveList(turn["items"])) == 0 {
			next["items"] = old["items"]
		}
		previousBytes = len(conversationObject(old))
	}
	if liveList(next["items"]) == nil {
		next["items"] = []any{}
	}
	newBytes := session.bytes + len(conversationObject(next)) - previousBytes
	if newBytes > sideChatLimit || (!existed && len(session.turns) >= 200) {
		session.overflow = true
		if existed {
			session.turns[index]["status"] = next["status"]
		}
		return
	}
	session.bytes = newBytes
	if existed {
		session.turns[index] = next
	} else {
		session.indices[id] = len(session.turns)
		session.turns = append(session.turns, next)
	}
}

func (s *conversationSideChats) notify(conn *nativeConn, method string, raw json.RawMessage) {
	if method != "thread/closed" && method != "turn/started" && method != "turn/completed" && method != "item/started" && method != "item/completed" && method != "item/agentMessage/delta" {
		return
	}
	var params map[string]any
	if json.Unmarshal(raw, &params) != nil || liveString(params["threadId"]) == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, session := range s.sessions {
		if session.conn != conn || session.thread["id"] != params["threadId"] || session.closed {
			continue
		}
		switch method {
		case "thread/closed":
			session.closed = true
		case "turn/started", "turn/completed":
			session.record(liveObject(params["turn"]))
		default:
			id := liveString(params["turnId"])
			if !conversationID(id) {
				return
			}
			turn := map[string]any{"id": id, "status": "inProgress"}
			if i, ok := session.indices[id]; ok {
				turn = maps.Clone(session.turns[i])
			}
			items := liveList(turn["items"])
			next := make([]any, 0, len(items)+1)
			item := liveObject(params["item"])
			itemID := liveString(item["id"])
			if method == "item/agentMessage/delta" {
				itemID = liveString(params["itemId"])
				item = map[string]any{"id": itemID, "type": "agentMessage", "phase": "final_answer"}
				for _, raw := range items {
					if old := liveObject(raw); old["id"] == itemID {
						item = maps.Clone(old)
						break
					}
				}
				item["text"] = liveString(item["text"]) + liveString(params["delta"])
			}
			if !conversationID(itemID) {
				return
			}
			for _, raw := range items {
				oldID := liveString(liveObject(raw)["id"])
				if oldID != itemID && !(item["type"] == "userMessage" && strings.HasPrefix(oldID, "side-input:")) {
					next = append(next, raw)
				}
			}
			turn["items"] = append(next, item)
			session.record(turn)
		}
		return
	}
}

func (s *conversationSideChats) turn(ctx context.Context, method string, raw json.RawMessage) (json.RawMessage, bool, error) {
	var params map[string]any
	if json.Unmarshal(raw, &params) != nil || liveString(params["threadId"]) == "" {
		return nil, false, nil
	}
	s.mu.Lock()
	var session *sideChatSession
	for _, candidate := range s.sessions {
		if candidate.thread["id"] == params["threadId"] {
			session = candidate
			break
		}
	}
	if session == nil {
		s.mu.Unlock()
		return nil, false, nil
	}
	if session.conn != s.c.bridge.current() || session.closed || time.Since(session.seen) > sideChatTTL || session.submitting != nil || session.promoting != nil || (method == "turn/start" && session.activeTurn() != "") {
		s.mu.Unlock()
		return nil, true, sideChatExpired
	}
	done := make(chan struct{})
	session.submitting = done
	s.mu.Unlock()
	result, err := requestConversationNative(ctx, session.conn, method, raw)
	s.mu.Lock()
	defer s.mu.Unlock()
	session.submitting = nil
	close(done)
	if err == nil && method == "turn/start" {
		var reply map[string]any
		if json.Unmarshal(result, &reply) == nil {
			next := liveObject(reply["turn"])
			if id := liveString(next["id"]); id != "" {
				var items []any
				if i, ok := session.indices[id]; ok {
					old := session.turns[i]
					if status := liveString(old["status"]); status != "" {
						next["status"] = status
					}
					items = liveList(old["items"])
				}
				if !slices.ContainsFunc(items, func(item any) bool { return liveObject(item)["type"] == "userMessage" }) {
					items = append([]any{map[string]any{"id": "side-input:" + id, "type": "userMessage", "content": params["input"]}}, items...)
				}
				next["items"] = items
				session.record(next)
			}
		}
	}
	return result, true, err
}

func sideChatRequest(ctx context.Context, conn *nativeConn, method string, params map[string]any) (map[string]any, error) {
	raw, err := requestConversationNative(ctx, conn, method, conversationObject(params))
	if err != nil {
		return nil, err
	}
	var reply map[string]any
	if json.Unmarshal(raw, &reply) != nil {
		return nil, sideChatExpired
	}
	return reply, nil
}

func (s *conversationSideChats) create(ctx context.Context, input sideChatInput) (json.RawMessage, error) {
	if input.TurnID != "" || (input.SourceThreadID != "" && !conversationID(input.SourceThreadID)) || s.resolveCwd == nil {
		return nil, sideChatExpired
	}
	conn := s.c.bridge.current()
	if conn == nil {
		return nil, errDisconnected
	}
	s.mu.Lock()
	if existing := s.sessions[input.SessionID]; existing != nil {
		creating := existing.creating
		s.mu.Unlock()
		if creating != nil {
			select {
			case <-creating:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return s.handle(ctx, sideChatInput{SessionID: input.SessionID, Action: "snapshot"})
	}
	if len(s.sessions) >= 32 {
		s.mu.Unlock()
		return nil, sideChatExpired
	}
	done := make(chan struct{})
	session := &sideChatSession{conn: conn, seen: time.Now(), turns: []map[string]any{}, indices: make(map[string]int), creating: done}
	s.sessions[input.SessionID] = session
	s.mu.Unlock()
	thread, source, sourceItems, boundary, err := s.createNative(ctx, conn, input)
	s.mu.Lock()
	defer s.mu.Unlock()
	session.thread, session.source, session.sourceItems, session.sourceHasBoundary = thread, source, sourceItems, boundary
	if len(conversationObject(sourceItems)) > sideChatLimit {
		session.sourceItems, session.overflow = nil, true
	}
	session.creating = nil
	close(done)
	if err != nil {
		if s.sessions[input.SessionID] == session {
			delete(s.sessions, input.SessionID)
		}
		return nil, err
	}
	if session.closed || conn != s.c.bridge.current() {
		return nil, sideChatExpired
	}
	return session.snapshot(), nil
}

func (s *conversationSideChats) createNative(ctx context.Context, conn *nativeConn, input sideChatInput) (thread, source map[string]any, sourceItems []map[string]any, boundary bool, err error) {
	method := "thread/start"
	params := map[string]any{"ephemeral": true}
	if input.SourceThreadID == "" {
		var cwd string
		cwd, err = s.resolveCwd(input.Cwd)
		if err != nil {
			return
		}
		params["cwd"] = cwd
	} else {
		var result map[string]any
		result, err = sideChatRequest(ctx, conn, "thread/read", map[string]any{"threadId": input.SourceThreadID, "includeTurns": false})
		if err != nil {
			return
		}
		original := liveObject(result["thread"])
		if original["id"] != input.SourceThreadID || liveString(original["cwd"]) == "" {
			err = sideChatExpired
			return
		}
		if _, err = s.resolveCwd(liveString(original["cwd"])); err != nil {
			return
		}
		result, err = sideChatRequest(ctx, conn, "thread/turns/list", map[string]any{"threadId": input.SourceThreadID, "limit": 2, "sortDirection": "desc", "itemsView": "full"})
		if err != nil {
			return
		}
		source = map[string]any{"threadId": input.SourceThreadID}
		history := []map[string]any{}
		for _, value := range liveList(result["data"]) {
			turn := liveObject(value)
			history = append(history, turn)
			if id := liveString(turn["id"]); !boundary && id != "" && turn["status"] != "inProgress" {
				source["lastTurnId"], boundary = id, true
			}
		}
		if !boundary {
			slices.Reverse(history)
			sourceItems = exportSideChat(history)
		}
		method = "thread/fork"
		maps.Copy(params, source)
		params["excludeTurns"] = true
	}
	var result map[string]any
	result, err = sideChatRequest(ctx, conn, method, params)
	if err != nil {
		return
	}
	thread = liveObject(result["thread"])
	if !conversationID(liveString(thread["id"])) || thread["ephemeral"] != true {
		err = sideChatExpired
	}
	return
}

func exportSideChat(turns []map[string]any) []map[string]any {
	output := []map[string]any{}
	for _, turn := range turns {
		for _, value := range liveList(turn["items"]) {
			item := liveObject(value)
			typ := liveString(item["type"])
			role, contentType := "user", "input_text"
			parts := []map[string]string{}
			switch typ {
			case "userMessage":
				var text, images []string
				for _, value := range liveList(item["content"]) {
					part := liveObject(value)
					switch part["type"] {
					case "text":
						text = append(text, liveString(part["text"]))
					case "localImage":
						images = append(images, liveString(part["path"]))
					}
				}
				message := strings.Join(text, "\n")
				if message == "" {
					message = "Attached image"
				}
				parts = append(parts, map[string]string{"type": contentType, "text": message})
				for _, image := range images {
					parts = append(parts, map[string]string{"type": contentType, "text": "Attached image file: " + image})
				}
			case "agentMessage":
				role, contentType = "assistant", "output_text"
				text := liveString(item["text"])
				if text == "" {
					text = liveText(item["content"])
				}
				if text != "" {
					parts = append(parts, map[string]string{"type": contentType, "text": text})
				}
			default:
				parts = append(parts, map[string]string{"type": contentType, "text": "[Side chat tool record: " + typ + "]\n" + string(conversationObject(item))})
			}
			if len(parts) != 0 {
				output = append(output, map[string]any{"type": "message", "role": role, "content": parts})
			}
		}
	}
	return output
}

func (s *conversationSideChats) promote(ctx context.Context, session *sideChatSession, turnID string) (json.RawMessage, error) {
	// Called with s.mu held. Copy all data before releasing the lock for RPCs.
	if turnID == "" && session.promoted {
		reply := conversationObject(map[string]any{"thread": session.saveTarget})
		s.mu.Unlock()
		return reply, nil
	}
	if session.closed || session.overflow || session.submitting != nil || session.promoting != nil || session.activeTurn() != "" || session.saveUncertain {
		s.mu.Unlock()
		return nil, sideChatExpired
	}
	index := len(session.turns) - 1
	if turnID != "" {
		var ok bool
		if index, ok = session.indices[turnID]; !ok {
			index = -1
		}
	}
	if index < 0 {
		s.mu.Unlock()
		return nil, sideChatExpired
	}
	items := append(slices.Clone(session.sourceItems), exportSideChat(session.turns[:index+1])...)
	if len(conversationObject(items)) > sideChatLimit {
		s.mu.Unlock()
		return nil, sideChatExpired
	}
	done := make(chan struct{})
	session.promoting = done
	s.mu.Unlock()
	defer func() { s.mu.Lock(); session.promoting = nil; close(done); s.mu.Unlock() }()
	if session.saveTarget == nil {
		method := "thread/start"
		params := map[string]any{"cwd": session.thread["cwd"], "ephemeral": false}
		if session.sourceHasBoundary {
			method, params = "thread/fork", maps.Clone(session.source)
			params["ephemeral"], params["excludeTurns"] = false, true
		}
		result, err := sideChatRequest(ctx, session.conn, method, params)
		if err != nil {
			return nil, err
		}
		target := liveObject(result["thread"])
		if !conversationID(liveString(target["id"])) || target["id"] == session.thread["id"] || target["ephemeral"] == true {
			return nil, sideChatExpired
		}
		s.mu.Lock()
		session.saveTarget = target
		s.mu.Unlock()
	}
	s.mu.Lock()
	if session.closed {
		s.mu.Unlock()
		return nil, sideChatExpired
	}
	session.saveUncertain = true
	target := session.saveTarget
	s.mu.Unlock()
	if _, err := sideChatRequest(ctx, session.conn, "thread/inject_items", map[string]any{"threadId": target["id"], "items": items}); err != nil {
		return nil, err
	}
	s.mu.Lock()
	session.promoted = true
	s.mu.Unlock()
	return marshalConversation(map[string]any{"thread": target})
}

func (s *conversationSideChats) release(ctx context.Context, id string) {
	s.mu.Lock()
	session := s.sessions[id]
	if session == nil {
		s.mu.Unlock()
		return
	}
	session.closed = true
	creating, submitting := session.creating, session.submitting
	s.mu.Unlock()
	for _, done := range []chan struct{}{creating, submitting} {
		if done != nil {
			select {
			case <-done:
			case <-ctx.Done():
				return
			}
		}
	}
	s.mu.Lock()
	thread, active, conn := liveString(session.thread["id"]), session.activeTurn(), session.conn
	if s.sessions[id] == session {
		delete(s.sessions, id)
	}
	s.mu.Unlock()
	if thread != "" && conn == s.c.bridge.current() {
		if active != "" {
			_, _ = sideChatRequest(ctx, conn, "turn/interrupt", map[string]any{"threadId": thread, "turnId": active})
		}
		_, _ = sideChatRequest(ctx, conn, "thread/unsubscribe", map[string]any{"threadId": thread})
	}
}

func (s *conversationSideChats) handle(ctx context.Context, input sideChatInput) (json.RawMessage, error) {
	if !submissionUUID.MatchString(input.SessionID) {
		return nil, sideChatExpired
	}
	if input.Action == "create" {
		return s.create(ctx, input)
	}
	if input.SourceThreadID != "" || input.Cwd != "" || (input.TurnID != "" && (input.Action != "promote" || !conversationID(input.TurnID))) {
		return nil, sideChatExpired
	}
	if input.Action == "release" {
		s.release(ctx, input.SessionID)
		return marshalConversation(map[string]bool{"released": true})
	}
	s.mu.Lock()
	session := s.sessions[input.SessionID]
	if session == nil || session.conn != s.c.bridge.current() || session.closed || session.thread == nil || time.Since(session.seen) > sideChatTTL {
		s.mu.Unlock()
		return nil, sideChatExpired
	}
	session.seen = time.Now()
	if input.Action == "promote" {
		return s.promote(ctx, session, input.TurnID)
	}
	defer s.mu.Unlock()
	if input.Action == "snapshot" {
		return session.snapshot(), nil
	}
	return nil, sideChatExpired
}

func (s *conversationSideChats) run(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		stopping := false
		select {
		case <-ctx.Done():
			stopping = true
		case <-ticker.C:
		}
		s.mu.Lock()
		var expired []string
		for id, session := range s.sessions {
			if stopping || session.conn != s.c.bridge.current() || session.closed || time.Since(session.seen) > sideChatTTL {
				expired = append(expired, id)
			}
		}
		s.mu.Unlock()
		var releases sync.WaitGroup
		for _, id := range expired {
			releases.Go(func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				s.release(cleanup, id)
			})
		}
		releases.Wait()
		if stopping {
			return
		}
	}
}
