package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf8"
)

var workspaceDocumentUnsupported = errors.New("FILE_UNSUPPORTED")
var workspaceDocumentReadOnly = errors.New("FILE_READ_ONLY")
var workspaceDocumentConflict = errors.New("FILE_CONFLICT")

type workspaceDocument struct {
	Name     string `json:"name"`
	Text     string `json:"text"`
	Revision string `json:"revision"`
	Writable bool   `json:"writable"`
	info     os.FileInfo
}

func workspaceRevision(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (s *workspace) locateDocument(cwd, path string) (*os.Root, string, string, error) {
	if cwd == "" || path == "" || len(path) > 8192 || filepath.IsAbs(path) || strings.ContainsRune(path, 0) {
		return nil, "", "", workspaceUnavailable
	}
	for _, dir := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' }) {
		if dir == ".." {
			return nil, "", "", workspaceUnavailable
		}
	}
	_, project, err := s.browse(cwd)
	if err != nil {
		return nil, "", "", workspaceUnavailable
	}
	absolute := filepath.Join(project, path)
	if absolute == project || s.privatePath(absolute) || !workspaceWithin(absolute, project) {
		return nil, "", "", workspaceUnavailable
	}
	parent, err := workspaceOpenDirectory(project, filepath.Dir(absolute))
	if err != nil {
		return nil, "", "", workspaceUnavailable
	}
	if info, err := parent.Lstat(filepath.Base(absolute)); err != nil || !info.Mode().IsRegular() || s.privateFile(info) {
		parent.Close()
		return nil, "", "", workspaceUnavailable
	}
	return parent, absolute, filepath.Base(absolute), nil
}

func workspaceReadDocument(parent *os.Root, path, name string) (workspaceDocument, error) {
	var result workspaceDocument
	before, err := parent.Lstat(name)
	if err != nil || !before.Mode().IsRegular() {
		return result, workspaceUnavailable
	}
	if !workspaceTextPath(name, workspaceTextExtensions) || before.Size() > workspaceTextLimit {
		return result, workspaceDocumentUnsupported
	}
	file, err := parent.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return result, workspaceUnavailable
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !os.SameFile(before, info) || !info.Mode().IsRegular() {
		return result, workspaceUnavailable
	}
	if info.Size() > workspaceTextLimit {
		return result, workspaceDocumentUnsupported
	}
	data, err := io.ReadAll(io.LimitReader(file, workspaceTextLimit+1))
	if err != nil || len(data) > workspaceTextLimit || bytes.ContainsRune(data, 0) || !utf8.Valid(data) {
		return result, workspaceDocumentUnsupported
	}
	stat, statOK := info.Sys().(*syscall.Stat_t)
	const accessWrite = 2
	writable := statOK && info.Mode().Perm()&0222 != 0 && stat.Nlink == 1 &&
		syscall.Access(path, accessWrite) == nil && syscall.Access(filepath.Dir(path), accessWrite) == nil
	return workspaceDocument{Name: name, Text: string(data), Revision: workspaceRevision(data), Writable: writable, info: info}, nil
}

func (s *workspace) saveDocument(cwd, path, revision string, data []byte) (string, error) {
	s.editMu.Lock()
	defer s.editMu.Unlock()
	parent, absolute, name, err := s.locateDocument(cwd, path)
	if err != nil {
		return "", err
	}
	defer parent.Close()
	before, err := workspaceReadDocument(parent, absolute, name)
	if err != nil {
		return "", err
	}
	if !before.Writable {
		return "", workspaceDocumentReadOnly
	}
	if before.Revision != revision {
		return "", workspaceDocumentConflict
	}
	tempName := ".codex-remote-edit-" + rand.Text()
	temp, err := parent.OpenFile(tempName, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return "", err
	}
	defer parent.Remove(tempName)
	_, err = temp.Write(data)
	if err == nil {
		err = temp.Chmod(before.info.Mode().Perm())
	}
	if err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	verified, currentPath, currentName, err := s.locateDocument(cwd, path)
	if err != nil {
		return "", err
	}
	defer verified.Close()
	firstDir, firstErr := parent.Stat(".")
	checkedDir, checkedErr := verified.Stat(".")
	if firstErr != nil || checkedErr != nil || currentPath != absolute || !os.SameFile(firstDir, checkedDir) {
		return "", workspaceDocumentConflict
	}
	current, err := workspaceReadDocument(verified, currentPath, currentName)
	if err != nil {
		return "", err
	}
	if !current.Writable {
		return "", workspaceDocumentReadOnly
	}
	if !os.SameFile(before.info, current.info) || before.Revision != current.Revision {
		return "", workspaceDocumentConflict
	}
	if err := parent.Rename(tempName, name); err != nil {
		return "", err
	}
	return workspaceRevision(data), nil
}

func workspaceDocumentReply(w http.ResponseWriter, status int, message, code string) {
	workspaceRespond(w, status, map[string]string{"error": message, "code": code})
}

func (s *workspace) document(w http.ResponseWriter, r *http.Request) {
	if !workspaceMethod(w, r, "GET", "POST") {
		return
	}
	const message = "Unable to read or save this project file."
	var err error
	if r.Method == "GET" {
		query := r.URL.Query()
		parent, path, name, locateErr := s.locateDocument(query.Get("cwd"), query.Get("path"))
		if err = locateErr; err == nil {
			defer parent.Close()
			var doc workspaceDocument
			if doc, err = workspaceReadDocument(parent, path, name); err == nil {
				workspaceRespond(w, 200, doc)
				return
			}
		}
	} else {
		if !workspaceMutationAllowed(r) {
			workspaceDocumentReply(w, 403, "A same-origin workspace request is required.", "FILE_ORIGIN_REQUIRED")
			return
		}
		var payload map[string]json.RawMessage
		if decodeOne(http.MaxBytesReader(w, r.Body, 2<<20), &payload) != nil || len(payload) != 4 {
			workspaceDocumentReply(w, 400, message, "FILE_INVALID")
			return
		}
		var cwd, path, text, revision *string
		err = errors.Join(json.Unmarshal(payload["cwd"], &cwd), json.Unmarshal(payload["path"], &path), json.Unmarshal(payload["text"], &text), json.Unmarshal(payload["revision"], &revision))
		if err != nil || cwd == nil || path == nil || text == nil || revision == nil || !workspaceValidRevision(*revision) {
			workspaceDocumentReply(w, 400, message, "FILE_INVALID")
			return
		}
		if len(*text) > workspaceTextLimit || strings.ContainsRune(*text, 0) {
			workspaceDocumentReply(w, 413, message, "FILE_TOO_LARGE")
			return
		}
		var newRevision string
		if newRevision, err = s.saveDocument(*cwd, *path, *revision, []byte(*text)); err == nil {
			workspaceRespond(w, 200, map[string]any{"ok": true, "revision": newRevision})
			return
		}
	}
	switch {
	case errors.Is(err, workspaceDocumentUnsupported):
		workspaceDocumentReply(w, 400, message, "FILE_UNSUPPORTED")
	case errors.Is(err, workspaceDocumentReadOnly):
		workspaceDocumentReply(w, 403, message, "FILE_READ_ONLY")
	case errors.Is(err, workspaceDocumentConflict):
		workspaceDocumentReply(w, 409, message, "FILE_CONFLICT")
	default:
		workspaceDocumentReply(w, 400, message, "FILE_UNAVAILABLE")
	}
}

func workspaceValidRevision(revision string) bool {
	if len(revision) != sha256.Size*2 {
		return false
	}
	for _, c := range revision {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
