package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
)

const (
	attachmentMaxBytes = 20 << 20
	attachmentMaxTotal = 200 << 20
	attachmentMaxCount = 1000
)

var attachmentID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var attachmentTooLarge = errors.New("attachment exceeds storage limits")

type workspaceAttachments struct {
	workspace *workspace
	path      string
}

type workspaceAttachment struct {
	Format    int    `json:"format"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	Cwd       string `json:"cwd"`
	Bytes     int64  `json:"bytes"`
	Image     bool   `json:"image"`
	CreatedAt string `json:"createdAt"`
	Path      string `json:"path,omitempty"`
}

func attachmentFilename(name string) bool {
	if strings.TrimSpace(name) == "" || name == "." || name == ".." || len(utf16.Encode([]rune(name))) > 240 {
		return false
	}
	return !strings.ContainsFunc(name, func(r rune) bool { return r < 32 || r == 127 || r == '/' || r == '\\' })
}

func attachmentContentName(name string) string {
	extension := ""
	if dot := strings.LastIndexByte(name, '.'); dot > 0 {
		extension = name[dot:]
	}
	var ext strings.Builder
	for _, char := range strings.ToLower(extension) {
		if char == '.' || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			ext.WriteRune(char)
			if ext.Len() >= 16 {
				break
			}
		}
	}
	return "content" + ext.String()
}

func attachmentImage(head []byte, name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png":
		return bytes.HasPrefix(head, []byte{137, 80, 78, 71, 13, 10, 26, 10})
	case ".jpg", ".jpeg":
		return bytes.HasPrefix(head, []byte{255, 216, 255})
	case ".gif":
		return bytes.HasPrefix(head, []byte("GIF87a")) || bytes.HasPrefix(head, []byte("GIF89a"))
	case ".webp":
		return len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP"
	}
	return false
}

func attachmentPrivate(info os.FileInfo) bool {
	return desktopOwned(info) && info.Mode().Perm()&0077 == 0
}

func (a *workspaceAttachments) openRoot(create bool) (*os.Root, error) {
	if create {
		if err := os.MkdirAll(a.workspace.privateRoot, 0700); err != nil {
			return nil, err
		}
	}
	canonical, err := filepath.EvalSymlinks(a.workspace.privateRoot)
	if err != nil {
		return nil, err
	}
	parent, err := workspaceOpenDirectory(canonical, canonical)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	if info, err := parent.Stat("."); err != nil || !desktopOwned(info) || info.Mode().Perm()&0022 != 0 {
		return nil, workspaceUnavailable
	}
	name := filepath.Base(a.path)
	if create {
		if err := parent.Mkdir(name, 0700); err != nil && !os.IsExist(err) {
			return nil, err
		}
	}
	return attachmentOpenDir(parent, name)
}

func attachmentOpenDir(root *os.Root, name string) (*os.Root, error) {
	before, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() || !attachmentPrivate(before) {
		return nil, workspaceUnavailable
	}
	dir, err := root.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	if info, err := dir.Stat("."); err != nil || !attachmentPrivate(info) || !os.SameFile(before, info) {
		dir.Close()
		return nil, workspaceUnavailable
	}
	return dir, nil
}

func attachmentOpenFile(root *os.Root, name string, limit int64) (*os.File, os.FileInfo, error) {
	before, err := root.Lstat(name)
	if err != nil {
		return nil, nil, err
	}
	if !before.Mode().IsRegular() || !attachmentPrivate(before) {
		return nil, nil, workspaceUnavailable
	}
	f, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil || !os.SameFile(before, info) || !attachmentPrivate(info) || info.Size() > limit || info.Sys().(*syscall.Stat_t).Nlink != 1 {
		f.Close()
		return nil, nil, workspaceUnavailable
	}
	return f, info, nil
}

func attachmentReadJSON(root *os.Root, name string, limit int64, target any) error {
	f, _, err := attachmentOpenFile(root, name, limit)
	if err != nil {
		return err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(data)) > limit {
		return workspaceUnavailable
	}
	return json.Unmarshal(data, target)
}

func attachmentWriteJSON(root *os.Root, name string, target any) error {
	data, err := json.Marshal(target)
	if err != nil {
		return err
	}
	f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	return errors.Join(err, f.Close())
}

func attachmentRecord(dir *os.Root, id string) (workspaceAttachment, error) {
	var meta workspaceAttachment
	if err := attachmentReadJSON(dir, "metadata.json", 16384, &meta); err != nil {
		return meta, err
	}
	if meta.Format != 1 || meta.ID != id || !attachmentFilename(meta.Name) || !filepath.IsAbs(meta.Cwd) || meta.Bytes < 0 || meta.Bytes > attachmentMaxBytes {
		return meta, workspaceUnavailable
	}
	meta.Path = ""
	return meta, nil
}

func (a *workspaceAttachments) openContent(root *os.Root, id string) (workspaceAttachment, *os.Root, *os.File, error) {
	var meta workspaceAttachment
	if !attachmentID.MatchString(id) {
		return meta, nil, nil, workspaceUnavailable
	}
	dir, err := attachmentOpenDir(root, id)
	if err != nil {
		return meta, nil, nil, err
	}
	meta, err = attachmentRecord(dir, id)
	if err != nil {
		dir.Close()
		return meta, nil, nil, err
	}
	f, info, err := attachmentOpenFile(dir, attachmentContentName(meta.Name), attachmentMaxBytes)
	if err != nil {
		dir.Close()
		return meta, nil, nil, err
	}
	if info.Size() != meta.Bytes {
		f.Close()
		dir.Close()
		return meta, nil, nil, workspaceUnavailable
	}
	if meta.Image {
		var head [16]byte
		n, _ := f.ReadAt(head[:], 0)
		meta.Image = attachmentImage(head[:n], meta.Name)
	}
	return meta, dir, f, nil
}

func attachmentIDsOnDisk(root *os.Root) ([]string, error) {
	dir, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	ids := make([]string, 0)
	for len(ids) < attachmentMaxCount {
		names, err := dir.Readdirnames(100)
		for _, name := range names {
			if attachmentID.MatchString(name) {
				ids = append(ids, name)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	return ids[:min(len(ids), attachmentMaxCount)], nil
}

func (a *workspaceAttachments) lock(root *os.Root) (func(), error) {
	host, _ := os.Hostname()
	// Participate in both the Go transaction lock and the prior gateway's
	// SQLite lock range. The stable lock inode is never removed by cleanup.
	return lockConversation(root.Name(), "upload.lock", host, 0)
}

func (a *workspaceAttachments) upload(r *http.Request) (workspaceAttachment, error) {
	var item workspaceAttachment
	query := r.URL.Query()
	name, cwd := query.Get("name"), query.Get("cwd")
	if cwd == "" || !attachmentFilename(name) {
		return item, workspaceUnavailable
	}
	_, project, err := a.workspace.browse(cwd)
	if err != nil {
		return item, err
	}
	if r.ContentLength > attachmentMaxBytes {
		return item, attachmentTooLarge
	}
	root, err := a.openRoot(true)
	if err != nil {
		return item, err
	}
	defer root.Close()
	release, err := a.lock(root)
	if err != nil {
		return item, err
	}
	defer release()
	ids, err := attachmentIDsOnDisk(root)
	if err != nil || len(ids) >= attachmentMaxCount {
		return item, workspaceUnavailable
	}
	var total int64
	for _, id := range ids {
		if dir, err := attachmentOpenDir(root, id); err == nil {
			if meta, err := attachmentRecord(dir, id); err == nil {
				total += meta.Bytes
			}
			dir.Close()
		}
	}
	limit := min(int64(attachmentMaxBytes), attachmentMaxTotal-total)
	if limit < 0 || r.ContentLength > limit {
		return item, attachmentTooLarge
	}
	id := workspaceUUID()
	if err := root.Mkdir(id, 0700); err != nil {
		return item, err
	}
	complete := false
	defer func() {
		if !complete {
			_ = root.RemoveAll(id)
		}
	}()
	dir, err := attachmentOpenDir(root, id)
	if err != nil {
		return item, err
	}
	defer dir.Close()
	file, err := dir.OpenFile("upload.part", os.O_RDWR|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return item, err
	}
	size, err := io.Copy(file, io.LimitReader(r.Body, limit+1))
	if err == nil && size > limit {
		err = attachmentTooLarge
	}
	if err == nil {
		err = file.Sync()
	}
	var head [16]byte
	n, _ := file.ReadAt(head[:], 0)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return item, err
	}
	if err := dir.Rename("upload.part", attachmentContentName(name)); err != nil {
		return item, err
	}
	item = workspaceAttachment{Format: 1, ID: id, Name: name, Cwd: project, Bytes: size, Image: attachmentImage(head[:n], name), CreatedAt: workspaceISODate(time.Now())}
	if err := attachmentWriteJSON(dir, "metadata.json", item); err != nil {
		return item, err
	}
	complete = true
	return item, nil
}

type workspaceAttachmentLink struct {
	ThreadID string `json:"threadId"`
}

func attachmentLinkName(thread string) string {
	return "thread-" + workspaceRevision([]byte(thread)) + ".json"
}

func (a *workspaceAttachments) resolve(ctx context.Context, ids []string, cwd, thread string, bind bool) ([]workspaceAttachment, error) {
	if ids == nil || len(ids) > 20 || cwd == "" || (bind && (thread == "" || len(utf16.Encode([]rune(thread))) > 256)) {
		return nil, workspaceUnavailable
	}
	_, project, err := a.workspace.browse(cwd)
	if err != nil {
		return nil, err
	}
	items := make([]workspaceAttachment, 0, len(ids))
	if len(ids) == 0 && !bind {
		return items, nil
	}
	root, err := a.openRoot(false)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if bind {
		release, err := a.lock(root)
		if err != nil {
			return nil, err
		}
		defer release()
	}
	seen := make(map[string]bool, len(ids))
	var dirs []*os.Root
	defer func() {
		for _, dir := range dirs {
			dir.Close()
		}
	}()
	for _, id := range ids {
		if seen[id] || ctx.Err() != nil {
			return nil, workspaceUnavailable
		}
		seen[id] = true
		meta, dir, file, err := a.openContent(root, id)
		if err != nil {
			return nil, err
		}
		file.Close()
		dirs = append(dirs, dir)
		if meta.Cwd != project {
			return nil, workspaceUnavailable
		}
		meta.Path = filepath.Join(a.path, id, attachmentContentName(meta.Name))
		items = append(items, meta)
	}
	if bind {
		for _, dir := range dirs {
			name := attachmentLinkName(thread)
			if err := attachmentWriteJSON(dir, name, workspaceAttachmentLink{ThreadID: thread}); err != nil {
				if !os.IsExist(err) {
					return nil, err
				}
				var existing workspaceAttachmentLink
				if err := attachmentReadJSON(dir, name, 2048, &existing); err != nil || existing.ThreadID != thread {
					return nil, workspaceUnavailable
				}
			}
		}
	}
	return items, nil
}

func (a *workspaceAttachments) bind(ctx context.Context, ids []string, cwd, thread string) error {
	_, err := a.resolve(ctx, ids, cwd, thread, true)
	return err
}

func (a *workspaceAttachments) list(r *http.Request) ([]workspaceAttachment, error) {
	query := r.URL.Query()
	scope := workspaceDefault(query.Get("scope"), "project")
	thread := query.Get("threadId")
	if (scope != "project" && scope != "conversation") || (scope == "conversation" && (!query.Has("threadId") || len(utf16.Encode([]rune(thread))) > 256)) {
		return nil, workspaceUnavailable
	}
	_, project, err := a.workspace.browse(workspaceDefault(query.Get("cwd"), a.workspace.cwd))
	if err != nil {
		return nil, err
	}
	needle := workspaceBoundedText(strings.ToLower(query.Get("query")), 200)
	items := []workspaceAttachment{}
	root, err := a.openRoot(false)
	if os.IsNotExist(err) {
		return items, nil
	}
	if err != nil {
		return nil, err
	}
	defer root.Close()
	ids, err := attachmentIDsOnDisk(root)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		if r.Context().Err() != nil {
			return nil, r.Context().Err()
		}
		dir, err := attachmentOpenDir(root, id)
		if err != nil {
			continue
		}
		meta, metaErr := attachmentRecord(dir, id)
		linked := true
		if scope == "conversation" {
			var link workspaceAttachmentLink
			linked = attachmentReadJSON(dir, attachmentLinkName(thread), 2048, &link) == nil && link.ThreadID == thread
		}
		dir.Close()
		if linked && metaErr == nil && meta.Cwd == project && strings.Contains(strings.ToLower(meta.Name), needle) {
			items = append(items, meta)
		}
	}
	slices.SortStableFunc(items, func(a, b workspaceAttachment) int { return strings.Compare(b.CreatedAt, a.CreatedAt) })
	return items, nil
}

func (a *workspaceAttachments) register(mux *http.ServeMux) {
	for _, endpoint := range []string{"/api/attachments", "/api/attachments/upload", "/api/attachments/resolve", "/api/attachments/file", "/api/attachments/preview"} {
		mux.HandleFunc(endpoint, a.serve)
	}
}

func (a *workspaceAttachments) serve(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	method, mimeType := "GET", "application/json"
	if path == "/api/attachments/upload" {
		method, mimeType = "POST", "application/octet-stream"
	}
	if path == "/api/attachments/resolve" {
		method = "POST"
	}
	if !workspaceMethod(w, r, method) {
		return
	}
	if method == "POST" && !typedMutationAllowed(r, mimeType) {
		workspaceError(w, 403, "A same-origin workspace request is required.")
		return
	}
	var out any
	var err error
	switch path {
	case "/api/attachments":
		var items []workspaceAttachment
		items, err = a.list(r)
		out = map[string]any{"items": items}
	case "/api/attachments/upload":
		out, err = a.upload(r)
	case "/api/attachments/resolve":
		var input struct {
			IDs      []string        `json:"ids"`
			Cwd      string          `json:"cwd"`
			ThreadID string          `json:"threadId"`
			Bind     json.RawMessage `json:"bind"`
		}
		if err = decodeOne(http.MaxBytesReader(w, r.Body, 16384), &input); err == nil {
			if len(input.Bind) != 0 && string(input.Bind) != "true" && string(input.Bind) != "false" {
				err = workspaceUnavailable
			} else {
				var items []workspaceAttachment
				items, err = a.resolve(r.Context(), input.IDs, input.Cwd, input.ThreadID, string(input.Bind) == "true")
				out = map[string]any{"items": items}
			}
		}
	case "/api/attachments/file", "/api/attachments/preview":
		out, err = a.serveFile(w, r)
		if path == "/api/attachments/file" && err == nil {
			return
		}
	}
	if err == nil {
		workspaceRespond(w, 200, out)
		return
	}
	status, message := 400, "Attachment unavailable. Check the file, project and storage permissions."
	var lockErr *conversationError
	if errors.Is(err, attachmentTooLarge) {
		status, message = 413, "File exceeds the upload or storage limit."
	}
	if errors.As(err, &lockErr) && (lockErr.code == "PRIVATE_LOCK_BUSY" || lockErr.code == "PRIVATE_LOCK_LEGACY_BUSY") {
		status = 409
	}
	workspaceError(w, status, message)
}

func (a *workspaceAttachments) serveFile(w http.ResponseWriter, r *http.Request) (any, error) {
	root, err := a.openRoot(false)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	item, dir, file, err := a.openContent(root, r.URL.Query().Get("id"))
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	defer file.Close()
	if r.URL.Path == "/api/attachments/preview" {
		if item.Bytes > workspaceTextLimit {
			return nil, workspaceUnavailable
		}
		data, err := io.ReadAll(io.LimitReader(file, workspaceTextLimit+1))
		if err != nil || len(data) > workspaceTextLimit || bytes.ContainsRune(data, 0) {
			return nil, workspaceUnavailable
		}
		return map[string]string{"text": strings.ToValidUTF8(string(data), "\uFFFD"), "name": item.Name}, nil
	}
	contentType, disposition := "application/octet-stream", "attachment"
	if r.URL.Query().Get("view") == "image" && item.Image {
		contentType, disposition = workspaceImageTypes[strings.ToLower(filepath.Ext(item.Name))], "inline"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(item.Bytes, 10))
	w.Header().Set("Content-Disposition", disposition+"; filename*=UTF-8''"+workspaceEncodeFilename(item.Name))
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.WriteHeader(200)
	_, _ = io.CopyN(w, file, item.Bytes)
	return nil, nil
}
