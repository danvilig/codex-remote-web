package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const workspaceFileLimit = 512 << 20
const workspaceImageLimit = 25 << 20
const workspaceTextLimit = 256 << 10

var workspaceUnavailable = errors.New("File unavailable")
var workspaceOutsideRoots = errors.New("outside allowed roots")

type workspace struct {
	home, cwd, privateRoot             string
	browseRoots, fileRoots, imageRoots []string
	deniedPaths                        []string
	bridge                             *bridge
	editMu                             sync.Mutex
	customizeMu                        sync.Mutex
	attachments                        *workspaceAttachments
	developer                          *developerTools
}

func newWorkspace(home, cwd string, b *bridge) (*workspace, error) {
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return nil, err
		}
	}
	if cwd == "" {
		cwd = home
	}
	home, err := filepath.Abs(home)
	if err != nil {
		return nil, err
	}
	cwd, err = filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}
	private, err := filepath.Abs(workspaceDefault(os.Getenv("CODEX_HOME"), filepath.Join(home, ".codex")))
	if err != nil {
		return nil, err
	}
	browseRoots := []string{home, cwd}
	files := append([]string{}, browseRoots...)
	for _, path := range filepath.SplitList(os.Getenv("CODEX_WEBUI_DOWNLOAD_ROOTS")) {
		if path != "" {
			files = append(files, workspaceAbsolute(path))
		}
	}
	s := &workspace{
		home: home, cwd: cwd, privateRoot: private, browseRoots: browseRoots, fileRoots: files,
		imageRoots:  append(append([]string{}, browseRoots...), os.TempDir(), "/tmp"),
		deniedPaths: []string{workspaceDefault(os.Getenv("CODEX_AUTH_PATH"), filepath.Join(private, "auth.json")), os.Getenv("CODEX_WEBUI_AUTH_STORE")},
		bridge:      b,
	}
	s.attachments = &workspaceAttachments{workspace: s, path: filepath.Join(private, "remote-web-attachments")}
	s.developer = newDeveloperTools(s)
	return s, nil
}

func workspaceDefault(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func workspaceAbsolute(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return absolute
}

func workspaceWithin(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && filepath.IsLocal(rel)
}

func workspaceInRoots(path string, roots []string) bool {
	for _, root := range roots {
		if workspaceWithin(path, root) {
			return true
		}
	}
	return false
}

func workspaceCanonical(path string) string {
	path = workspaceAbsolute(path)
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return path
}

func workspaceCanonicalRoots(paths []string) []string {
	roots := make([]string, 0, len(paths))
	for _, path := range paths {
		canonical, err := filepath.EvalSymlinks(workspaceAbsolute(path))
		if err == nil {
			roots = append(roots, canonical)
		}
	}
	return roots
}

func (s *workspace) browse(path string) (name, canonical string, err error) {
	if path == "~" {
		path = s.home
	} else if strings.HasPrefix(path, "~/") {
		path = filepath.Join(s.home, path[2:])
	}
	name = workspaceAbsolute(path)
	if !workspaceInRoots(name, s.browseRoots) || s.privatePath(name) {
		return "", "", workspaceOutsideRoots
	}
	canonical, err = filepath.EvalSymlinks(name)
	if err != nil {
		return "", "", errors.New("Directory not found")
	}
	if !workspaceInRoots(canonical, workspaceCanonicalRoots(s.browseRoots)) || s.privatePath(canonical) {
		return "", "", workspaceOutsideRoots
	}
	info, err := os.Stat(canonical)
	if err != nil || !info.IsDir() {
		return "", "", errors.New("Directory not found")
	}
	return name, canonical, nil
}

func workspacePrivateName(name string) bool {
	name = strings.ToLower(name)
	switch name {
	case ".npmrc", ".netrc", ".pypirc", "id_rsa", "id_ed25519", "id_ecdsa", "auth.json", "management-token.json":
		return true
	}
	switch filepath.Ext(name) {
	case ".pem", ".key", ".p12", ".pfx":
		return true
	}
	return name == ".env" || (strings.HasPrefix(name, ".env.") && name != ".env.example")
}

func workspacePrivateParts(path string) bool {
	for part := range strings.SplitSeq(path, string(filepath.Separator)) {
		switch strings.ToLower(part) {
		case ".codex", ".ssh", ".aws", ".azure", ".kube", ".gnupg", ".config", ".git", ".artifacts":
			return true
		}
	}
	return false
}

func (s *workspace) privatePath(path string) bool {
	if workspacePrivateParts(path) || workspacePrivateName(filepath.Base(path)) ||
		workspacePrivateWithin(path, s.privateRoot) || workspacePrivateWithin(path, workspaceCanonical(s.privateRoot)) {
		return true
	}
	for _, denied := range s.deniedPaths {
		if denied != "" && (strings.EqualFold(path, workspaceAbsolute(denied)) || strings.EqualFold(path, workspaceCanonical(denied))) {
			return true
		}
	}
	return false
}

func workspacePrivateWithin(path, root string) bool {
	// macOS commonly uses case-insensitive volumes. Reserve private names
	// regardless of casing so a spelling variant cannot expose a credential.
	return workspaceWithin(strings.ToLower(path), strings.ToLower(root))
}

func (s *workspace) privateFile(info os.FileInfo) bool {
	for _, denied := range s.deniedPaths {
		if denied == "" {
			continue
		}
		if metadata, err := os.Stat(denied); err == nil && os.SameFile(metadata, info) {
			return true
		}
	}
	return false
}

func (s *workspace) expandFile(input, cwd string, image bool) (string, error) {
	input = strings.TrimSpace(input)
	if input == "" || len(input) > 8192 || strings.ContainsRune(input, 0) {
		return "", workspaceUnavailable
	}
	switch {
	case strings.HasPrefix(strings.ToLower(input), "file:"):
		u, err := url.Parse(input)
		if err != nil || u.User != nil || (u.Host != "" && !strings.EqualFold(u.Host, "localhost")) ||
			!filepath.IsAbs(u.Path) || strings.Contains(strings.ToLower(u.EscapedPath()), "%2f") {
			return "", workspaceUnavailable
		}
		input = u.Path
	case !image && strings.HasPrefix(strings.ToLower(input), "sandbox:"):
		input = workspaceUnescape(input[len("sandbox:"):])
	case input == "~":
		input = s.home
	case strings.HasPrefix(input, "~/") || strings.HasPrefix(input, `~\`):
		part := input[2:]
		if !image {
			part = workspaceUnescape(part)
		}
		input = filepath.Join(s.home, part)
	case !image:
		input = workspaceUnescape(input)
	}
	if input == "" || strings.ContainsRune(input, 0) {
		return "", workspaceUnavailable
	}
	if !filepath.IsAbs(input) {
		input = filepath.Join(cwd, input)
	}
	return workspaceAbsolute(input), nil
}

func workspaceUnescape(value string) string {
	if decoded, err := url.PathUnescape(value); err == nil {
		return decoded
	}
	return value
}

// Keep path traversal on directory descriptors and verify each component before
// using it as a root. A replaced symlink must not redirect a read or an edit.
func workspaceOpenDirectory(boundary, path string) (*os.Root, error) {
	if !workspaceWithin(path, boundary) || !filepath.IsAbs(path) {
		return nil, workspaceOutsideRoots
	}
	base := filepath.VolumeName(path) + string(filepath.Separator)
	rel, err := filepath.Rel(base, path)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(base)
	if err != nil {
		return nil, err
	}
	if rel == "." {
		return root, nil
	}
	for name := range strings.SplitSeq(rel, string(filepath.Separator)) {
		before, err := root.Lstat(name)
		if err != nil || !before.IsDir() {
			root.Close()
			return nil, workspaceUnavailable
		}
		child, err := root.OpenRoot(name)
		root.Close()
		if err != nil {
			return nil, err
		}
		after, err := child.Stat(".")
		if err != nil || !os.SameFile(before, after) {
			child.Close()
			return nil, workspaceUnavailable
		}
		root = child
	}
	return root, nil
}

func (s *workspace) openFile(input, cwd string, roots []string, limit int64, image bool) (*os.File, os.FileInfo, error) {
	path, err := s.expandFile(input, cwd, image)
	if err != nil || s.privatePath(path) {
		return nil, nil, workspaceUnavailable
	}
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Size() > limit {
		return nil, nil, workspaceUnavailable
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil || s.privatePath(path) {
		return nil, nil, workspaceUnavailable
	}
	for _, root := range workspaceCanonicalRoots(roots) {
		if !workspaceWithin(path, root) {
			continue
		}
		dir, err := workspaceOpenDirectory(root, filepath.Dir(path))
		if err != nil {
			return nil, nil, err
		}
		defer dir.Close()
		file, err := dir.OpenFile(filepath.Base(path), os.O_RDONLY|noBlock|noFollow, 0)
		if err != nil {
			return nil, nil, err
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() > limit || !os.SameFile(before, info) || s.privateFile(info) || !regularFileHandle(file, info) {
			file.Close()
			return nil, nil, workspaceUnavailable
		}
		return file, info, nil
	}
	return nil, nil, workspaceOutsideRoots
}

var workspaceImageTypes = map[string]string{
	".avif": "image/avif", ".bmp": "image/bmp", ".gif": "image/gif", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
}

func workspaceRespond(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	jsonReply(w, status, payload)
}

func workspaceError(w http.ResponseWriter, status int, message string) {
	workspaceRespond(w, status, map[string]string{"error": message})
}

func workspaceMethod(w http.ResponseWriter, r *http.Request, methods ...string) bool {
	for _, allowed := range methods {
		if r.Method == allowed {
			return true
		}
	}
	w.Header().Set("Allow", strings.Join(methods, ", "))
	workspaceError(w, http.StatusMethodNotAllowed, "Method not allowed")
	return false
}

func (s *workspace) register(mux *http.ServeMux) {
	s.attachments.register(mux)
	mux.HandleFunc("/api/settings/developer-tools", s.developer.serve)
	mux.HandleFunc("/api/folders", s.folders)
	mux.HandleFunc("/api/workspace/context", s.context)
	mux.HandleFunc("/api/files/search", s.search)
	mux.HandleFunc("/api/files/download", s.download)
	mux.HandleFunc("/api/images/local", s.download)
	mux.HandleFunc("/api/files/document", s.document)
	mux.HandleFunc("/api/library", s.library)
	mux.HandleFunc("/api/library/preview", s.preview)
	mux.HandleFunc("/api/settings", s.settings)
	mux.HandleFunc("/api/settings/storage", s.storage)
	mux.HandleFunc("/api/settings/worktrees", s.worktrees)
	mux.HandleFunc("/api/customize", s.customize)
	mux.HandleFunc("/api/composer/tools", s.composerTools)
}

func (s *workspace) folders(w http.ResponseWriter, r *http.Request) {
	if !workspaceMethod(w, r, "GET") {
		return
	}
	name, canonical, err := s.browse(workspaceDefault(r.URL.Query().Get("path"), "~"))
	if err != nil {
		workspaceError(w, 400, err.Error())
		return
	}
	root, err := workspaceOpenDirectory(canonical, canonical)
	if err != nil {
		workspaceError(w, 400, "Directory not available")
		return
	}
	defer root.Close()
	dir, err := root.Open(".")
	if err != nil {
		workspaceError(w, 400, "Directory not available")
		return
	}
	defer dir.Close()
	entries, err := dir.ReadDir(-1)
	if err != nil {
		workspaceError(w, 400, "Directory not available")
		return
	}
	folders := []map[string]string{}
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") && !s.privatePath(filepath.Join(canonical, entry.Name())) {
			folders = append(folders, map[string]string{"name": entry.Name(), "path": filepath.Join(name, entry.Name())})
		}
	}
	sort.Slice(folders, func(i, j int) bool { return workspaceNameLess(folders[i]["name"], folders[j]["name"]) })
	var parent any
	if p := filepath.Dir(name); p != name && workspaceInRoots(p, s.browseRoots) {
		parent = p
	}
	workspaceRespond(w, 200, map[string]any{"path": name, "parent": parent, "folders": folders})
}

func workspaceNameLess(a, b string) bool {
	upperA, upperB := strings.ToLower(a), strings.ToLower(b)
	if upperA != upperB {
		return upperA < upperB
	}
	return a < b
}

func (s *workspace) context(w http.ResponseWriter, r *http.Request) {
	if !workspaceMethod(w, r, "GET") {
		return
	}
	cwd, canonical, err := s.browse(workspaceDefault(r.URL.Query().Get("cwd"), s.cwd))
	if err != nil {
		workspaceError(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "branch", "--show-current")
	cmd.Dir = canonical
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	var output workspaceBoundedOutput
	cmd.Stdout = &output
	branch := "No branch"
	if cmd.Run() == nil {
		branch = workspaceDefault(strings.TrimSpace(output.String()), branch)
	}
	workspaceRespond(w, 200, map[string]string{"cwd": cwd, "project": filepath.Base(cwd), "environment": "Local", "branch": branch})
}

func (s *workspace) download(w http.ResponseWriter, r *http.Request) {
	if !workspaceMethod(w, r, "GET") {
		return
	}
	query := r.URL.Query()
	image := r.URL.Path == "/api/images/local"
	roots, limit, statusMessage := s.fileRoots, int64(workspaceFileLimit), "File unavailable"
	if image {
		roots, limit, statusMessage = s.imageRoots, workspaceImageLimit, "Image unavailable"
	}
	file, info, err := s.openFile(query.Get("path"), workspaceDefault(query.Get("cwd"), s.cwd), roots, limit, image)
	if err != nil {
		workspaceError(w, 404, statusMessage)
		return
	}
	defer file.Close()
	contentType, disposition, cache := "application/octet-stream", `attachment; filename="download"`, "no-store"
	if image {
		contentType, disposition, cache = workspaceImageTypes[strings.ToLower(filepath.Ext(info.Name()))], "inline", "private, max-age=60"
		if contentType == "" {
			workspaceError(w, 404, statusMessage)
			return
		}
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("Content-Disposition", disposition+"; filename*=UTF-8''"+workspaceEncodeFilename(info.Name()))
	w.Header().Set("Cache-Control", cache)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.WriteHeader(200)
	_, _ = io.CopyN(w, file, info.Size())
}

func workspaceEncodeFilename(name string) string {
	const hexDigits = "0123456789ABCDEF"
	var encoded strings.Builder
	for i := 0; i < len(name); i++ {
		c := name[i]
		if ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z') || ('0' <= c && c <= '9') || strings.ContainsRune("-._~", rune(c)) {
			encoded.WriteByte(c)
		} else {
			encoded.WriteByte('%')
			encoded.WriteByte(hexDigits[c>>4])
			encoded.WriteByte(hexDigits[c&15])
		}
	}
	return encoded.String()
}
