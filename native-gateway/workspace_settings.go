package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
)

var workspaceEditableSettings = map[string][]any{
	"approval_policy":                        {"on-request", "never"},
	"sandbox_mode":                           {"read-only", "workspace-write", "danger-full-access"},
	"sandbox_workspace_write.network_access": {false, true},
	"memories.generate_memories":             {false, true},
	"memories.use_memories":                  {false, true},
	"web_search":                             {"disabled", "cached", "indexed", "live"},
	"model_reasoning_summary":                {"auto", "concise", "detailed", "none"},
	"model_verbosity":                        {"low", "medium", "high"},
}

type workspaceSettingSource struct {
	Name struct {
		Type    string `json:"type"`
		Profile string `json:"profile"`
	} `json:"name"`
	Version *string `json:"version"`
}

type workspacePublicSettings struct {
	Values               map[string]any    `json:"values"`
	Sources              map[string]string `json:"sources"`
	InstructionsEditable bool              `json:"instructionsEditable"`
	Version              *string           `json:"version"`
	Overridden           *bool             `json:"overridden,omitempty"`
}

func workspaceSettingValue(key string, value any) bool {
	if key == "developer_instructions" {
		instructions, ok := value.(string)
		return ok && len(utf16.Encode([]rune(instructions))) <= 16000
	}
	for _, allowed := range workspaceEditableSettings[key] {
		switch allowed := allowed.(type) {
		case bool:
			if actual, ok := value.(bool); ok && allowed == actual {
				return true
			}
		case string:
			if actual, ok := value.(string); ok && allowed == actual {
				return true
			}
		}
	}
	return false
}

func (s *workspace) rpc(ctx context.Context, method string, params any, result any) error {
	if s.bridge == nil {
		return errDisconnected
	}
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	raw, err := s.bridge.request(ctx, method, body)
	if err != nil || result == nil {
		return err
	}
	return json.Unmarshal(raw, result)
}

func (s *workspace) readSettings(ctx context.Context) (workspacePublicSettings, error) {
	var data struct {
		Config  map[string]any                    `json:"config"`
		Layers  []workspaceSettingSource          `json:"layers"`
		Origins map[string]workspaceSettingSource `json:"origins"`
	}
	var result workspacePublicSettings
	if err := s.rpc(ctx, "config/read", map[string]bool{"includeLayers": true}, &data); err != nil {
		return result, err
	}
	if data.Config == nil || data.Layers == nil {
		return result, errors.New("Settings unavailable")
	}
	for _, layer := range data.Layers {
		if layer.Name.Type == "user" && layer.Name.Profile == "" {
			result.Version = layer.Version
			break
		}
	}
	result.Values, result.Sources = make(map[string]any), make(map[string]string)
	for key := range workspaceEditableSettings {
		var value any = data.Config
		for part := range strings.SplitSeq(key, ".") {
			object, _ := value.(map[string]any)
			value = object[part]
		}
		result.Values[key] = nil
		if workspaceSettingValue(key, value) {
			result.Values[key] = value
		}
		source := data.Origins[key].Name.Type
		switch source {
		case "user", "project", "system", "sessionFlags", "enterpriseManaged", "mdm":
		default:
			source = "default"
		}
		result.Sources[key] = source
	}
	instructions, _ := data.Config["developer_instructions"].(string)
	result.InstructionsEditable = workspaceSettingValue("developer_instructions", instructions)
	if !result.InstructionsEditable {
		instructions = ""
	}
	result.Values["developer_instructions"] = instructions
	return result, nil
}

func (s *workspace) writeSettings(ctx context.Context, r io.Reader) (workspacePublicSettings, error) {
	var payload map[string]json.RawMessage
	var result workspacePublicSettings
	if decodeOne(r, &payload) != nil || len(payload) != 2 {
		return result, errors.New("Invalid settings request")
	}
	var version string
	var values map[string]any
	if json.Unmarshal(payload["version"], &version) != nil || version == "" || len(utf16.Encode([]rune(version))) > 256 ||
		json.Unmarshal(payload["values"], &values) != nil || len(values) == 0 || len(values) > len(workspaceEditableSettings)+1 {
		return result, errors.New("Invalid settings request")
	}
	keys := make([]string, 0, len(values))
	for key, value := range values {
		if !workspaceSettingValue(key, value) {
			return result, errors.New("Unsupported setting or value")
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	edits := make([]map[string]any, 0, len(keys))
	for _, key := range keys {
		edits = append(edits, map[string]any{"keyPath": key, "value": values[key], "mergeStrategy": "replace"})
	}
	current, err := s.readSettings(ctx)
	if err != nil {
		return result, err
	}
	if current.Version == nil || *current.Version != version {
		return result, errors.New("Settings version conflict")
	}
	var written struct{ Status string }
	err = s.rpc(ctx, "config/batchWrite", map[string]any{"edits": edits, "expectedVersion": version, "reloadUserConfig": false}, &written)
	if err != nil {
		return result, err
	}
	result, err = s.readSettings(ctx)
	overridden := written.Status == "okOverridden"
	result.Overridden = &overridden
	return result, err
}

func (s *workspace) settings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Allow", "GET, PUT")
	if !workspaceMethod(w, r, "GET", "PUT") {
		return
	}
	var result workspacePublicSettings
	var err error
	if r.Method == "GET" {
		result, err = s.readSettings(r.Context())
	} else {
		auth, _ := r.Context().Value(requestAuthKey{}).(authResult)
		mediaType, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if !auth.ok || auth.origin == "" || r.Header.Get("Origin") != auth.origin || r.Header.Get("Sec-Fetch-Site") == "cross-site" || mediaErr != nil || mediaType != "application/json" {
			workspaceError(w, 403, "A same-origin workspace request is required.")
			return
		}
		result, err = s.writeSettings(r.Context(), http.MaxBytesReader(w, r.Body, 65536))
	}
	if err != nil {
		message := strings.ToLower(err.Error())
		if strings.Contains(message, "version") || strings.Contains(message, "conflict") {
			workspaceError(w, 409, "Settings changed. Reload before saving.")
		} else {
			workspaceError(w, 400, "Unable to read or save Codex settings. Check the supported values and server connection.")
		}
		return
	}
	workspaceRespond(w, 200, result)
}

type workspaceStorage struct {
	Groups     map[string]int64 `json:"groups"`
	TotalBytes int64            `json:"totalBytes"`
	Partial    bool             `json:"partial"`
	MeasuredAt string           `json:"measuredAt"`
}

func workspaceStorageGroup(name string) string {
	switch name {
	case "sessions", "memories", "worktrees", "logs":
		return name
	case "archived_sessions":
		return "archived"
	case "log":
		return "logs"
	default:
		return "other"
	}
}

func workspaceStorageUsage(ctx context.Context, path string, limit int, timeout time.Duration) workspaceStorage {
	result := workspaceStorage{Groups: map[string]int64{"sessions": 0, "archived": 0, "memories": 0, "worktrees": 0, "logs": 0, "other": 0}}
	deadline := time.Now().Add(timeout)
	remaining := limit
	var visit func(root *os.Root, category string, depth int)
	visit = func(root *os.Root, category string, depth int) {
		if depth > 128 {
			result.Partial = true
			return
		}
		dir, err := root.Open(".")
		if err != nil {
			result.Partial = true
			return
		}
		defer dir.Close()
		for {
			entries, err := dir.ReadDir(128)
			for _, entry := range entries {
				if remaining <= 0 || time.Now().After(deadline) || ctx.Err() != nil {
					result.Partial = true
					return
				}
				remaining--
				info, err := root.Lstat(entry.Name())
				if err != nil {
					result.Partial = result.Partial || !os.IsNotExist(err)
					continue
				}
				group := category
				if depth == 0 {
					group = workspaceStorageGroup(entry.Name())
				}
				if info.Mode().IsRegular() {
					result.Groups[group] += info.Size()
					result.TotalBytes += info.Size()
				} else if info.IsDir() {
					child, err := root.OpenRoot(entry.Name())
					if err != nil {
						result.Partial = true
						continue
					}
					if after, err := child.Stat("."); err == nil && os.SameFile(info, after) {
						visit(child, group, depth+1)
					} else {
						result.Partial = true
					}
					child.Close()
				}
			}
			if err != nil {
				result.Partial = result.Partial || err != io.EOF
				return
			}
		}
	}
	if info, err := os.Lstat(path); err == nil {
		if info.IsDir() {
			canonical := workspaceCanonical(path)
			if root, err := workspaceOpenDirectory(canonical, canonical); err == nil {
				visit(root, "other", 0)
				root.Close()
			} else {
				result.Partial = true
			}
		} else if info.Mode().IsRegular() {
			result.Groups["other"], result.TotalBytes = info.Size(), info.Size()
		}
	} else {
		result.Partial = !os.IsNotExist(err)
	}
	result.MeasuredAt = workspaceISODate(time.Now())
	return result
}

func (s *workspace) storage(w http.ResponseWriter, r *http.Request) {
	if workspaceMethod(w, r, "GET") {
		workspaceRespond(w, 200, workspaceStorageUsage(r.Context(), s.privateRoot, 20000, 1500*time.Millisecond))
	}
}

type workspaceBoundedOutput struct{ bytes.Buffer }

func (o *workspaceBoundedOutput) Write(data []byte) (int, error) {
	if len(data)+o.Len() > 512<<10 {
		return 0, errors.New("Git output limit exceeded")
	}
	return o.Buffer.Write(data)
}

func (s *workspace) worktrees(w http.ResponseWriter, r *http.Request) {
	if !workspaceMethod(w, r, "GET") {
		return
	}
	const unavailable = "Storage or worktree information is unavailable."
	cwd, canonical, err := s.browse(workspaceDefault(r.URL.Query().Get("cwd"), s.cwd))
	if err != nil {
		workspaceError(w, 400, unavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "worktree", "list", "--porcelain", "-z")
	cmd.Dir = canonical
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	var output workspaceBoundedOutput
	cmd.Stdout = &output
	if err := cmd.Run(); err != nil {
		workspaceError(w, 400, unavailable)
		return
	}
	items := []map[string]any{}
	for record := range strings.SplitSeq(output.String(), "\x00\x00") {
		path, branch, detached, locked := "", "", false, false
		for field := range strings.SplitSeq(record, "\x00") {
			switch {
			case strings.HasPrefix(field, "worktree "):
				path = strings.TrimPrefix(field, "worktree ")
			case strings.HasPrefix(field, "branch "):
				branch = strings.TrimPrefix(strings.TrimPrefix(field, "branch "), "refs/heads/")
			case field == "detached":
				detached = true
			case field == "locked" || strings.HasPrefix(field, "locked "):
				locked = true
			}
		}
		if path != "" {
			name, err := filepath.Rel(cwd, path)
			if err != nil {
				name = path
			}
			items = append(items, map[string]any{"path": path, "name": name, "branch": branch, "detached": detached, "locked": locked})
		}
	}
	workspaceRespond(w, 200, map[string]any{"worktrees": items})
}
