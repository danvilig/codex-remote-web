package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWorkspaceDeveloperAgentsConfirmationAndConflict(t *testing.T) {
	s, project, outside := workspaceFixture(t)
	d := s.developer
	const local = "http://127.0.0.1:1337"
	mux := http.NewServeMux()
	s.register(mux)
	call := func(value developerInput, origin string, status int) map[string]any {
		t.Helper()
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		response := workspaceRequest(mux, "POST", "/api/settings/developer-tools", nil, string(body), origin)
		if response.Code != status {
			t.Fatalf("%s: %d %s", value.Action, response.Code, response.Body)
		}
		var out map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	call(developerInput{Action: "agents.read", Cwd: project}, "", 403)
	call(developerInput{Action: "agents.read", Cwd: outside}, local, 400)
	workspaceFixtureWrite(t, s.privateRoot, "AGENTS.md", "global fixture", 0600)
	initial := call(developerInput{Action: "agents.read", Cwd: project}, local, 200)
	if initial["revision"] != "missing" || initial["exists"] != false {
		t.Fatalf("initial state: %v", initial)
	}
	if records, ok := initial["inherited"].([]any); !ok || len(records) != 1 {
		t.Fatalf("inherited metadata: %v", initial)
	}
	preview := call(developerInput{Action: "agents.preview", Cwd: project, Revision: "missing", Text: new("# project\n")}, local, 200)
	if preview["creating"] != true {
		t.Fatalf("missing preview: %v", preview)
	}
	input := developerInput{Action: "agents.save", PreviewToken: preview["previewToken"].(string)}
	saved := call(input, local, 200)
	if saved["text"] != "# project\n" || saved["ok"] != true {
		t.Fatalf("saved: %v", saved)
	}
	if result := call(input, local, 409); result["code"] != "TOOLS_PREVIEW_EXPIRED" {
		t.Fatalf("replay: %v", result)
	}
	preview = call(developerInput{Action: "agents.preview", Cwd: project, Revision: saved["revision"].(string), Text: new("new")}, local, 200)
	workspaceFixtureWrite(t, project, "AGENTS.md", "external", 0600)
	input.PreviewToken = preview["previewToken"].(string)
	if result := call(input, local, 409); result["code"] != "TOOLS_FILE_CONFLICT" {
		t.Fatalf("conflict: %v", result)
	}
	data, err := os.ReadFile(filepath.Join(project, "AGENTS.md"))
	if err != nil || string(data) != "external" {
		t.Fatalf("external edit overwritten: %q %v", data, err)
	}
	workspaceFixtureWrite(t, outside, "external.txt", "private", 0600)
	if err := os.Remove(filepath.Join(project, "AGENTS.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "external.txt"), filepath.Join(project, "AGENTS.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := d.agentsRead(project); desktopErrorCode(err) != "TOOLS_FILE_UNSAFE" {
		t.Fatalf("linked project file: %v", err)
	}
}

func TestWorkspaceDeveloperManagedWorktreePreservesBranch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Fatal(err)
	}
	s, project, _ := workspaceFixture(t)
	d := s.developer
	git := func(cwd string, args ...string) string {
		t.Helper()
		out, err := developerGit(t.Context(), cwd, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return strings.TrimSpace(out)
	}
	git(project, "init", "-q")
	git(project, "config", "user.email", "fixture@example.invalid")
	git(project, "config", "user.name", "Fixture")
	git(project, "config", "commit.gpgsign", "false")
	workspaceFixtureWrite(t, project, "seed.txt", "seed", 0600)
	git(project, "add", "seed.txt")
	git(project, "commit", "-qm", "initial")
	created, err := d.action(t.Context(), developerInput{Action: "worktrees.create", Cwd: project})
	if err != nil {
		t.Fatal(err)
	}
	item := created.(map[string]any)["item"].(developerWorktree)
	if item.Path != filepath.Join(project, ".codex-remote-web", "worktrees", item.ID) || git(project, "status", "--porcelain") != "" {
		t.Fatalf("managed checkout: %+v", item)
	}
	working := false
	d.worktreeBusy = func(context.Context, string) bool { return working }
	preview := func() (any, error) {
		return d.action(t.Context(), developerInput{Action: "worktrees.preview-remove", Cwd: project, ID: item.ID})
	}
	working = true
	if _, err := preview(); desktopErrorCode(err) != "TOOLS_WORKTREE_BUSY" {
		t.Fatalf("occupied tree: %v", err)
	}
	working = false
	p, err := preview()
	if err != nil {
		t.Fatal(err)
	}
	remove := func(p any) (any, error) {
		return d.action(t.Context(), developerInput{Action: "worktrees.remove", PreviewToken: p.(map[string]any)["previewToken"].(string)})
	}
	workspaceFixtureWrite(t, item.Path, "untracked.txt", "draft", 0600)
	if _, err := remove(p); desktopErrorCode(err) != "TOOLS_WORKTREE_DIRTY" {
		t.Fatalf("dirty worktree: %v", err)
	}
	if err := os.Remove(filepath.Join(item.Path, "untracked.txt")); err != nil {
		t.Fatal(err)
	}
	p, err = preview()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := remove(p); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(item.Path); !os.IsNotExist(err) {
		t.Fatalf("checkout remains: %v", err)
	}
	if git(project, "rev-parse", "--verify", item.Branch) != git(project, "rev-parse", "HEAD") {
		t.Fatal("branch was not preserved")
	}
}

func TestWorkspaceDeveloperCleanupRechecksReferences(t *testing.T) {
	s, project, _ := workspaceFixture(t)
	d := s.developer
	old := time.Now().Add(-48 * time.Hour)
	makeItem := func() string {
		t.Helper()
		id := workspaceUUID()
		dir := filepath.Join(s.attachments.path, id)
		item := workspaceAttachment{Format: 1, ID: id, Name: "old.txt", Cwd: project, Bytes: 5, CreatedAt: workspaceISODate(old)}
		data, err := json.Marshal(item)
		if err != nil {
			t.Fatal(err)
		}
		workspaceFixtureWrite(t, dir, "metadata.json", string(data), 0600)
		workspaceFixtureWrite(t, dir, "content.txt", "notes", 0600)
		for _, name := range []string{"metadata.json", "content.txt"} {
			if err := os.Chtimes(filepath.Join(dir, name), old, old); err != nil {
				t.Fatal(err)
			}
		}
		return id
	}
	unbound, queued, bound := makeItem(), makeItem(), makeItem()
	protected := map[string]bool{queued: true}
	d.protectedAttachments = func() (map[string]bool, error) { return protected, nil }
	if err := s.attachments.bind(t.Context(), []string{bound}, project, "fixture-thread"); err != nil {
		t.Fatal(err)
	}
	workspaceFixtureWrite(t, s.privateRoot, "auth.json", "keep", 0600)
	preview := func() string {
		t.Helper()
		value, err := d.action(t.Context(), developerInput{Action: "cleanup.preview"})
		if err != nil {
			t.Fatal(err)
		}
		result := value.(map[string]any)
		items := result["items"].([]developerCleanupCandidate)
		if len(items) != 1 || items[0].ID != unbound {
			t.Fatalf("cleanup candidates: %+v", items)
		}
		return result["previewToken"].(string)
	}
	token := preview()
	execute := func(token string) (any, error) {
		return d.action(t.Context(), developerInput{Action: "cleanup.execute", PreviewToken: token})
	}
	protected[unbound] = true
	if _, err := execute(token); desktopErrorCode(err) != "TOOLS_CLEANUP_CHANGED" {
		t.Fatalf("new reference: %v", err)
	}
	delete(protected, unbound)
	result, err := execute(preview())
	if err != nil || result.(map[string]any)["removed"] != 1 {
		t.Fatalf("cleanup: %v %v", result, err)
	}
	if _, err := os.Stat(filepath.Join(s.attachments.path, unbound)); !os.IsNotExist(err) {
		t.Fatalf("old upload remains: %v", err)
	}
	for _, path := range []string{filepath.Join(s.attachments.path, queued), filepath.Join(s.attachments.path, bound), filepath.Join(s.privateRoot, "auth.json"), filepath.Join(s.attachments.path, "upload.lock.sqlite")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("protected file removed: %s %v", path, err)
		}
	}
}

func TestWorkspaceDeveloperMCPInventoryOnlyReturnsPublicFields(t *testing.T) {
	s, project, _ := workspaceFixture(t)
	socket, peers := fixture(t)
	s.bridge = new(bridge)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go s.bridge.run(ctx, socket, "fixture", time.Second)
	peer := acceptSession(t, peers, s.bridge)
	type response struct {
		result any
		err    error
	}
	pending := make(chan response, 1)
	go func() {
		result, err := s.developer.action(ctx, developerInput{Action: "mcp.inventory", Cwd: project, ThreadID: "fixture-thread"})
		pending <- response{result, err}
	}()
	for i, cursor := range []string{"next", ""} {
		req := getRequest(t, peer)
		if req.Method != "mcpServerStatus/list" || !strings.Contains(string(req.Params), `"threadId":"fixture-thread"`) ||
			(i == 1 && !strings.Contains(string(req.Params), `"cursor":"next"`)) {
			t.Fatalf("inventory request: %+v", req)
		}
		sendResult(t, peer, req.ID, map[string]any{
			"data":       []any{map[string]any{"name": "demo", "authStatus": "oAuth", "runtimeStatus": "connected", "secret": "FIXTURE_TOKEN", "resources": []any{map[string]any{"name": "fixture", "uri": "https://example.invalid/FIXTURE_TOKEN"}}}},
			"nextCursor": cursor,
		})
	}
	got := next(t, pending)
	if got.err != nil {
		t.Fatal(got.err)
	}
	result := got.result.(map[string]any)
	data, err := json.Marshal(result)
	if err != nil || len(result["servers"].([]map[string]any)) != 2 || result["readOnly"] != true || result["partial"] != false || strings.Contains(string(data), "FIXTURE_TOKEN") {
		t.Fatalf("inventory: %s %v", data, err)
	}
}
