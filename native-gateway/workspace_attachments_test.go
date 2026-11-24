package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func attachmentFixtureRequest(mux http.Handler, method, endpoint string, q url.Values, body []byte, typ, origin string) *httptest.ResponseRecorder {
	const local = "http://127.0.0.1:1337"
	r := httptest.NewRequest(method, local+endpoint+"?"+q.Encode(), bytes.NewReader(body))
	r.Header.Set("Origin", origin)
	r.Header.Set("Content-Type", typ)
	r.Header.Set("X-Workspace-Request", "1")
	r = r.WithContext(context.WithValue(r.Context(), requestAuthKey{}, authResult{ok: true, origin: local}))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

func TestWorkspaceAttachmentsLifecycle(t *testing.T) {
	s, project, _ := workspaceFixture(t)
	mux := http.NewServeMux()
	s.register(mux)
	const local = "http://127.0.0.1:1337"
	query := url.Values{"cwd": {project}, "name": {"agent's draft.txt"}}
	up := func(origin, typ string, q url.Values, body []byte) *httptest.ResponseRecorder {
		return attachmentFixtureRequest(mux, "POST", "/api/attachments/upload", q, body, typ, origin)
	}
	const binary = "application/octet-stream"
	for _, response := range []*httptest.ResponseRecorder{up("", binary, query, []byte("notes")), up(local, "text/plain", query, []byte("notes"))} {
		if response.Code != 403 {
			t.Fatalf("unauthorized upload: %d %s", response.Code, response.Body)
		}
	}
	response := up(local, binary, url.Values{"cwd": {project}, "name": {"../draft.txt"}}, []byte("notes"))
	if response.Code != 400 {
		t.Fatalf("invalid name: %d %s", response.Code, response.Body)
	}
	response = up(local, binary, query, []byte("notes"))
	var item workspaceAttachment
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &item) != nil || !attachmentID.MatchString(item.ID) || item.Path != "" || item.Bytes != 5 || item.Image {
		t.Fatalf("upload: %d %s", response.Code, response.Body)
	}
	metadata := filepath.Join(s.attachments.path, item.ID, "metadata.json")
	privateFile, err := desktopOpen(metadata, os.O_RDONLY, desktopStateLimit, true)
	if err != nil {
		t.Fatalf("metadata permissions: %v", err)
	}
	privateFile.Close()
	get := func(path string, q url.Values) *httptest.ResponseRecorder {
		return workspaceRequest(mux, "GET", "/api/attachments"+path, q, "", "")
	}
	byID := url.Values{"id": {item.ID}, "view": {"image"}}
	response = get("/file", byID)
	if response.Code != 200 || response.Body.String() != "notes" || response.Header().Get("Content-Type") != binary ||
		!strings.Contains(response.Header().Get("Content-Disposition"), "agent%27s%20draft.txt") || response.Header().Get("Content-Security-Policy") != "default-src 'none'; sandbox" {
		t.Fatalf("download: %d %s %v", response.Code, response.Body, response.Header())
	}
	if response := get("/preview", byID); response.Code != 200 || !strings.Contains(response.Body.String(), `"text":"notes"`) {
		t.Fatalf("preview: %d %s", response.Code, response.Body)
	}
	conversation := url.Values{"cwd": {project}, "scope": {"conversation"}, "threadId": {"thread-fixture"}}
	if response := get("", conversation); response.Code != 200 || !strings.Contains(response.Body.String(), `"items":[]`) {
		t.Fatalf("unbound list: %d %s", response.Code, response.Body)
	}
	resolve := func(value any) *httptest.ResponseRecorder {
		payload, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return attachmentFixtureRequest(mux, "POST", "/api/attachments/resolve", nil, payload, "application/json", local)
	}
	if response := resolve(map[string]any{"cwd": s.home, "ids": []string{item.ID}}); response.Code != 400 {
		t.Fatalf("cross-project resolution: %d %s", response.Code, response.Body)
	}
	if response := resolve(map[string]any{"cwd": project, "ids": []string{item.ID, item.ID}}); response.Code != 400 {
		t.Fatalf("duplicate attachment IDs: %d %s", response.Code, response.Body)
	}
	response = resolve(map[string]any{"cwd": project, "ids": []string{item.ID}})
	contentPath, _ := json.Marshal(filepath.Join(s.attachments.path, item.ID, "content.txt"))
	if response.Code != 200 || !strings.Contains(response.Body.String(), string(contentPath)) {
		t.Fatalf("resolution: %d %s", response.Code, response.Body)
	}
	for range 2 {
		if err := s.attachments.bind(t.Context(), []string{item.ID}, project, "thread-fixture"); err != nil {
			t.Fatal(err)
		}
	}
	if response := get("", conversation); response.Code != 200 || !strings.Contains(response.Body.String(), item.ID) || strings.Contains(response.Body.String(), `"path"`) {
		t.Fatalf("bound list: %d %s", response.Code, response.Body)
	}
	if response := get("", url.Values{"cwd": {project}, "query": {"no match"}}); response.Code != 200 || !strings.Contains(response.Body.String(), `"items":[]`) {
		t.Fatalf("filtered list: %d %s", response.Code, response.Body)
	}
	if response := get("/file", url.Values{"id": {"../metadata.json"}}); response.Code != 400 {
		t.Fatalf("invalid file id: %d %s", response.Code, response.Body)
	}
	if err := exposeTestFile(metadata); err != nil {
		t.Fatal(err)
	}
	if response := get("/file", byID); response.Code != 400 {
		t.Fatalf("public metadata accepted: %d %s", response.Code, response.Body)
	}
}

func TestQueueEditBindsImagesInCapturedProject(t *testing.T) {
	s, project, _ := workspaceFixture(t)
	mux := http.NewServeMux()
	s.register(mux)
	upload := func(cwd, name string, body []byte) workspaceAttachment {
		t.Helper()
		response := attachmentFixtureRequest(mux, "POST", "/api/attachments/upload", url.Values{"cwd": {cwd}, "name": {name}}, body, "application/octet-stream", "http://127.0.0.1:1337")
		var item workspaceAttachment
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &item) != nil {
			t.Fatalf("fixture upload: %d %s", response.Code, response.Body)
		}
		return item
	}
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10}
	original := upload(project, "Original.png", png)
	added := upload(project, "Added.png", png)
	other := upload(s.home, "Other.png", png)
	note := upload(project, "note.txt", []byte("notes"))
	q := newConversation(new(bridge), s.privateRoot, nil).delivery
	q.resolveCwd = func(cwd string) (string, error) {
		_, real, err := s.browse(cwd)
		return real, err
	}
	q.resolveAttachments = s.attachments.resolve
	path := func(item workspaceAttachment) string {
		return filepath.Join(s.attachments.path, item.ID, attachmentContentName(item.Name))
	}
	entry, err := q.mutate(t.Context(), "enqueue", conversationObject(map[string]any{
		"id": testSubmission, "threadId": "fixture-thread", "text": "",
		"params": map[string]any{"threadId": "fixture-thread", "cwd": project, "model": "fixture", "input": []map[string]string{
			{"type": "localImage", "path": path(original)},
			{"type": "skill", "name": "fixture", "path": filepath.Join(project, "SKILL.md")},
		}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if err := q.transaction(func(state *deliveryQueueState) (bool, error) {
		state.Entries[0].Claim = &q.owner
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	edit := func(version int, ids ...string) (deliveryQueueEntry, error) {
		return q.mutate(t.Context(), "edit", conversationObject(map[string]any{"id": entry.ID, "version": version, "text": "Added context", "attachmentIds": ids}))
	}
	for _, rejected := range []workspaceAttachment{other, note} {
		if _, err := edit(entry.Version, rejected.ID); err == nil {
			t.Fatalf("invalid image %s accepted", rejected.Name)
		}
		if _, err := os.Stat(filepath.Join(s.attachments.path, rejected.ID, attachmentLinkName(entry.ThreadID))); !os.IsNotExist(err) {
			t.Fatalf("invalid image %s was bound: %v", rejected.Name, err)
		}
	}
	updated, err := edit(entry.Version, original.ID, added.ID, added.ID)
	var saved struct {
		Model string
		Input []struct{ Type, Path, Text string }
	}
	if err != nil || json.Unmarshal(updated.Params, &saved) != nil || updated.Version != entry.Version+1 || saved.Model != "fixture" || len(saved.Input) != 4 ||
		saved.Input[0].Text != "Added context\nAttached file \"Added.png\": "+path(added) || saved.Input[1].Path != path(original) || saved.Input[2].Type != "skill" || saved.Input[3].Path != path(added) {
		t.Fatalf("queue edit lost captured parameters: %+v %v", saved, err)
	}
	if _, err := os.Stat(filepath.Join(s.attachments.path, added.ID, attachmentLinkName(entry.ThreadID))); err != nil {
		t.Fatal(err)
	}
	if claimed, err := q.updateClaim(entry.ID, func(*deliveryQueueRecord) bool { return true }); err != nil || claimed != nil {
		t.Fatalf("pre-edit dispatch claim retained: %v %v", claimed, err)
	}
	if _, err := edit(entry.Version); !conversationErrorIs(err, "QUEUE_CONFLICT") {
		t.Fatalf("stale edit lost compare-and-swap protection: %v", err)
	}
}

func TestWorkspaceAttachmentsLegacyRasterAndLock(t *testing.T) {
	s, project, _ := workspaceFixture(t)
	mux := http.NewServeMux()
	s.register(mux)
	const id = "84c776da-c199-4acd-b2c0-3a067602e8c2"
	const local = "http://127.0.0.1:1337"
	dir := filepath.Join(s.attachments.path, id)
	content := string([]byte{137, 80, 78, 71, 13, 10, 26, 10})
	workspaceFixtureWrite(t, dir, "content.png", content, 0600)
	legacy := workspaceAttachment{Format: 1, ID: id, Name: "画面.PNG", Cwd: project, Bytes: 8, Image: true, CreatedAt: "2026-11-19T11:00:00.000Z"}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	workspaceFixtureWrite(t, dir, "metadata.json", string(data), 0600)
	q := url.Values{"id": {id}, "view": {"image"}}
	response := workspaceRequest(mux, "GET", "/api/attachments/file", q, "", "")
	if response.Code != 200 || response.Header().Get("Content-Type") != "image/png" || response.Body.String() != content || !strings.Contains(response.Header().Get("Content-Disposition"), "%E7%94%BB%E9%9D%A2.PNG") {
		t.Fatalf("legacy image: %d %s %v", response.Code, response.Body, response.Header())
	}
	workspaceFixtureWrite(t, dir, "content.png", "notimage", 0600)
	response = workspaceRequest(mux, "GET", "/api/attachments/file", q, "", "")
	if response.Code != 200 || response.Header().Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("invalid raster must download: %d %v", response.Code, response.Header())
	}
	root, err := s.attachments.openRoot(false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	release, err := s.attachments.lock(root)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	response = attachmentFixtureRequest(mux, "POST", "/api/attachments/upload", url.Values{"cwd": {project}, "name": {"other.txt"}}, []byte("fixture"), "application/octet-stream", local)
	if response.Code != 409 {
		t.Fatalf("upload bypassed storage lock: %d %s", response.Code, response.Body)
	}
	release()
	bytes := make([]byte, attachmentMaxBytes+1)
	response = attachmentFixtureRequest(mux, "POST", "/api/attachments/upload", url.Values{"cwd": {project}, "name": {"large.txt"}}, bytes, "application/octet-stream", local)
	if response.Code != 413 {
		t.Fatalf("upload exceeded limit: %d %s", response.Code, response.Body)
	}
}
