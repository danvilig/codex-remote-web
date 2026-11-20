package main

import (
	"context"
	"sort"
)

func (d *developerTools) mcp(ctx context.Context, input developerInput) (any, error) {
	if input.Cwd != "" {
		if _, err := d.project(input.Cwd); err != nil {
			return nil, err
		}
	}
	servers := []map[string]any{}
	var cursor any
	seen := map[string]bool{}
	partial := false
	for index := range 100 {
		params := map[string]any{"limit": 100, "cursor": cursor, "detail": "full"}
		if input.ThreadID != "" {
			params["threadId"] = input.ThreadID
		}
		var page struct {
			Data []struct {
				Name, AuthStatus, RuntimeStatus string
				Tools                           map[string]struct{ Name, Description string }
				Resources                       []struct{ Name, MimeType string }
				ResourceTemplates               []struct{ Name string }
			}
			NextCursor string
		}
		if err := d.w.rpc(ctx, "mcpServerStatus/list", params, &page); err != nil || page.Data == nil {
			return nil, developerFailure("TOOLS_MCP_UNAVAILABLE", 503)
		}
		for _, server := range page.Data {
			if len(servers) >= 500 {
				partial = true
				break
			}
			tools, resources, templates := []map[string]string{}, []map[string]string{}, []map[string]string{}
			keys := make([]string, 0, len(server.Tools))
			for key := range server.Tools {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys[:min(len(keys), 1000)] {
				item := server.Tools[key]
				tools = append(tools, map[string]string{"name": workspaceBoundedText(item.Name, 256), "description": workspaceBoundedText(item.Description, 2000)})
			}
			for _, item := range server.Resources[:min(len(server.Resources), 1000)] {
				resources = append(resources, map[string]string{"name": workspaceBoundedText(item.Name, 256), "mimeType": workspaceBoundedText(item.MimeType, 128)})
			}
			for _, item := range server.ResourceTemplates[:min(len(server.ResourceTemplates), 1000)] {
				templates = append(templates, map[string]string{"name": workspaceBoundedText(item.Name, 256)})
			}
			servers = append(servers, map[string]any{"name": workspaceBoundedText(server.Name, 256), "authStatus": workspaceDefault(server.AuthStatus, "unknown"), "runtimeStatus": workspaceDefault(server.RuntimeStatus, "unknown"), "tools": tools, "resources": resources, "resourceTemplates": templates})
		}
		if page.NextCursor == "" {
			break
		}
		if len(servers) >= 500 || seen[page.NextCursor] || index == 99 {
			partial = true
			break
		}
		cursor = page.NextCursor
		seen[page.NextCursor] = true
	}
	return map[string]any{"servers": servers, "partial": partial, "readOnly": true}, nil
}
