package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const workspaceTextExtensions = " .md .markdown .mdown .txt .json .jsonl .yaml .yml .toml .ini .cfg .conf .csv .tsv .js .mjs .cjs .jsx .ts .tsx .py .sh .bash .zsh .css .scss .html .xml .svg .sql .rs .go .c .h .cpp .hpp .java .rb .php .vue .svelte .diff .patch "
const workspacePreviewExtensions = " .md .markdown .txt .json .jsonl .yaml .yml .toml .ini .cfg .conf .csv .tsv .js .mjs .cjs .jsx .ts .tsx .py .sh .bash .css .html .xml .sql .rs .go .c .h .cpp .java .rb .diff .patch "

func workspaceTextPath(path, extensions string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == "" || (!strings.ContainsAny(ext, " \t\n\r") && strings.Contains(extensions, " "+ext+" "))
}

type workspaceEntry struct {
	Path         string `json:"path"`
	Kind         string `json:"kind"`
	Name         string `json:"name,omitempty"`
	Bytes        *int64 `json:"bytes,omitempty"`
	ModifiedAt   string `json:"modifiedAt,omitempty"`
	Image        *bool  `json:"image,omitempty"`
	Downloadable *bool  `json:"downloadable,omitempty"`
}

func workspaceSkipDir(name string, library bool) bool {
	switch name {
	case "node_modules", "dist", "build", "coverage", "vendor":
		return true
	case ".git", ".hg", ".svn", ".next", ".cache", ".turbo":
		return !library
	}
	return false
}

func (s *workspace) scan(ctx context.Context, project, start, needle string, library, images bool) ([]workspaceEntry, bool) {
	const maxEntries = 5000
	deadline := time.Now().Add(1500 * time.Millisecond)
	queue := []string{start}
	items := make([]workspaceEntry, 0)
	count := 0
	partial := false
	recursive := !library || needle != "" || images
	private := workspaceCanonical(s.privateRoot)
	for len(queue) != 0 && !partial {
		folder := queue[0]
		queue = queue[1:]
		root, err := workspaceOpenDirectory(project, folder)
		if err != nil {
			continue
		}
		dir, err := root.Open(".")
		root.Close()
		if err != nil {
			continue
		}
		for !partial {
			entries, err := dir.ReadDir(128)
			for _, entry := range entries {
				if count >= maxEntries || time.Now().After(deadline) || ctx.Err() != nil {
					partial = true
					break
				}
				count++
				name := entry.Name()
				if entry.Type()&os.ModeSymlink != 0 || workspacePrivateParts(name) || workspacePrivateName(name) ||
					((library || entry.IsDir()) && strings.HasPrefix(name, ".") && name != ".env.example") {
					continue
				}
				full := filepath.Join(folder, name)
				if workspacePrivateWithin(full, private) || workspacePrivateWithin(full, s.privateRoot) {
					continue
				}
				path, _ := filepath.Rel(project, full)
				path = filepath.ToSlash(path)
				matches := strings.Contains(strings.ToLower(path), needle)
				item := workspaceEntry{Path: path}
				if library {
					item.Name = name
				}
				if entry.IsDir() {
					if workspaceSkipDir(name, library) {
						continue
					}
					if recursive {
						queue = append(queue, full)
					}
					if (library && !recursive) || (!library && matches) {
						item.Kind = "folder"
						items = append(items, item)
					}
					continue
				}
				image := workspaceImageTypes[strings.ToLower(filepath.Ext(name))] != ""
				if !entry.Type().IsRegular() || !matches || (images && !image) {
					continue
				}
				item.Kind = "file"
				if library {
					meta, err := entry.Info()
					if err != nil || !meta.Mode().IsRegular() {
						continue
					}
					if s.privatePath(full) || s.privateFile(meta) {
						continue
					}
					bytes := meta.Size()
					downloadable := bytes <= workspaceFileLimit
					item.Bytes, item.ModifiedAt, item.Image, item.Downloadable = &bytes, workspaceISODate(meta.ModTime()), &image, &downloadable
				}
				items = append(items, item)
			}
			if err != nil {
				break
			}
		}
		dir.Close()
	}
	return items, partial || len(queue) != 0
}

func workspaceISODate(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func (s *workspace) search(w http.ResponseWriter, r *http.Request) {
	if !workspaceMethod(w, r, "GET") {
		return
	}
	query := r.URL.Query().Get("query")
	cwd := workspaceDefault(r.URL.Query().Get("cwd"), s.cwd)
	needle := strings.ToLower(strings.TrimSpace(query))
	items := []workspaceEntry{}
	if needle != "" {
		_, project, err := s.browse(cwd)
		if err != nil {
			workspaceError(w, 400, err.Error())
			return
		}
		items, _ = s.scan(r.Context(), project, project, needle, false, false)
		score := func(path string) int {
			name := strings.ToLower(filepath.Base(path))
			switch {
			case name == needle:
				return 0
			case strings.HasPrefix(name, needle):
				return 1
			case strings.Contains(name, needle):
				return 2
			default:
				return 3
			}
		}
		sort.Slice(items, func(i, j int) bool {
			a, b := items[i].Path, items[j].Path
			if sa, sb := score(a), score(b); sa != sb {
				return sa < sb
			}
			if len(a) != len(b) {
				return len(a) < len(b)
			}
			return workspaceNameLess(a, b)
		})
		items = items[:min(len(items), 30)]
	}
	workspaceRespond(w, 200, map[string]any{"cwd": cwd, "query": query, "items": items})
}

func (s *workspace) library(w http.ResponseWriter, r *http.Request) {
	if !workspaceMethod(w, r, "GET") {
		return
	}
	query := r.URL.Query()
	_, project, err := s.browse(workspaceDefault(query.Get("cwd"), s.cwd))
	path := query.Get("path")
	if err != nil || len(path) > 8192 || filepath.IsAbs(path) {
		workspaceError(w, 400, "Files are unavailable for this project.")
		return
	}
	directory := filepath.Join(project, path)
	if !workspaceWithin(directory, project) || s.privatePath(directory) {
		workspaceError(w, 400, "Files are unavailable for this project.")
		return
	}
	dir, err := workspaceOpenDirectory(project, directory)
	if err != nil {
		workspaceError(w, 400, "Files are unavailable for this project.")
		return
	}
	dir.Close()
	needle := []rune(strings.ToLower(strings.TrimSpace(query.Get("query"))))
	items, partial := s.scan(r.Context(), project, directory, string(needle[:min(200, len(needle))]), true, query.Get("images") == "true")
	sort.Slice(items, func(i, j int) bool {
		if items[i].Kind != items[j].Kind {
			return items[i].Kind == "folder"
		}
		return workspaceNameLess(items[i].Path, items[j].Path)
	})
	var next, parent any
	path, _ = filepath.Rel(project, directory)
	if path == "." {
		path = ""
	} else if dir := filepath.Dir(path); dir == "." {
		parent = ""
	} else {
		parent = filepath.ToSlash(dir)
	}
	offset, _ := strconv.Atoi(query.Get("cursor"))
	offset = min(max(0, offset), len(items))
	end := min(offset+100, len(items))
	if end < len(items) {
		next = end
	}
	workspaceRespond(w, 200, map[string]any{"cwd": project, "path": filepath.ToSlash(path), "parent": parent, "items": items[offset:end], "nextCursor": next, "partial": partial})
}

func (s *workspace) preview(w http.ResponseWriter, r *http.Request) {
	if !workspaceMethod(w, r, "GET") {
		return
	}
	file, info, err := s.openFile(r.URL.Query().Get("path"), s.cwd, s.fileRoots, workspaceTextLimit, false)
	if err != nil {
		workspaceError(w, 400, "Files are unavailable for this project.")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, workspaceTextLimit+1))
	if err != nil || !workspaceTextPath(info.Name(), workspacePreviewExtensions) || len(data) > workspaceTextLimit || bytes.ContainsRune(data, 0) {
		workspaceError(w, 400, "Files are unavailable for this project.")
		return
	}
	workspaceRespond(w, 200, map[string]string{"name": info.Name(), "text": strings.ToValidUTF8(string(data), "\uFFFD")})
}
