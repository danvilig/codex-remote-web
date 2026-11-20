// Disposable App Server fixture for the runtime image, which has no Node or Bun.
package main

import (
	"bufio"
	"encoding/json"
	"os"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		os.Stdout.WriteString("codex-cli 0.164.0\n")
		return
	}
	if len(os.Args) < 2 || os.Args[1] != "app-server" {
		os.Exit(2)
	}
	scanner := bufio.NewScanner(os.Stdin)
	output := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &req) != nil || len(req.ID) == 0 {
			continue
		}
		var result any = map[string]any{"data": []any{}}
		switch req.Method {
		case "initialize":
			result = map[string]string{"userAgent": "docker-fixture"}
		case "account/read":
			result = map[string]any{"account": nil, "requiresOpenaiAuth": true}
		}
		if output.Encode(map[string]any{"id": req.ID, "result": result}) != nil {
			return
		}
	}
}
