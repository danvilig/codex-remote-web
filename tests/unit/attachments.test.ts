import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  chmod,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import {
  createAttachmentService,
  ATTACHMENT_MAX_BYTES,
} from "../../src/server/services/attachments.js";
import { scheduleOwner } from "../../src/server/services/schedule-store.js";
async function fixture(fn) {
  const root = await mkdtemp("/tmp/crw-uploads-"),
    home = join(root, "home"),
    project = join(root, "project"),
    privateRoot = join(home, ".codex");
  await mkdir(privateRoot, { recursive: true });
  await mkdir(project);
  const service = createAttachmentService({
    home,
    privateRoot,
    browseRoots: [home, project],
  });
  try {
    await fn({ root, home, project, privateRoot, service });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const upload = (service, cwd, name, data) =>
  service.upload(Readable.from([Buffer.from(data)]), { cwd, name });
test("uploads are durable, project scoped, bind to chats idempotently and safely resolve/download/preview", () =>
  fixture(async (e) => {
    const item = await upload(e.service, e.project, "notes.txt", "Hello");
    expect(item.name).toBe("notes.txt");
    expect((await e.service.list({ cwd: e.project })).items).toHaveLength(1);
    expect((await e.service.list({ cwd: e.home })).items).toHaveLength(0);
    expect(
      (
        await e.service.list({
          cwd: e.project,
          scope: "conversation",
          threadId: "thread-A",
        })
      ).items,
    ).toHaveLength(0);
    const payload = {
      ids: [item.id],
      cwd: e.project,
      threadId: "thread-A",
      bind: true,
    };
    const resolved = await e.service.resolveInput(payload);
    expect(resolved.items[0].path).toContain(item.id);
    await e.service.resolveInput(payload);
    expect(
      (
        await e.service.list({
          cwd: e.project,
          scope: "conversation",
          threadId: "thread-A",
        })
      ).items,
    ).toHaveLength(1);
    expect((await e.service.preview(item.id)).text).toBe("Hello");
    const file = await e.service.file(item.id);
    try {
      expect((await file.fd.readFile()).toString()).toBe("Hello");
    } finally {
      await file.fd.close();
    }
    await expect(
      e.service.resolveInput({ ...payload, cwd: e.home }),
    ).rejects.toThrow();
    await expect(
      e.service.resolveInput({ ...payload, ids: [item.id, item.id] }),
    ).rejects.toThrow();
    await expect(e.service.file("../notes")).rejects.toThrow();
  }));
test("uploads reject path traversal, scope escapes, excessive sizes and symlink storage", () =>
  fixture(async (e) => {
    for (const name of ["../secret", "x/y", "x\\y", "..", "bad\nname"])
      await expect(upload(e.service, e.project, name, "x")).rejects.toThrow();
    await expect(upload(e.service, e.root, "file", "x")).rejects.toThrow();
    await expect(
      upload(
        e.service,
        e.project,
        "large",
        Buffer.alloc(ATTACHMENT_MAX_BYTES + 1),
      ),
    ).rejects.toThrow();
    expect((await e.service.list({ cwd: e.project })).items).toHaveLength(0);
    await rm(join(e.privateRoot, "remote-web-attachments"), {
      recursive: true,
      force: true,
    });

    await symlink(e.project, join(e.privateRoot, "remote-web-attachments"));
    await expect(upload(e.service, e.project, "file", "x")).rejects.toThrow();
  }));
test("image sniffing rejects active content and fake extensions; protected content cannot be replaced by a symlink", () =>
  fixture(async (e) => {
    const svg = await upload(
        e.service,
        e.project,
        "evil.svg",
        '<svg onload="alert(1)"/>',
      ),
      fake = await upload(e.service, e.project, "fake.png", "not an image"),
      png = await upload(
        e.service,
        e.project,
        "sample.png",
        Buffer.from("89504e470d0a1a0a", "hex"),
      );
    expect(svg.image).toBe(false);
    expect(fake.image).toBe(false);
    expect(png.image).toBe(true);
    const resolved = await e.service.resolveInput({
      ids: [fake.id],
      cwd: e.project,
    });
    const path = resolved.items[0].path;
    await rm(path);
    await writeFile(join(e.project, "private"), "secret");
    await symlink(join(e.project, "private"), path);
    await expect(e.service.file(fake.id)).rejects.toThrow();
    await chmod(
      join(e.privateRoot, "remote-web-attachments", png.id, "metadata.json"),
      0o644,
    );
    await expect(e.service.file(png.id)).rejects.toThrow();
  }));
test("interrupted uploads clean partial files without publishing a record", () =>
  fixture(async (e) => {
    const broken = Readable.from(
      (async function* () {
        yield Buffer.from("partial");
        throw new Error("disconnected");
      })(),
    );
    await expect(
      e.service.upload(broken, { cwd: e.project, name: "partial.txt" }),
    ).rejects.toThrow();
    expect((await e.service.list({ cwd: e.project })).items).toHaveLength(0);
  }));

test("upload reservations reject a live writer and recover a departed process; conversation scope remains project bound", () =>
  fixture(async (e) => {
    await upload(e.service, e.project, "first.txt", "first");
    const lock = join(e.privateRoot, "remote-web-attachments/upload.lock");
    await writeFile(
      lock,
      JSON.stringify({ token: "live", owner: scheduleOwner() }),
      { mode: 0o600 },
    );
    await expect(
      upload(e.service, e.project, "blocked.txt", "x"),
    ).rejects.toMatchObject({ status: 409 });
    await writeFile(
      lock,
      JSON.stringify({
        token: "departed",
        owner: { ...scheduleOwner(), pid: 2147483647, stamp: null },
      }),
    );
    const next = await upload(e.service, e.project, "next.txt", "next");
    await e.service.resolveInput({
      ids: [next.id],
      cwd: e.project,
      threadId: "thread-A",
      bind: true,
    });
    expect(
      (
        await e.service.list({
          cwd: e.home,
          scope: "conversation",
          threadId: "thread-A",
        })
      ).items,
    ).toHaveLength(0);
    await expect(
      e.service.list({ cwd: e.project, scope: "all" }),
    ).rejects.toThrow();
  }));
