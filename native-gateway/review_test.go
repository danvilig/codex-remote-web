package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestReviewUndoReapplyAndProtectedPath(t *testing.T) {
	repo, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "init", "-q", repo)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	if out, err := exec.Command("git", "-C", repo, "config", "--local", "core.autocrlf", "false").CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	path := filepath.Join(repo, "README.md")
	if err := os.WriteFile(path, []byte("after\n"), 0600); err != nil {
		t.Fatal(err)
	}
	diff := "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n"
	for _, check := range []struct{ action, want string }{{"undo", "before\n"}, {"reapply", "after\n"}} {
		if _, err := reviewApply(context.Background(), repo, repo, diff, check.action); err != nil {
			t.Fatal(err)
		}
		if content, err := os.ReadFile(path); err != nil || string(content) != check.want {
			t.Fatalf("%s: %q %v", check.action, content, err)
		}
	}
	if _, err := reviewApply(context.Background(), repo, repo, strings.ReplaceAll(diff, "README.md", ".env"), "undo"); err == nil || !strings.Contains(err.Error(), "protected path") {
		t.Fatalf("protected path validation: %v", err)
	}
}
