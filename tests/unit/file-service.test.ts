import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveLocalFile } from "../../src/server/files/download.js";

describe("local agent file download boundary", () => {
  test("resolves absolute, relative, file URL and sandbox file references inside an allowed root", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-webui-file-"));
    const folder = join(root, "generated files");
    const file = join(folder, "report.txt");
    try {
      mkdirSync(folder);
      writeFileSync(file, "download me");
      const canonicalFile = realpathSync(file);
      expect(resolveLocalFile(file, { cwd: root, home: root, allowedRoots: [root] })).toMatchObject({ path: canonicalFile, filename: "report.txt", size: 11 });
      expect(resolveLocalFile("./generated%20files/report.txt", { cwd: root, home: root, allowedRoots: [root] }).path).toBe(canonicalFile);
      expect(resolveLocalFile(new URL(`file://${file}`).href, { cwd: root, home: root, allowedRoots: [root] }).path).toBe(canonicalFile);
      expect(resolveLocalFile(`sandbox:${file.replaceAll(" ", "%20")}`, { cwd: root, home: root, allowedRoots: [root] }).path).toBe(canonicalFile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects paths outside the boundary, directories, symbolic links, invalid paths and oversized files", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-webui-file-root-"));
    const outside = mkdtempSync(join(tmpdir(), "codex-webui-file-outside-"));
    try {
      const outsideFile = join(outside, "outside.txt");
      const localFile = join(root, "large.bin");
      writeFileSync(outsideFile, "outside");
      writeFileSync(localFile, Buffer.alloc(8));
      symlinkSync(outsideFile, join(root, "linked.txt"));

      expect(() => resolveLocalFile(outsideFile, { cwd: root, home: root, allowedRoots: [root] })).toThrow();
      expect(() => resolveLocalFile(root, { cwd: root, home: root, allowedRoots: [root] })).toThrow();
      expect(() => resolveLocalFile(join(root, "linked.txt"), { cwd: root, home: root, allowedRoots: [root] })).toThrow();
      expect(() => resolveLocalFile(localFile, { cwd: root, home: root, allowedRoots: [root], maxBytes: 4 })).toThrow();
      expect(() => resolveLocalFile("bad\0path", { cwd: root, home: root, allowedRoots: [root] })).toThrow();
      expect(() => resolveLocalFile("a".repeat(8193), { cwd: root, home: root, allowedRoots: [root] })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects credentials inside allowed roots, including aliases through a symlinked directory", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-webui-private-"));
    try {
      for (const relative of [".env", ".env.production", ".ssh/id_ed25519", ".codex/auth.json", ".git/config", "nested/private.pem", "custom-auth/token.json"]) {
        const file = join(root, relative);
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, "dummy secret");
        const options = { cwd: root, allowedRoots: [root], deniedRoots: [join(root, "custom-auth")] };
        expect(() => resolveLocalFile(file, options)).toThrow();
      }
      symlinkSync(join(root, ".codex"), join(root, "public-alias"));
      expect(() => resolveLocalFile(join(root, "public-alias/auth.json"), { allowedRoots: [root] })).toThrow();
      const custom = join(root, "unusual-credential.json");
      writeFileSync(custom, "dummy secret");
      expect(() => resolveLocalFile(custom, { allowedRoots: [root], deniedPaths: [custom] })).toThrow();
      writeFileSync(join(root, ".env.example"), "EXAMPLE=value");
      expect(resolveLocalFile(join(root, ".env.example"), { allowedRoots: [root] }).filename).toBe(".env.example");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
