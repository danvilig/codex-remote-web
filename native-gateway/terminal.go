package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

func serveTerminal(w http.ResponseWriter, r *http.Request, cwd string) {
	ws, err := authenticatedUpgrade(w, r)
	if err != nil {
		return
	}
	defer ws.Close()
	ws.SetReadLimit(1_000_000)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	due, stop, code := lease(ctx)
	defer stop()
	cmd := terminalCommand(cwd)
	session, err := startTerminal(cmd, 100, 24)
	if err != nil {
		_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1011, "Terminal unavailable"), time.Now().Add(writeTimeout))
		return
	}
	defer session.close()
	go func() {
		defer cancel()
		for {
			kind, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if kind == websocket.BinaryMessage {
				if _, err := session.input().Write(data); err != nil {
					return
				}
			} else if kind == websocket.TextMessage {
				var msg struct {
					Type       string `json:"type"`
					Cols, Rows uint16
				}
				if json.Unmarshal(data, &msg) == nil && msg.Type == "resize" {
					_ = session.resize(msg.Cols, msg.Rows)
				}
			}
		}
	}()
	output := make(chan []byte, 4)
	go func() {
		defer close(output)
		reader := bufio.NewReader(session.output())
		var block []byte
		for {
			rn, size, err := reader.ReadRune()
			if size != 0 {
				block = append(block, string(rn)...)
			}
			if len(block) > 0 && (err != nil || reader.Buffered() == 0 || len(block) >= 16<<10) {
				select {
				case output <- block:
					block = nil
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	write := func(data []byte) bool {
		return ws.SetWriteDeadline(time.Now().Add(writeTimeout)) == nil && ws.WriteMessage(websocket.TextMessage, data) == nil
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-due:
			closeForLease(ws, code)
			return
		case data, ok := <-output:
			if ok {
				if !write(data) {
					return
				}
				continue
			}
			select {
			case <-session.done:
			case <-ctx.Done():
				return
			case <-due:
				closeForLease(ws, code)
				return
			}
			status := session.exitStatus()
			_ = write(fmt.Appendf(nil, "\r\n[Process exited %d]\r\n", status))
			_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "Terminal exited"), time.Now().Add(writeTimeout))
			return
		}
	}
}
