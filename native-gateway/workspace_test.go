package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func workspaceFixture(t *testing.T) (*workspace, string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	project, outside := filepath.Join(root, "home", "project"), filepath.Join(root, "outside")
	for _, path := range []string{project, outside} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	profile := filepath.Join(root, "home", "profile")
	if err := makePrivateDirectory(profile); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", profile)
	t.Setenv("CODEX_AUTH_PATH", filepath.Join(project, "private.txt"))
	t.Setenv("CODEX_WEBUI_AUTH_STORE", filepath.Join(project, "second-private.txt"))
	t.Setenv("CODEX_WEBUI_DOWNLOAD_ROOTS", "")
	s, err := newWorkspace(filepath.Dir(project), project, nil)
	if err != nil {
		t.Fatal(err)
	}
	return s, project, outside
}

func workspaceFixtureWrite(t *testing.T, dir, file, data string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, file)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, file), []byte(data), mode); err != nil {
		t.Fatal(err)
	}
}

func workspaceRequest(h http.Handler, method, path string, q url.Values, body, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:1337"+path+"?"+q.Encode(), strings.NewReader(body))
	if origin != "" {
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json; charset=utf-8")
		r.Header.Set("X-Workspace-Request", "1")
	}
	r = r.WithContext(context.WithValue(r.Context(), requestAuthKey{}, authResult{ok: true, origin: "http://127.0.0.1:1337"}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

type slowDownloadResponse struct {
	http.ResponseWriter
	delay time.Duration
}

func (w slowDownloadResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w slowDownloadResponse) Write(data []byte) (int, error) {
	time.Sleep(w.delay)
	return w.ResponseWriter.Write(data)
}

func TestWorkspaceDownloadOutlastsServerWriteTimeout(t *testing.T) {
	s, project, _ := workspaceFixture(t)
	const timeout = 500 * time.Millisecond
	content := strings.Repeat("Slow download fixture\n", 5000)
	workspaceFixtureWrite(t, project, "result.txt", content, 0600)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.download(slowDownloadResponse{w, timeout + 100*time.Millisecond}, r)
	}))
	server.Config.WriteTimeout = timeout
	server.Start()
	defer server.Close()
	client := server.Client()
	client.Timeout = 10 * time.Second
	response, err := client.Get(server.URL + "/api/files/download?path=result.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK || string(data) != content {
		t.Fatalf("download HTTP %d: read %d of %d bytes (%v)", response.StatusCode, len(data), len(content), err)
	}
}

func TestWorkspaceRootsAndPrivateFiles(t *testing.T) {
	s, project, outside := workspaceFixture(t)
	for _, name := range []string{"agent's result.txt", ".env", "private.txt", "second-private.txt", ".git/config", "profile-key.PEM"} {
		workspaceFixtureWrite(t, project, name, "fixture", 0600)
	}
	workspaceFixtureWrite(t, outside, "outside.txt", "outside", 0600)
	workspaceFixtureWrite(t, s.privateRoot, "credentials.txt", "private root", 0600)
	if err := os.Link(filepath.Join(project, "private.txt"), filepath.Join(project, "private-alias.txt")); err != nil {
		t.Fatal(err)
	}
	for name, target := range map[string]string{"link.txt": filepath.Join(outside, "outside.txt"), "outside-dir": outside, "profile-alias": s.privateRoot} {
		if err := os.Symlink(target, filepath.Join(project, name)); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	s.register(mux)
	for _, file := range []string{".env", "private.txt", "private-alias.txt", "second-private.txt", ".git/config", "profile-key.PEM", "link.txt", "outside-dir/outside.txt", "profile-alias/credentials.txt", filepath.Join(outside, "outside.txt")} {
		result := workspaceRequest(mux, "GET", "/api/files/download", url.Values{"path": {file}, "cwd": {project}}, "", "")
		if result.Code != 404 {
			t.Fatalf("protected file %s: %d %s", file, result.Code, result.Body)
		}
	}
	result := workspaceRequest(mux, "GET", "/api/files/download", url.Values{"path": {"agent's result.txt"}, "cwd": {project}}, "", "")
	if result.Code != 200 || result.Body.String() != "fixture" || !strings.Contains(result.Header().Get("Content-Disposition"), "filename*=UTF-8''agent%27s%20result.txt") {
		t.Fatalf("download: %d %s %s", result.Code, result.Header().Get("Content-Disposition"), result.Body)
	}
	for _, path := range []string{"/api/workspace/context", "/api/files/search", "/api/library"} {
		result := workspaceRequest(mux, "GET", path, url.Values{"cwd": {outside}, "query": {"outside"}}, "", "")
		if result.Code != 400 {
			t.Fatalf("outside cwd on %s: %d %s", path, result.Code, result.Body)
		}
	}
	result = workspaceRequest(mux, "GET", "/api/library", url.Values{"cwd": {project}}, "", "")
	if result.Code != 200 || !strings.Contains(result.Body.String(), "agent's result.txt") || strings.Contains(result.Body.String(), "private.txt") || strings.Contains(result.Body.String(), ".env") {
		t.Fatalf("library: %d %s", result.Code, result.Body)
	}
	result = workspaceRequest(mux, "GET", "/api/library/preview", url.Values{"path": {filepath.Join(project, "agent's result.txt")}}, "", "")
	if result.Code != 200 || !strings.Contains(result.Body.String(), `"text":"fixture"`) {
		t.Fatalf("preview: %d %s", result.Code, result.Body)
	}
}

func TestWorkspaceSettingsSendsVersionedNativeEdits(t *testing.T) {
	s, _, _ := workspaceFixture(t)
	socket, peers := fixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	s.bridge = new(bridge)
	go s.bridge.run(ctx, socket, "fixture", time.Second)
	peer := acceptSession(t, peers, s.bridge)
	mux := http.NewServeMux()
	s.register(mux)
	const local = "http://127.0.0.1:1337"
	call := func(method, body string) <-chan *httptest.ResponseRecorder {
		reply := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			r := httptest.NewRequest(method, local+"/api/settings", strings.NewReader(body))
			r.Header.Set("Origin", local)
			r.Header.Set("Content-Type", "application/json")
			r = r.WithContext(context.WithValue(ctx, requestAuthKey{}, authResult{ok: true, origin: local}))
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			reply <- w
		}()
		return reply
	}
	config := func(version, policy string) {
		req := getRequest(t, peer)
		if req.Method != "config/read" || !strings.Contains(string(req.Params), `"includeLayers":true`) {
			t.Fatalf("native config read: %+v", req)
		}
		sendResult(t, peer, req.ID, map[string]any{
			"config": map[string]any{"approval_policy": policy, "private_data": "sensitive fixture"},
			"layers": []map[string]any{{"name": map[string]string{"type": "user"}, "version": version, "private_data": "sensitive fixture"}},
		})
	}
	pending := call("GET", "")
	config("v1", "on-request")
	response := next(t, pending)
	if response.Code != 200 || strings.Contains(response.Body.String(), "sensitive fixture") || !strings.Contains(response.Body.String(), `"version":"v1"`) {
		t.Fatalf("public settings: %d %s", response.Code, response.Body)
	}
	pending = call("PUT", `{"version":"stale","values":{"approval_policy":"never"}}`)
	config("v1", "on-request")
	if response := next(t, pending); response.Code != 409 {
		t.Fatalf("stale settings: %d %s", response.Code, response.Body)
	}
	pending = call("PUT", `{"version":"v1","values":{"approval_policy":"never"}}`)
	config("v1", "on-request")
	req := getRequest(t, peer)
	if req.Method != "config/batchWrite" || !strings.Contains(string(req.Params), `"expectedVersion":"v1"`) ||
		!strings.Contains(string(req.Params), `"keyPath":"approval_policy"`) || !strings.Contains(string(req.Params), `"reloadUserConfig":false`) {
		t.Fatalf("native config write: %+v", req)
	}
	sendResult(t, peer, req.ID, map[string]string{"status": "okOverridden"})
	config("v2", "never")
	response = next(t, pending)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"overridden":true`) || !strings.Contains(response.Body.String(), `"version":"v2"`) {
		t.Fatalf("updated settings: %d %s", response.Code, response.Body)
	}
	if response := next(t, call("PUT", `{"version":"v2","values":{"not_allowed":"fixture"}}`)); response.Code != 400 {
		t.Fatalf("unknown setting: %d %s", response.Code, response.Body)
	}
}

func TestWorkspaceLibraryPaginationAndImagePolicy(t *testing.T) {
	s, project, _ := workspaceFixture(t)
	for i := range 105 {
		workspaceFixtureWrite(t, project, fmt.Sprintf("assets/%03d.png", i), "image data", 0600)
	}
	workspaceFixtureWrite(t, project, "assets/unsafe.svg", "<svg></svg>", 0600)
	mux := http.NewServeMux()
	s.register(mux)
	values := url.Values{"cwd": {project}, "images": {"true"}}
	for i, page := range []struct {
		count int
		next  *int
	}{{100, new(100)}, {5, nil}} {
		var result struct {
			Items      []workspaceEntry
			NextCursor *int
		}
		r := workspaceRequest(mux, "GET", "/api/library", values, "", "")
		if r.Code != 200 || json.Unmarshal(r.Body.Bytes(), &result) != nil || len(result.Items) != page.count ||
			(result.NextCursor == nil) != (page.next == nil) || (page.next != nil && *result.NextCursor != *page.next) {
			t.Fatalf("library page %d: %d %s", i, r.Code, r.Body)
		}
		if page.next != nil {
			values.Set("cursor", fmt.Sprint(*page.next))
		}
	}
	r := workspaceRequest(mux, "GET", "/api/images/local", url.Values{"path": {"assets/unsafe.svg"}}, "", "")
	if r.Code != 404 {
		t.Fatalf("active image accepted: %d", r.Code)
	}
	r = workspaceRequest(mux, "GET", "/api/images/local", url.Values{"path": {"assets/000.png"}}, "", "")
	if r.Code != 200 || r.Header().Get("Content-Type") != "image/png" || r.Header().Get("Cross-Origin-Resource-Policy") != "same-origin" {
		t.Fatalf("image: %d %v", r.Code, r.Header())
	}
}

func TestWorkspaceDocumentVersionPermissionsAndOrigin(t *testing.T) {
	s, project, _ := workspaceFixture(t)
	const document = "notes.txt"
	const orig = "\uFEFFalpha\r\nbeta\n"
	workspaceFixtureWrite(t, project, document, orig, 0640)
	mux := http.NewServeMux()
	s.register(mux)
	request := func(method, path, text, revision, origin string) *httptest.ResponseRecorder {
		body, err := json.Marshal(map[string]string{"cwd": project, "path": path, "text": text, "revision": revision})
		if err != nil {
			t.Fatal(err)
		}
		return workspaceRequest(mux, method, "/api/files/document", url.Values{"cwd": {project}, "path": {path}}, string(body), origin)
	}
	var doc workspaceDocument
	r := request("GET", document, "", "", "")
	if r.Code != 200 || json.Unmarshal(r.Body.Bytes(), &doc) != nil || doc.Text != orig || !doc.Writable || doc.Revision != workspaceRevision([]byte(orig)) {
		t.Fatalf("document read: %d %s", r.Code, r.Body)
	}
	const local = "http://127.0.0.1:1337"
	for _, invalid := range []struct {
		origin, revision, text, code string
		status                       int
	}{
		{"", doc.Revision, "unexpected", "FILE_ORIGIN_REQUIRED", 403},
		{"https://example.test", doc.Revision, "unexpected", "FILE_ORIGIN_REQUIRED", 403},
		{local, workspaceRevision([]byte("stale")), "unexpected", "FILE_CONFLICT", 409},
		{local, doc.Revision, strings.Repeat("a", workspaceTextLimit+1), "FILE_TOO_LARGE", 413},
	} {
		r := request("POST", document, invalid.text, invalid.revision, invalid.origin)
		if r.Code != invalid.status || !strings.Contains(r.Body.String(), invalid.code) {
			t.Fatalf("save rejection: %d %s", r.Code, r.Body)
		}
	}
	const updated = "\uFEFFupdated\r\n"
	r = request("POST", document, updated, doc.Revision, local)
	if r.Code != 200 || !strings.Contains(r.Body.String(), workspaceRevision([]byte(updated))) {
		t.Fatalf("save: %d %s", r.Code, r.Body)
	}
	info, err := os.Stat(filepath.Join(project, document))
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0640) {
		t.Fatalf("mode after save: %v %v", info, err)
	}
	read, err := os.ReadFile(filepath.Join(project, document))
	if err != nil || string(read) != updated {
		t.Fatalf("bytes after save: %q %v", read, err)
	}
	if err := os.Link(filepath.Join(project, document), filepath.Join(project, "hard.txt")); err != nil {
		t.Fatal(err)
	}
	r = request("POST", document, "unexpected", workspaceRevision(read), local)
	if r.Code != 403 || !strings.Contains(r.Body.String(), "FILE_READ_ONLY") {
		t.Fatalf("linked file save: %d %s", r.Code, r.Body)
	}
	if err := os.Symlink(document, filepath.Join(project, "link.txt")); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{"link.txt", "missing/../notes.txt"} {
		if r := request("GET", file, "", "", ""); r.Code != 400 || !strings.Contains(r.Body.String(), "FILE_UNAVAILABLE") {
			t.Fatalf("read %s: %d %s", file, r.Code, r.Body)
		}
	}
}

func TestWorkspaceStorageDoesNotFollowLinks(t *testing.T) {
	s, _, outside := workspaceFixture(t)
	workspaceFixtureWrite(t, s.privateRoot, "sessions/thread.jsonl", "1234", 0600)
	workspaceFixtureWrite(t, s.privateRoot, "logs/boot.log", "12", 0600)
	workspaceFixtureWrite(t, outside, "other.txt", "unrelated bytes", 0600)
	if err := os.Symlink(outside, filepath.Join(s.privateRoot, "sessions", "outside")); err != nil {
		t.Fatal(err)
	}
	usage := workspaceStorageUsage(t.Context(), s.privateRoot, 100, time.Second)
	if usage.TotalBytes != 6 || usage.Groups["sessions"] != 4 || usage.Groups["logs"] != 2 || usage.Partial || usage.MeasuredAt == "" {
		t.Fatalf("unexpected usage: %+v", usage)
	}
	if !workspaceStorageUsage(t.Context(), s.privateRoot, 1, time.Second).Partial {
		t.Fatal("limited scan reported complete")
	}
}

func TestWorkspaceSkillInstallIsScopedAndExclusive(t *testing.T) {
	s, project, outside := workspaceFixture(t)
	source := filepath.Join(project, "source")
	const manifest = "---\nname: demo\ndescription: Test\n---\nDo the fixture task.\n"
	workspaceFixtureWrite(t, source, "SKILL.md", manifest, 0600)
	workspaceFixtureWrite(t, source, "scripts/run.sh", "exit 0", 0755)
	workspaceFixtureWrite(t, source, ".env", "not copied", 0600)
	workspaceFixtureWrite(t, source, "auth.json", "not copied", 0600)
	workspaceFixtureWrite(t, outside, "outside.txt", "unrelated", 0600)
	if err := os.Symlink(filepath.Join(outside, "outside.txt"), filepath.Join(source, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.installSkill(t.Context(), source); err == nil {
		t.Fatal("an install with a source link succeeded")
	}
	if _, err := os.Stat(filepath.Join(s.privateRoot, "skills", "demo")); !os.IsNotExist(err) {
		t.Fatalf("failed install exposed a destination: %v", err)
	}
	if err := os.Remove(filepath.Join(source, "link.txt")); err != nil {
		t.Fatal(err)
	}
	path, err := s.installSkill(t.Context(), source)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != manifest {
		t.Fatalf("manifest: %q %v", data, err)
	}
	dir := filepath.Dir(path)
	for _, name := range []string{".env", "auth.json"} {
		if _, err := os.Lstat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("private file %s: %v", name, err)
		}
	}
	info, err := os.Stat(filepath.Join(dir, "scripts", "run.sh"))
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0700) {
		t.Fatalf("script mode: %v %v", info, err)
	}
	if _, err := s.installSkill(t.Context(), source); err == nil {
		t.Fatal("duplicate installation overwrote an existing skill")
	}
	parent, name, _, err := s.managedSkill(path, project)
	if err != nil || name != "demo" {
		t.Fatalf("managed skill: %s %v", name, err)
	}
	parent.Close()
	if _, _, _, err := s.managedSkill(filepath.Join(source, "SKILL.md"), project); err == nil {
		t.Fatal("a source skill was marked removable")
	}
	if err := os.Symlink(outside, filepath.Join(project, ".agents")); err != nil {
		t.Fatal(err)
	}
	workspaceFixtureWrite(t, outside, "skills/demo/SKILL.md", manifest, 0600)
	if parent, _, _, err := s.managedSkill(filepath.Join(outside, "skills/demo/SKILL.md"), project); err == nil {
		parent.Close()
		t.Fatal("a redirected outside skill was marked removable")
	}
}
