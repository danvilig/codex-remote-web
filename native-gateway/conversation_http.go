package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf16"
)

func conversationID(id string) bool { return id != "" && len(utf16.Encode([]rune(id))) <= 512 }

func conversationDecode(r *http.Request, w http.ResponseWriter, limit int64, dest any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dest); err != nil {
		return err
	}
	var tail any
	if err := decoder.Decode(&tail); err != io.EOF {
		return conversationFailure("INVALID_REQUEST", "Unexpected request body")
	}
	return nil
}

func (c *conversation) register(mux *http.ServeMux, mutationAllowed func(*http.Request) bool, resolveCwd func(string) (string, error)) {
	if c.delivery != nil {
		c.delivery.resolveCwd = resolveCwd
	}
	c.sideChats.resolveCwd = resolveCwd
	if c.scheduler != nil {
		c.scheduler.register(mux, mutationAllowed, resolveCwd)
	}
	mux.HandleFunc("POST /api/conversation/side-chat", func(w http.ResponseWriter, r *http.Request) {
		if !mutationAllowed(r) {
			jsonReply(w, 403, map[string]string{"error": "A same-origin workspace request is required."})
			return
		}
		var input sideChatInput
		if conversationDecode(r, w, 16384, &input) == nil {
			if result, err := c.sideChats.handle(r.Context(), input); err == nil {
				jsonReply(w, 200, result)
				return
			}
		}
		jsonReply(w, 400, map[string]string{"error": "Temporary side chat is unavailable or expired. Your draft was kept."})
	})
	mux.HandleFunc("/api/conversation/fork", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.Header().Set("Allow", "POST")
			w.WriteHeader(405)
			return
		}
		if !mutationAllowed(r) {
			jsonReply(w, 403, map[string]string{"error": "A same-origin workspace request is required."})
			return
		}
		var input struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
		}
		if conversationDecode(r, w, 16384, &input) != nil || !conversationID(input.ThreadID) || (input.TurnID != "" && !conversationID(input.TurnID)) {
			conversationHTTPError(w)
			return
		}
		params := map[string]any{"threadId": input.ThreadID, "ephemeral": false}
		if input.TurnID != "" {
			params["lastTurnId"] = input.TurnID
		}
		result, err := c.request(r.Context(), "thread/fork", conversationObject(params))
		var reply struct {
			Thread json.RawMessage `json:"thread"`
		}
		var thread struct{ ID string }
		if err != nil || json.Unmarshal(result, &reply) != nil || json.Unmarshal(reply.Thread, &thread) != nil || thread.ID == "" || thread.ID == input.ThreadID {
			conversationHTTPError(w)
			return
		}
		jsonReply(w, 200, reply)
	})
	mux.HandleFunc("/api/conversation/goal", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "POST" {
			w.Header().Set("Allow", "GET, POST")
			w.WriteHeader(405)
			return
		}
		var input conversationGoal
		if r.Method == "POST" {
			if !mutationAllowed(r) {
				jsonReply(w, 403, map[string]string{"error": "A same-origin workspace request is required."})
				return
			}
			if conversationDecode(r, w, 20000, &input) != nil {
				conversationHTTPError(w)
				return
			}
		} else {
			input.ThreadID, input.Action = r.URL.Query().Get("threadId"), "get"
		}
		result, err := c.goal(r.Context(), input)
		if err != nil {
			conversationHTTPError(w)
			return
		}
		jsonReply(w, 200, result)
	})
}

func conversationHTTPError(w http.ResponseWriter) {
	jsonReply(w, 400, map[string]string{"error": "This action is unavailable. Check the Codex connection and feature support."})
}

type conversationGoal struct {
	ThreadID    string `json:"threadId"`
	Action      string `json:"action"`
	Objective   string `json:"objective"`
	TokenBudget *int   `json:"tokenBudget"`
}

func (c *conversation) goal(ctx context.Context, input conversationGoal) (json.RawMessage, error) {
	invalid := conversationFailure("INVALID_REQUEST", "Invalid goal")
	if !conversationID(input.ThreadID) {
		return nil, invalid
	}
	method := "thread/goal/set"
	params := map[string]any{"threadId": input.ThreadID, "origin": "user"}
	switch input.Action {
	case "get":
		method = "thread/goal/get"
		delete(params, "origin")
	case "clear":
		method = "thread/goal/clear"
	case "pause":
		params["status"] = "paused"
	case "resume":
		params["status"] = "active"
	case "set":
		objective := strings.TrimSpace(input.Objective)
		if objective == "" || len(utf16.Encode([]rune(input.Objective))) > 16000 {
			return nil, invalid
		}
		params["objective"] = objective
		if input.TokenBudget != nil {
			if *input.TokenBudget < 1 || *input.TokenBudget > 1_000_000_000 {
				return nil, invalid
			}
			params["tokenBudget"] = *input.TokenBudget
		}
	default:
		return nil, invalid
	}
	return c.request(ctx, method, conversationObject(params))
}
