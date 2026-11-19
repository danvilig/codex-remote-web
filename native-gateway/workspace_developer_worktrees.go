package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

var developerUUID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)

type developerWorktree struct {
	ID        string `json:"id"`
	Project   string `json:"project"`
	Path      string `json:"path"`
	Branch    string `json:"branch"`
	CreatedAt string `json:"createdAt"`
}

type developerGitWorktree struct {
	path, branch     string
	detached, locked bool
}

func developerGit(ctx context.Context, cwd string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"}, args...)...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
	cmd.WaitDelay = time.Second
	var out workspaceBoundedOutput
	cmd.Stdout = &out
	err := cmd.Run()
	return out.String(), err
}

func (d *developerTools) repository(ctx context.Context, cwd string) (string, string, error) {
	selected, err := d.project(cwd)
	if err != nil {
		return "", "", err
	}
	repository, err := developerGit(ctx, selected, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", "", err
	}
	repository = strings.TrimSuffix(repository, "\n")
	root, err := d.project(repository)
	return selected, root, err
}

func developerWorktreeList(ctx context.Context, cwd string) ([]developerGitWorktree, error) {
	out, err := developerGit(ctx, cwd, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	items := []developerGitWorktree{}
	for record := range strings.SplitSeq(out, "\x00\x00") {
		var item developerGitWorktree
		for field := range strings.SplitSeq(record, "\x00") {
			switch {
			case strings.HasPrefix(field, "worktree "):
				item.path = workspaceCanonical(strings.TrimPrefix(field, "worktree "))
			case strings.HasPrefix(field, "branch "):
				item.branch = strings.TrimPrefix(strings.TrimPrefix(field, "branch "), "refs/heads/")
			case field == "detached":
				item.detached = true
			case field == "locked" || strings.HasPrefix(field, "locked "):
				item.locked = true
			}
		}
		if item.path != "" {
			items = append(items, item)
		}
	}
	return items, nil
}

func developerRegistry(root *os.Root) ([]developerWorktree, error) {
	items := []developerWorktree{}
	err := attachmentReadJSON(root, "worktrees.json", workspaceTextLimit, &items)
	if os.IsNotExist(err) {
		return items, nil
	}
	if err != nil || items == nil {
		return nil, developerFailure("TOOLS_UNSAFE_PATH", 403)
	}
	return items, nil
}

func developerSaveRegistry(root *os.Root, items []developerWorktree) error {
	data, err := json.Marshal(items)
	if err != nil || len(data) > workspaceTextLimit {
		return developerFailure("TOOLS_UNSAFE_PATH", 403)
	}
	temp := workspaceUUID() + ".tmp"
	f, err := root.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|noFollow, 0600)
	if err != nil {
		return err
	}
	defer root.Remove(temp)
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return root.Rename(temp, "worktrees.json")
}

func (d *developerTools) worktreesList(ctx context.Context, cwd string) (any, error) {
	selected, repo, err := d.repository(ctx, cwd)
	if err != nil {
		return nil, err
	}
	root, err := d.root()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	records, err := developerRegistry(root)
	if err != nil {
		return nil, err
	}
	items, err := developerWorktreeList(ctx, selected)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		var id any
		for _, record := range records {
			if record.Project == repo && record.Path == item.path {
				id = record.ID
				break
			}
		}
		name, err := filepath.Rel(selected, item.path)
		if err != nil {
			name = item.path
		}
		result = append(result, map[string]any{"path": item.path, "name": name, "branch": item.branch, "detached": item.detached, "locked": item.locked, "managed": id != nil, "id": id, "removable": d.worktreeBusy != nil})
	}
	return map[string]any{"worktrees": result}, nil
}

func developerExclude(ctx context.Context, repo string) error {
	common, err := developerGit(ctx, repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return err
	}
	common = workspaceCanonical(strings.TrimSuffix(common, "\n"))
	// External shared Git directories are allowed only when they are the
	// canonical .git directory of a worktree Git itself lists.
	admitted := common == filepath.Join(repo, ".git")
	if !admitted {
		items, err := developerWorktreeList(ctx, repo)
		if err != nil {
			return err
		}
		admitted = len(items) > 0 && common == filepath.Join(items[0].path, ".git")
	}
	if !admitted {
		return developerFailure("TOOLS_UNSAFE_PATH", 403)
	}
	parent, err := workspaceOpenDirectory(common, filepath.Join(common, "info"))
	if err != nil {
		return err
	}
	defer parent.Close()
	const name = "exclude"
	const line = "/.codex-remote-web/"
	f, _, err := developerOpenRegular(parent, name, os.O_RDWR|os.O_APPEND, 1<<20)
	if os.IsNotExist(err) {
		f, err = parent.OpenFile(name, os.O_RDWR|os.O_APPEND|os.O_CREATE|os.O_EXCL|noFollow, 0644)
	}
	if err != nil {
		return err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return developerFailure("TOOLS_UNSAFE_PATH", 403)
	}
	for entry := range strings.SplitSeq(string(data), "\n") {
		if entry == line {
			return nil
		}
	}
	_, err = f.WriteString("\n" + line + "\n")
	return err
}

func (d *developerTools) worktreesCreate(ctx context.Context, root *os.Root, cwd string) (any, error) {
	selected, repo, err := d.repository(ctx, cwd)
	if err != nil {
		return nil, err
	}
	if _, err = developerGit(ctx, selected, "rev-parse", "--verify", "HEAD"); err != nil {
		return nil, err
	}
	checkout, err := workspaceOpenDirectory(repo, repo)
	if err != nil {
		return nil, err
	}
	defer checkout.Close()
	if err := checkout.Mkdir(".codex-remote-web", 0700); err != nil && !os.IsExist(err) {
		return nil, err
	}
	managed, _, err := workspaceSkillChild(checkout, ".codex-remote-web")
	if err != nil {
		return nil, developerFailure("TOOLS_UNSAFE_PATH", 403)
	}
	defer managed.Close()
	if err := managed.Mkdir("worktrees", 0700); err != nil && !os.IsExist(err) {
		return nil, err
	}
	parent, _, err := workspaceSkillChild(managed, "worktrees")
	if err != nil {
		return nil, developerFailure("TOOLS_UNSAFE_PATH", 403)
	}
	defer parent.Close()
	if err := developerExclude(ctx, repo); err != nil {
		return nil, err
	}
	records, err := developerRegistry(root)
	if err != nil {
		return nil, err
	}
	id := workspaceUUID()
	path := filepath.Join(repo, ".codex-remote-web", "worktrees", id)
	item := developerWorktree{ID: id, Project: repo, Path: path, Branch: "codex/web-" + id, CreatedAt: workspaceISODate(time.Now())}
	if _, err = developerGit(ctx, repo, "worktree", "add", "-b", item.Branch, path, "HEAD"); err != nil {
		return nil, err
	}
	if err = developerSaveRegistry(root, append(records, item)); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "item": item}, nil
}

func (d *developerTools) removableWorktree(ctx context.Context, root *os.Root, cwd, id string) (developerWorktree, []developerWorktree, error) {
	var item developerWorktree
	_, repo, err := d.repository(ctx, cwd)
	if err != nil {
		return item, nil, err
	}
	if !developerUUID.MatchString(id) {
		return item, nil, developerFailure("TOOLS_INVALID_WORKTREE", 400)
	}
	records, err := developerRegistry(root)
	if err != nil {
		return item, nil, err
	}
	for _, record := range records {
		if record.ID == id && record.Project == repo {
			item = record
			break
		}
	}
	if item.ID != id || item.Path != filepath.Join(repo, ".codex-remote-web", "worktrees", id) || item.Branch != "codex/web-"+id {
		return item, nil, developerFailure("TOOLS_UNMANAGED_WORKTREE", 403)
	}
	dir, err := workspaceOpenDirectory(repo, item.Path)
	if err != nil {
		return item, nil, developerFailure("TOOLS_UNSAFE_PATH", 403)
	}
	defer dir.Close()
	items, err := developerWorktreeList(ctx, repo)
	if err != nil {
		return item, nil, err
	}
	valid := slices.ContainsFunc(items, func(entry developerGitWorktree) bool {
		return entry.path == item.Path && entry.branch == item.Branch && !entry.locked && !entry.detached
	})
	if !valid {
		return item, nil, developerFailure("TOOLS_WORKTREE_CHANGED", 409)
	}
	if d.worktreeBusy == nil || d.worktreeBusy(ctx, item.Path) {
		return item, nil, developerFailure("TOOLS_WORKTREE_BUSY", 409)
	}
	changes, err := developerGit(ctx, item.Path, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching")
	if err != nil {
		return item, nil, err
	}
	if changes != "" {
		return item, nil, developerFailure("TOOLS_WORKTREE_DIRTY", 409)
	}
	return item, records, nil
}

type developerWorktreePreview struct{ cwd, id string }

func (d *developerTools) worktreesPreview(ctx context.Context, input developerInput) (any, error) {
	root, err := d.root()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	item, _, err := d.removableWorktree(ctx, root, input.Cwd, input.ID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"previewToken": d.putPreview("worktree", developerWorktreePreview{input.Cwd, input.ID}), "item": item, "preservesBranch": true}, nil
}

func (d *developerTools) worktreesRemove(ctx context.Context, root *os.Root, token string) (any, error) {
	value, err := d.consume("worktree", token)
	if err != nil {
		return nil, err
	}
	if d.terminalGate != nil {
		if !d.terminalGate.TryLock() {
			return nil, developerFailure("TOOLS_WORKTREE_BUSY", 409)
		}
		defer d.terminalGate.Unlock()
	}
	input := value.(developerWorktreePreview)
	item, records, err := d.removableWorktree(ctx, root, input.cwd, input.id)
	if err != nil {
		return nil, err
	}
	if _, err = developerGit(ctx, item.Project, "worktree", "remove", item.Path); err != nil {
		return nil, developerFailure("TOOLS_WORKTREE_CHANGED", 409)
	}
	records = slices.DeleteFunc(records, func(record developerWorktree) bool { return record.ID == item.ID && record.Project == item.Project })
	if err = developerSaveRegistry(root, records); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "branchPreserved": item.Branch}, nil
}

func developerWorktreeContains(worktree, cwd string) bool {
	if cwd == "" || !filepath.IsAbs(cwd) {
		return true
	}
	canonical, err := filepath.EvalSymlinks(cwd)
	return err != nil || workspaceWithin(canonical, worktree)
}

func (d *developerTools) worktreeUsage(c *conversation, terminals func() bool) func(context.Context, string) bool {
	return func(ctx context.Context, path string) bool {
		if c.bridge.current() == nil || terminals() || c.delivery == nil || c.scheduler == nil {
			return true
		}
		queued, err := c.delivery.list("")
		if err != nil {
			return true
		}
		for _, item := range queued {
			var params struct{ Cwd string }
			if json.Unmarshal(item.Params, &params) != nil || developerWorktreeContains(path, params.Cwd) {
				return true
			}
		}
		schedule, err := c.scheduler.read()
		if err != nil {
			return true
		}
		active := make(map[string]bool)
		for _, run := range schedule.Runs {
			if run.active() {
				active[run.JobID] = true
			}
		}
		for _, job := range schedule.Jobs {
			if (job.Enabled != nil && *job.Enabled || active[job.ID]) && developerWorktreeContains(path, job.Cwd) {
				return true
			}
		}
		seen := make(map[string]bool)
		cursor := ""
		for range 100 {
			var page struct {
				Data       []json.RawMessage
				NextCursor string
			}
			params := map[string]any{"limit": 100}
			if cursor != "" {
				params["cursor"] = cursor
			}
			if d.w.rpc(ctx, "thread/loaded/list", params, &page) != nil || page.Data == nil {
				return true
			}
			for _, raw := range page.Data {
				var id string
				if json.Unmarshal(raw, &id) != nil {
					var item struct{ ID string }
					_ = json.Unmarshal(raw, &item)
					id = item.ID
				}
				if id == "" {
					return true
				}
				var item struct{ Thread struct{ Cwd string } }
				if d.w.rpc(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": false}, &item) != nil || developerWorktreeContains(path, item.Thread.Cwd) {
					return true
				}
			}
			cursor = page.NextCursor
			if cursor == "" {
				return c.bridge.current() == nil || terminals()
			}
			if seen[cursor] {
				return true
			}
			seen[cursor] = true
		}
		return true
	}
}
