package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type conversationNotifier struct {
	url   string
	turns chan deliveryTurnEvent
}

func newConversationNotifier() *conversationNotifier {
	topic := os.Getenv("CODEX_WEBUI_NTFY_TOPIC")
	if topic == "" {
		return nil
	}
	base := os.Getenv("CODEX_WEBUI_NTFY_URL")
	if base == "" {
		base = "https://ntfy.sh"
	}
	return &conversationNotifier{url: strings.TrimRight(base, "/") + "/" + url.PathEscape(topic), turns: make(chan deliveryTurnEvent, 32)}
}

func (n *conversationNotifier) observe(params json.RawMessage) {
	var event deliveryTurnEvent
	if json.Unmarshal(params, &event) != nil {
		return
	}
	select {
	case n.turns <- event:
	default:
	}
}

func (n *conversationNotifier) run(ctx context.Context) {
	client := &http.Client{Timeout: 10 * time.Second}
	for {
		select {
		case <-ctx.Done():
			return
		case event := <-n.turns:
			body := "Codex task completed"
			if event.ThreadID != "" {
				id := []rune(event.ThreadID)
				body += " (thread " + string(id[:min(len(id), 8)]) + ")"
			}
			request, err := http.NewRequestWithContext(ctx, "POST", n.url, strings.NewReader(body))
			if err != nil {
				continue
			}
			request.Header.Set("Title", "Codex task completed")
			request.Header.Set("Tags", "white_check_mark")
			if event.Turn.ID != "" {
				request.Header.Set("X-Turn-Id", event.Turn.ID)
			}
			if response, err := client.Do(request); err == nil {
				_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
				_ = response.Body.Close()
			}
		}
	}
}
