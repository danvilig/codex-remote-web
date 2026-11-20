package main

import (
	"context"
	"errors"
	"io"
	"os"
	"regexp"
	"slices"
	"time"
)

var developerCleanupName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$`)
var developerContentName = regexp.MustCompile(`^content(?:\.[a-z0-9]+)?$`)

type developerCleanupFile struct {
	name            string
	bytes, modified int64
	device, inode   uint64
}

type developerCleanupCandidate struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Name  string `json:"name"`
	Bytes int64  `json:"bytes"`
	files []developerCleanupFile
}

var developerCleanupChanged = developerFailure("TOOLS_CLEANUP_CHANGED", 409)

func developerCleanupSnapshot(root *os.Root, name string) (developerCleanupFile, error) {
	f, info, err := attachmentOpenFile(root, name, 1<<62)
	if err != nil {
		return developerCleanupFile{}, errors.Join(developerCleanupChanged, err)
	}
	defer f.Close()
	device, inode, links, ok := fileIdentity(f, info)
	if !ok || links != 1 {
		return developerCleanupFile{}, developerCleanupChanged
	}
	return developerCleanupFile{name, info.Size(), info.ModTime().UnixNano(), device, inode}, nil
}

func developerDirectoryNames(root *os.Root, limit int) ([]string, error) {
	f, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	names, err := f.Readdirnames(limit)
	if errors.Is(err, io.EOF) {
		return names, nil
	}
	return names, err
}

func developerAttachmentCandidate(root *os.Root, id string, now time.Time) (developerCleanupCandidate, error) {
	var candidate developerCleanupCandidate
	dir, err := attachmentOpenDir(root, id)
	if err != nil {
		return candidate, err
	}
	defer dir.Close()
	names, err := developerDirectoryNames(dir, 3)
	if err != nil || len(names) != 2 {
		return candidate, developerCleanupChanged
	}
	slices.Sort(names)
	if names[1] != "metadata.json" || !developerContentName.MatchString(names[0]) {
		return candidate, developerCleanupChanged
	}
	var meta struct {
		ID, Name, CreatedAt string
		Format              int
	}
	if err := attachmentReadJSON(dir, "metadata.json", 16384, &meta); err != nil {
		return candidate, err
	}
	date, err := time.Parse(time.RFC3339Nano, meta.CreatedAt)
	if meta.ID != id || meta.Format != 1 || err != nil || date.After(now.Add(-24*time.Hour)) {
		return candidate, developerCleanupChanged
	}
	candidate = developerCleanupCandidate{Kind: "attachment", ID: id, Name: workspaceBoundedText(workspaceDefault(meta.Name, id), 240)}
	for _, name := range names {
		file, err := developerCleanupSnapshot(dir, name)
		if err != nil || file.modified > now.Add(-24*time.Hour).UnixNano() {
			return candidate, developerCleanupChanged
		}
		candidate.files = append(candidate.files, file)
		candidate.Bytes += file.bytes
	}
	return candidate, nil
}

func (d *developerTools) cleanupCandidates(ctx context.Context, tools, attachments *os.Root) ([]developerCleanupCandidate, error) {
	out := []developerCleanupCandidate{}
	now := time.Now()
	if attachments != nil && d.protectedAttachments != nil {
		protected, err := d.protectedAttachments()
		if err != nil {
			return nil, err
		}
		ids, err := attachmentIDsOnDisk(attachments)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if !developerUUID.MatchString(id) || protected[id] {
				continue
			}
			if item, err := developerAttachmentCandidate(attachments, id, now); err == nil {
				out = append(out, item)
			}
		}
	}
	for _, kind := range []string{"logs", "cache"} {
		dir, err := attachmentOpenDir(tools, kind)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		names, err := developerDirectoryNames(dir, 1000)
		if err != nil {
			dir.Close()
			return nil, err
		}
		for _, name := range names {
			if ctx.Err() != nil {
				dir.Close()
				return nil, ctx.Err()
			}
			if !developerCleanupName.MatchString(name) {
				continue
			}
			if file, err := developerCleanupSnapshot(dir, name); err == nil && file.modified < now.Add(-7*24*time.Hour).UnixNano() {
				out = append(out, developerCleanupCandidate{Kind: kind, ID: name, Name: name, Bytes: file.bytes, files: []developerCleanupFile{file}})
			}
		}
		dir.Close()
	}
	return out, nil
}

func developerMatchesCleanup(a, b developerCleanupCandidate) bool {
	return a.Kind == b.Kind && a.ID == b.ID && a.Name == b.Name && a.Bytes == b.Bytes && slices.Equal(a.files, b.files)
}

func (d *developerTools) cleanup(ctx context.Context, execute bool, token string) (any, error) {
	var previous []developerCleanupCandidate
	if execute {
		value, err := d.consume("cleanup", token)
		if err != nil {
			return nil, err
		}
		previous = value.([]developerCleanupCandidate)
	}
	tools, err := d.root()
	if err != nil {
		return nil, err
	}
	defer tools.Close()
	attachments, err := d.w.attachments.openRoot(false)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if attachments != nil {
		defer attachments.Close()
		release, err := d.w.attachments.lock(attachments)
		if err != nil {
			return nil, developerLockError(err, "TOOLS_STORAGE_BUSY")
		}
		defer release()
	}
	current, err := d.cleanupCandidates(ctx, tools, attachments)
	if err != nil {
		return nil, err
	}
	var total int64
	if !execute {
		for _, item := range current {
			total += item.Bytes
		}
		return map[string]any{"previewToken": d.putPreview("cleanup", current), "items": current, "totalBytes": total, "attachmentsProtected": d.protectedAttachments == nil}, nil
	}
	items := make(map[[2]string]developerCleanupCandidate, len(current))
	for _, item := range current {
		items[[2]string{item.Kind, item.ID}] = item
	}
	for _, item := range previous {
		if !developerMatchesCleanup(item, items[[2]string{item.Kind, item.ID}]) {
			return nil, developerCleanupChanged
		}
	}
	for _, item := range previous {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err := developerRemoveCleanup(tools, attachments, item); err != nil {
			return nil, err
		}
		total += item.Bytes
	}
	return map[string]any{"ok": true, "removed": len(previous), "totalBytes": total}, nil
}

func developerRemoveCleanup(tools, attachments *os.Root, item developerCleanupCandidate) error {
	if item.Kind == "attachment" {
		verified, err := developerAttachmentCandidate(attachments, item.ID, time.Now())
		if err != nil || !developerMatchesCleanup(item, verified) {
			return developerCleanupChanged
		}
		dir, err := attachmentOpenDir(attachments, item.ID)
		if err != nil {
			return err
		}
		defer dir.Close()
		for _, file := range item.files {
			current, err := developerCleanupSnapshot(dir, file.name)
			if err != nil || current != file {
				return developerCleanupChanged
			}
		}
		for _, file := range item.files {
			if err := dir.Remove(file.name); err != nil {
				return err
			}
		}
		return attachments.Remove(item.ID)
	}
	dir, err := attachmentOpenDir(tools, item.Kind)
	if err != nil {
		return err
	}
	defer dir.Close()
	current, err := developerCleanupSnapshot(dir, item.ID)
	if err != nil || len(item.files) != 1 || current != item.files[0] {
		return developerCleanupChanged
	}
	return dir.Remove(item.ID)
}
