package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

type developerTools struct {
	w                    *workspace
	path                 string
	mu                   sync.Mutex
	previews             map[string]developerPreview
	worktreeBusy         func(context.Context, string) bool
	protectedAttachments func() (map[string]bool, error)
	terminalGate         *sync.RWMutex
}

type developerPreview struct {
	kind    string
	value   any
	expires time.Time
}

type developerInput struct {
	Action, Cwd, ID, Revision, PreviewToken, ThreadID string
	Text                                              *string
}

func newDeveloperTools(w *workspace) *developerTools {
	return &developerTools{w: w, path: filepath.Join(w.privateRoot, "remote-web-developer-tools"), previews: make(map[string]developerPreview)}
}

func developerFailure(code string, status int) error { return desktopFailure(status, code, code) }

func (d *developerTools) project(cwd string) (string, error) {
	if cwd == "" {
		return "", developerFailure("TOOLS_INVALID_PROJECT", 400)
	}
	name, canonical, err := d.w.browse(cwd)
	if err != nil {
		return "", developerFailure("TOOLS_INVALID_PROJECT", 400)
	}
	if info, err := os.Lstat(name); err != nil || !info.IsDir() {
		return "", developerFailure("TOOLS_UNSAFE_PATH", 403)
	}
	return canonical, nil
}

func (d *developerTools) root() (*os.Root, error) {
	if err := os.MkdirAll(d.w.privateRoot, 0700); err != nil {
		return nil, err
	}
	private := workspaceCanonical(d.w.privateRoot)
	parent, err := workspaceOpenDirectory(private, private)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	if info, err := parent.Stat("."); err != nil || !desktopOwned(info) || info.Mode().Perm()&0022 != 0 {
		return nil, developerFailure("TOOLS_UNSAFE_PATH", 403)
	}
	name := filepath.Base(d.path)
	if err := parent.Mkdir(name, 0700); err != nil && !os.IsExist(err) {
		return nil, err
	}
	return attachmentOpenDir(parent, name)
}

func (d *developerTools) putPreview(kind string, value any) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := time.Now()
	oldest := ""
	for key, item := range d.previews {
		if item.expires.Before(now) {
			delete(d.previews, key)
			continue
		}
		if oldest == "" || d.previews[oldest].expires.After(item.expires) {
			oldest = key
		}
	}
	if len(d.previews) >= 100 {
		delete(d.previews, oldest)
	}
	key := workspaceUUID()
	d.previews[key] = developerPreview{kind, value, now.Add(5 * time.Minute)}
	return key
}

func (d *developerTools) consume(kind, key string) (any, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	value, ok := d.previews[key]
	delete(d.previews, key)
	if !ok || value.kind != kind || time.Now().After(value.expires) {
		return nil, developerFailure("TOOLS_PREVIEW_EXPIRED", 409)
	}
	return value.value, nil
}

func (d *developerTools) serve(w http.ResponseWriter, r *http.Request) {
	if !workspaceMethod(w, r, "POST") {
		return
	}
	if !workspaceMutationAllowed(r) {
		workspaceError(w, 403, "A same-origin workspace request is required.")
		return
	}
	var input developerInput
	if err := decodeOne(http.MaxBytesReader(w, r.Body, 512<<10), &input); err != nil {
		workspaceRespond(w, 400, map[string]string{"error": "TOOLS_INVALID_REQUEST", "code": "TOOLS_INVALID_REQUEST"})
		return
	}
	result, err := d.action(r.Context(), input)
	if err == nil {
		workspaceRespond(w, 200, result)
		return
	}
	var failure *desktopError
	if errors.As(err, &failure) {
		workspaceRespond(w, failure.Status, map[string]string{"error": failure.Message, "code": failure.Code})
		return
	}
	workspaceRespond(w, 400, map[string]string{"error": "Developer tools unavailable.", "code": "DEVELOPER_TOOLS_UNAVAILABLE"})
}

func (d *developerTools) action(ctx context.Context, input developerInput) (any, error) {
	switch input.Action {
	case "agents.read":
		return d.agentsRead(input.Cwd)
	case "agents.preview":
		return d.agentsPreview(input)
	case "worktrees.list":
		return d.worktreesList(ctx, input.Cwd)
	case "worktrees.preview-remove":
		return d.worktreesPreview(ctx, input)
	case "cleanup.preview":
		return d.cleanup(ctx, false, "")
	case "mcp.inventory":
		return d.mcp(ctx, input)
	case "agents.save", "worktrees.create", "worktrees.remove", "cleanup.execute":
	default:
		return nil, developerFailure("TOOLS_INVALID_ACTION", 400)
	}
	root, err := d.root()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	host, _ := os.Hostname()
	release, err := lockConversation(root.Name(), "mutation.lock", host, 0)
	if err != nil {
		return nil, developerLockError(err, "TOOLS_BUSY")
	}
	defer release()
	switch input.Action {
	case "agents.save":
		return d.agentsSave(input.PreviewToken)
	case "worktrees.create":
		return d.worktreesCreate(ctx, root, input.Cwd)
	case "worktrees.remove":
		return d.worktreesRemove(ctx, root, input.PreviewToken)
	default:
		return d.cleanup(ctx, true, input.PreviewToken)
	}
}

func developerLockError(err error, code string) error {
	var lock *conversationError
	if errors.As(err, &lock) && (lock.code == "PRIVATE_LOCK_BUSY" || lock.code == "PRIVATE_LOCK_LEGACY_BUSY") {
		return developerFailure(code, 409)
	}
	return err
}

type developerInherited struct {
	Path     string `json:"path"`
	Bytes    int64  `json:"bytes"`
	ReadOnly bool   `json:"readOnly"`
}

type developerAgents struct {
	Exists    bool                 `json:"exists"`
	Text      string               `json:"text"`
	Revision  string               `json:"revision"`
	Inherited []developerInherited `json:"inherited"`
	info      os.FileInfo
}

func developerAgentsRead(root *os.Root) (developerAgents, error) {
	result := developerAgents{Revision: "missing", Inherited: []developerInherited{}}
	const name = "AGENTS.md"
	before, err := root.Lstat(name)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	file, info, err := developerOpenRegular(root, name, os.O_RDONLY, workspaceTextLimit)
	if err != nil || !os.SameFile(before, info) {
		if file != nil {
			file.Close()
		}
		return result, developerFailure("TOOLS_FILE_UNSAFE", 403)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, workspaceTextLimit+1))
	if err != nil || len(data) > workspaceTextLimit || bytes.ContainsRune(data, 0) || !utf8.Valid(data) {
		return result, developerFailure("TOOLS_FILE_UNSAFE", 403)
	}
	result.Exists, result.Text, result.Revision, result.info = true, strings.TrimPrefix(string(data), "\uFEFF"), workspaceRevision(data), info
	return result, nil
}

func developerOpenRegular(root *os.Root, name string, flags int, limit int64) (*os.File, os.FileInfo, error) {
	before, err := root.Lstat(name)
	if err != nil {
		return nil, nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, nil, developerFailure("TOOLS_UNSAFE_PATH", 403)
	}
	file, err := root.OpenFile(name, flags|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil || !os.SameFile(before, info) || info.Sys().(*syscall.Stat_t).Nlink != 1 || info.Size() > limit {
		file.Close()
		return nil, nil, developerFailure("TOOLS_UNSAFE_PATH", 403)
	}
	return file, info, nil
}

func (d *developerTools) agentsRead(cwd string) (developerAgents, error) {
	project, err := d.project(cwd)
	if err != nil {
		return developerAgents{}, err
	}
	root, err := workspaceOpenDirectory(project, project)
	if err != nil {
		return developerAgents{}, err
	}
	defer root.Close()
	result, err := developerAgentsRead(root)
	if err != nil {
		return result, err
	}
	private := workspaceCanonical(d.w.privateRoot)
	allowed := workspaceCanonicalRoots(d.w.browseRoots)
	seen := make(map[string]bool)
	add := func(dir, name string) {
		path := filepath.Join(dir, name)
		if seen[path] {
			return
		}
		seen[path] = true
		r, err := workspaceOpenDirectory(dir, dir)
		if err != nil {
			return
		}
		defer r.Close()
		f, info, err := developerOpenRegular(r, name, os.O_RDONLY, workspaceTextLimit)
		if err != nil {
			return
		}
		f.Close()
		label, _ := filepath.Rel(project, path)
		if workspaceWithin(path, private) {
			label = "Codex home/" + name
		}
		result.Inherited = append(result.Inherited, developerInherited{label, info.Size(), true})
	}
	add(private, "AGENTS.md")
	add(private, "AGENTS.override.md")
	add(project, "AGENTS.override.md")
	for dir := filepath.Dir(project); dir != filepath.Dir(dir) && workspaceInRoots(dir, allowed); dir = filepath.Dir(dir) {
		add(dir, "AGENTS.md")
		add(dir, "AGENTS.override.md")
	}
	return result, nil
}

type developerAgentsChange struct{ cwd, text, revision string }

func (d *developerTools) agentsPreview(input developerInput) (any, error) {
	cwd, err := d.project(input.Cwd)
	if err != nil {
		return nil, err
	}
	before, err := d.agentsRead(cwd)
	if err != nil {
		return nil, err
	}
	if input.Text == nil || len(*input.Text) > workspaceTextLimit || strings.ContainsRune(*input.Text, 0) {
		return nil, developerFailure("TOOLS_INVALID_TEXT", 400)
	}
	if input.Revision != before.Revision {
		return nil, developerFailure("TOOLS_FILE_CONFLICT", 409)
	}
	token := d.putPreview("agents", developerAgentsChange{cwd, *input.Text, before.Revision})
	return map[string]any{"previewToken": token, "name": "AGENTS.md", "before": before.Text, "after": *input.Text, "creating": !before.Exists}, nil
}

func (d *developerTools) agentsSave(token string) (any, error) {
	value, err := d.consume("agents", token)
	if err != nil {
		return nil, err
	}
	change := value.(developerAgentsChange)
	cwd, err := d.project(change.cwd)
	if err != nil {
		return nil, err
	}
	dir, err := workspaceOpenDirectory(cwd, cwd)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	before, err := developerAgentsRead(dir)
	if err != nil {
		return nil, err
	}
	conflict := developerFailure("TOOLS_FILE_CONFLICT", 409)
	if before.Revision != change.revision {
		return nil, conflict
	}
	mode := os.FileMode(0644)
	if before.Exists {
		mode = before.info.Mode().Perm()
	}
	temp := ".codex-remote-agents-" + workspaceUUID()
	f, err := dir.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	defer dir.Remove(temp)
	_, err = f.WriteString(change.text)
	if err == nil {
		err = f.Chmod(mode)
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	verified, err := workspaceOpenDirectory(cwd, cwd)
	if err != nil {
		return nil, conflict
	}
	defer verified.Close()
	a, aErr := dir.Stat(".")
	b, bErr := verified.Stat(".")
	current, err := developerAgentsRead(verified)
	if err != nil || aErr != nil || bErr != nil || !os.SameFile(a, b) || current.Revision != before.Revision || (before.Exists && !os.SameFile(before.info, current.info)) {
		return nil, conflict
	}
	if before.Exists {
		err = dir.Rename(temp, "AGENTS.md")
	} else {
		err = dir.Link(temp, "AGENTS.md")
		if os.IsExist(err) {
			return nil, conflict
		}
		if err == nil {
			err = dir.Remove(temp)
		}
	}
	if err != nil {
		return nil, err
	}
	result, err := d.agentsRead(cwd)
	return struct {
		OK bool `json:"ok"`
		developerAgents
	}{true, result}, err
}
