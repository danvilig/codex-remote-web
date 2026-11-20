package main

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var workspaceSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
var workspaceSkillHeader = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---(?:\r?\n|$)`)
var workspaceSkillName = regexp.MustCompile(`(?m)^name:[\t ]*["']?([a-z0-9-]+)["']?[\t \r]*$`)

func (s *workspace) managedSkill(path, cwd string) (*os.Root, string, os.FileInfo, error) {
	dir := filepath.Dir(path)
	name := filepath.Base(dir)
	if !filepath.IsAbs(path) || filepath.Base(path) != "SKILL.md" || !workspaceSlug.MatchString(name) {
		return nil, "", nil, workspaceUnavailable
	}
	base := workspaceCanonical(filepath.Dir(dir))
	for _, root := range []string{filepath.Join(s.privateRoot, "skills"), filepath.Join(s.home, ".agents", "skills"), filepath.Join(cwd, ".agents", "skills")} {
		if workspaceCanonical(root) != base {
			continue
		}
		if filepath.Base(filepath.Dir(root)) == ".agents" {
			agents := filepath.Dir(root)
			if workspaceCanonical(agents) != filepath.Join(workspaceCanonical(filepath.Dir(agents)), ".agents") {
				continue
			}
		}
		// Allow symlinks in the host path prefix (e.g. /var on macOS),
		// but a redirected skill directory cannot make a third-party skill removable.
		if info, err := os.Lstat(root); err != nil || !info.IsDir() {
			continue
		}
		parent, err := workspaceOpenDirectory(base, base)
		if err != nil {
			return nil, "", nil, err
		}
		child, info, err := workspaceSkillChild(parent, name)
		if err == nil {
			manifest, err := child.Lstat("SKILL.md")
			child.Close()
			if err == nil && manifest.Mode().IsRegular() {
				return parent, name, info, nil
			}
		}
		parent.Close()
	}
	return nil, "", nil, workspaceUnavailable
}

func (s *workspace) installSkill(ctx context.Context, source string) (string, error) {
	if source == "" || len(source) > 4096 {
		return "", workspaceUnavailable
	}
	lexical, canonical, err := s.browse(source)
	if err != nil {
		return "", err
	}
	if info, err := os.Lstat(lexical); err != nil || !info.IsDir() {
		return "", workspaceUnavailable
	}
	input, err := workspaceOpenDirectory(canonical, canonical)
	if err != nil {
		return "", err
	}
	defer input.Close()
	manifest, mode, err := workspaceSkillRead(input, "SKILL.md", 65536)
	if err != nil {
		return "", err
	}
	match := workspaceSkillHeader.FindSubmatch(manifest)
	if len(match) != 2 {
		return "", workspaceUnavailable
	}
	name := workspaceSkillName.FindSubmatch(match[1])
	if len(name) != 2 || !workspaceSlug.Match(name[1]) || workspaceWithin(workspaceCanonical(s.privateRoot), canonical) {
		return "", workspaceUnavailable
	}
	if err := os.MkdirAll(s.privateRoot, 0700); err != nil {
		return "", err
	}
	private := workspaceCanonical(s.privateRoot)
	profile, err := workspaceOpenDirectory(private, private)
	if err != nil {
		return "", err
	}
	defer profile.Close()
	if err := profile.Mkdir("skills", 0700); err != nil && !os.IsExist(err) {
		return "", err
	}
	output, _, err := workspaceSkillChild(profile, "skills")
	if err != nil {
		return "", err
	}
	defer output.Close()
	destination := string(name[1])
	stage := ".crw-install-" + rand.Text()
	if err := output.Mkdir(stage, 0700); err != nil {
		return "", err
	}
	defer output.RemoveAll(stage)
	staged, _, err := workspaceSkillChild(output, stage)
	if err != nil {
		return "", err
	}
	defer staged.Close()
	entries, budget := 500, int64((10<<20)-len(manifest))
	if err := workspaceCopySkill(ctx, input, staged, &entries, &budget, true); err != nil {
		return "", err
	}
	// Reserve exclusively across gateways. Publish SKILL.md last so Codex
	// cannot discover a half-copied skill.
	if err := output.Mkdir(destination, 0700); err != nil {
		return "", err
	}
	published := false
	defer func() {
		if !published {
			_ = output.RemoveAll(destination)
		}
	}()
	dir, err := staged.Open(".")
	if err != nil {
		return "", err
	}
	names, err := dir.Readdirnames(-1)
	dir.Close()
	if err != nil {
		return "", err
	}
	for _, name := range names {
		if err := output.Rename(filepath.Join(stage, name), filepath.Join(destination, name)); err != nil {
			return "", err
		}
	}
	if err := workspaceSkillWrite(staged, "SKILL.md", manifest, mode); err != nil {
		return "", err
	}
	if err := output.Rename(filepath.Join(stage, "SKILL.md"), filepath.Join(destination, "SKILL.md")); err != nil {
		return "", err
	}
	published = true
	return filepath.Join(s.privateRoot, "skills", destination, "SKILL.md"), nil
}

func workspaceCopySkill(ctx context.Context, from, to *os.Root, entries *int, budget *int64, top bool) error {
	dir, err := from.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	for {
		batch, readErr := dir.ReadDir(64)
		for _, entry := range batch {
			if *entries <= 0 || ctx.Err() != nil {
				return workspaceUnavailable
			}
			(*entries)--
			name := entry.Name()
			if strings.HasPrefix(name, ".") || workspacePrivateName(name) || (top && name == "SKILL.md") {
				continue
			}
			if entry.IsDir() {
				if err := workspaceCopySkillDirectory(ctx, from, to, name, entries, budget); err != nil {
					return err
				}
				continue
			}
			data, mode, err := workspaceSkillRead(from, name, *budget)
			if err != nil {
				return err
			}
			*budget -= int64(len(data))
			if err := workspaceSkillWrite(to, name, data, mode); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func workspaceSkillChild(root *os.Root, name string) (*os.Root, os.FileInfo, error) {
	before, err := root.Lstat(name)
	if err != nil || !before.IsDir() {
		return nil, nil, workspaceUnavailable
	}
	child, err := root.OpenRoot(name)
	if err != nil {
		return nil, nil, err
	}
	if actual, err := child.Stat("."); err != nil || !os.SameFile(before, actual) {
		child.Close()
		return nil, nil, workspaceUnavailable
	}
	return child, before, nil
}

func workspaceCopySkillDirectory(ctx context.Context, from, to *os.Root, name string, entries *int, budget *int64) error {
	child, _, err := workspaceSkillChild(from, name)
	if err != nil {
		return err
	}
	defer child.Close()
	if err := to.Mkdir(name, 0700); err != nil {
		return err
	}
	output, _, err := workspaceSkillChild(to, name)
	if err != nil {
		return err
	}
	defer output.Close()
	return workspaceCopySkill(ctx, child, output, entries, budget, false)
}

func workspaceSkillRead(root *os.Root, name string, limit int64) ([]byte, os.FileMode, error) {
	info, err := root.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, 0, workspaceUnavailable
	}
	file, err := root.OpenFile(name, os.O_RDONLY|noFollow|noBlock, 0)
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	if after, err := file.Stat(); err != nil || !after.Mode().IsRegular() || !os.SameFile(info, after) || after.Size() > limit {
		return nil, 0, workspaceUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, 0, workspaceUnavailable
	}
	mode := os.FileMode(0600)
	if info.Mode()&0111 != 0 {
		mode = 0700
	}
	return data, mode, nil
}

func workspaceSkillWrite(root *os.Root, name string, data []byte, mode os.FileMode) error {
	file, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL|noFollow, mode)
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	return errors.Join(err, file.Close())
}
