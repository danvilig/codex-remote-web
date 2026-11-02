import {
  mkdir,
  open,
  lstat,
  readdir,
  rm,
  rename,
  realpath,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { resolveBrowsePath, isDirectory } from "../files/folders.js";
import { scheduleOwnerAlive } from "./schedule-store.js";
import { acquirePrivateLock } from "./private-lock.js";
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024,
  MAX_COUNT = 1000;
const validId = (id) =>
  typeof id === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const threadKey = (id) => createHash("sha256").update(id).digest("hex");
const raster = (data, name) =>
  /\.(png|jpe?g|gif|webp)$/i.test(name) &&
  ((data
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    /\.png$/i.test(name)) ||
    (data[0] === 255 &&
      data[1] === 216 &&
      data[2] === 255 &&
      /\.jpe?g$/i.test(name)) ||
    (/^GIF8[79]a/.test(data.subarray(0, 6).toString()) &&
      /\.gif$/i.test(name)) ||
    (data.subarray(0, 4).toString() === "RIFF" &&
      data.subarray(8, 12).toString() === "WEBP" &&
      /\.webp$/i.test(name)));
const services = new Map();
export function createAttachmentService(options) {
  const root = join(options.privateRoot, "remote-web-attachments");
  if (services.has(root)) return services.get(root);
  let uploading = false;
  async function safeDirectory(path, create = false) {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw new Error("Unsafe attachment directory");
    return path;
  }
  async function initialize() {
    await safeDirectory(root, true);
  }
  // Uploads, thread binding and developer cleanup share one stable SQLite
  // lock inode across gateways; ownership markers never authorize unlinking.
  const lock = join(root, "upload.lock");
  async function acquireUpload() {
    await safeDirectory(root);
    try {
      return await acquirePrivateLock(lock, { timeoutMs: 0, legacyOwnerAlive: scheduleOwnerAlive });
    } catch (error) {
      if (error.status === 409) error.message = "Another upload or storage operation is in progress";
      throw error;
    }
  }
  async function releaseUpload(release) { await release(); }
  async function safeRead(path, limit) {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        stat.size > limit
      )
        throw new Error("Unsafe attachment file");
      return await fd.readFile();
    } finally {
      await fd.close();
    }
  }
  async function project(cwd) {
    if (typeof cwd !== "string") throw new Error("Choose a project");
    const path = await realpath(
      resolveBrowsePath(cwd, options.browseRoots, options.home),
    );
    if (!isDirectory(path)) throw new Error("Unavailable project");
    return path;
  }
  async function record(id) {
    if (!validId(id)) throw new Error("Invalid attachment");
    await safeDirectory(root);
    const directory = await safeDirectory(join(root, id));
    const data = JSON.parse(
      (await safeRead(join(directory, "metadata.json"), 16384)).toString(),
    );
    if (
      data.id !== id ||
      data.format !== 1 ||
      typeof data.name !== "string" ||
      typeof data.cwd !== "string"
    )
      throw new Error("Invalid attachment");
    return data;
  }
  async function list({ cwd, threadId, scope = "project", query = "" }) {
    if (!["project", "conversation"].includes(scope))
      throw new Error("Invalid attachment scope");
    const selected = await project(cwd);
    if (
      scope === "conversation" &&
      (typeof threadId !== "string" || threadId.length > 256)
    )
      throw new Error("Choose a conversation");
    try {
      await safeDirectory(root);
    } catch (error) {
      if (error.code === "ENOENT") return { items: [] };
      throw error;
    }
    const items = [];
    for (const entry of (await readdir(root))
      .filter(validId)
      .slice(0, MAX_COUNT)) {
      try {
        const item = await record(entry);
        if (scope === "conversation") {
          const link = JSON.parse(
            (
              await safeRead(
                join(root, entry, `thread-${threadKey(threadId)}.json`),
                2048,
              )
            ).toString(),
          );
          if (link.threadId !== threadId) continue;
        }
        if (item.cwd !== selected) continue;
        if (
          !item.name
            .toLocaleLowerCase()
            .includes(String(query).toLocaleLowerCase().slice(0, 200))
        )
          continue;
        items.push(item);
      } catch {}
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items };
  }
  async function upload(stream, { cwd, name }) {
    if (uploading) {
      const error = new Error("Another upload is in progress");
      error.status = 409;
      throw error;
    }
    uploading = true;
    let directory, lockToken;
    try {
      const selected = await project(cwd);
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 240 ||
        /[\x00-\x1f\x7f/\\]/.test(name) ||
        name === "." ||
        name === ".."
      )
        throw new Error("Invalid filename");
      await initialize();
      lockToken = await acquireUpload();
      const entries = (await readdir(root)).filter(validId);
      if (entries.length >= MAX_COUNT)
        throw new Error("Attachment count limit reached");
      let total = 0;
      for (const id of entries) {
        try {
          total += (await record(id)).bytes || 0;
        } catch {}
      }
      const declared = Number(stream.headers?.["content-length"]);
      if (
        Number.isFinite(declared) &&
        (declared > ATTACHMENT_MAX_BYTES || declared + total > MAX_TOTAL)
      )
        throw Object.assign(new Error("Attachment exceeds storage limits"), {
          status: 413,
        });
      const id = randomUUID();
      directory = join(root, id);
      await mkdir(directory, { mode: 0o700 });
      const temporary = join(directory, "upload.part"),
        fd = await open(temporary, "wx", 0o600);
      let bytes = 0,
        head = Buffer.alloc(0);
      try {
        for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
          const data = Buffer.from(chunk);
          bytes += data.length;
          if (bytes > ATTACHMENT_MAX_BYTES || bytes + total > MAX_TOTAL)
            throw Object.assign(
              new Error("Attachment exceeds storage limits"),
              { status: 413 },
            );
          if (head.length < 16)
            head = Buffer.concat([head, data.subarray(0, 16 - head.length)]);
          await fd.writeFile(data);
        }
        await fd.sync();
      } finally {
        await fd.close();
      }
      const item = {
        format: 1,
        id,
        name,
        cwd: selected,
        bytes,
        image: Boolean(raster(head, name)),
        createdAt: new Date().toISOString(),
      };
      await rename(
        temporary,
        join(
          directory,
          "content" +
            extname(name)
              .toLowerCase()
              .replace(/[^.a-z0-9]/g, "")
              .slice(0, 16),
        ),
      );
      const metadata = await open(
        join(directory, "metadata.json"),
        "wx",
        0o600,
      );
      try {
        await metadata.writeFile(JSON.stringify(item));
        await metadata.sync();
      } finally {
        await metadata.close();
      }
      directory = null;
      return item;
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        if (lockToken) await releaseUpload(lockToken);
        uploading = false;
      }
    }
  }
  async function file(id) {
    const item = await record(id),
      path = join(
        root,
        id,
        "content" +
          extname(item.name)
            .toLowerCase()
            .replace(/[^.a-z0-9]/g, "")
            .slice(0, 16),
      );
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat();
      if (
        !stat.isFile() ||
        stat.size !== item.bytes ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077
      )
        throw new Error("Unsafe attachment file");
      return { item, path, fd };
    } catch (error) {
      await fd.close();
      throw error;
    }
  }
  async function resolveInput({ ids, cwd, threadId, bind = false }) {
    if (typeof bind !== "boolean") throw new Error("Invalid attachment action");
    if (
      !Array.isArray(ids) ||
      ids.length > 20 ||
      ids.some((id) => !validId(id)) ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Invalid attachments");
    const selected = await project(cwd),
      items = [];
    if (
      bind &&
      (typeof threadId !== "string" || !threadId || threadId.length > 256)
    )
      throw new Error("Invalid conversation");
    for (const id of ids) {
      const opened = await file(id);
      await opened.fd.close();
      if (opened.item.cwd !== selected)
        throw new Error("Attachment belongs to another project");
      items.push({ ...opened.item, path: opened.path });
    }
    // Cleanup uses the same cross-gateway lock. Binding must not race a previewed
    // unbound attachment being removed; revalidate the files after taking it.
    let bindLock;
    if (bind) bindLock = await acquireUpload();
    try {
    if (bind) {
      for (const item of items) { const opened = await file(item.id); await opened.fd.close(); }
      for (const item of items) {
        const path = join(root, item.id, `thread-${threadKey(threadId)}.json`);
        try {
          const fd = await open(path, "wx", 0o600);
          try {
            await fd.writeFile(JSON.stringify({ threadId }));
          } finally {
            await fd.close();
          }
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
    }
    } finally { if (bindLock) await releaseUpload(bindLock); }
    return { items };
  }
  async function preview(id) {
    const opened = await file(id);
    try {
      if (opened.item.bytes > 256 * 1024)
        throw new Error("File too large to preview");
      const data = await opened.fd.readFile();
      if (data.includes(0)) throw new Error("Binary preview unavailable");
      return { text: data.toString("utf8"), name: opened.item.name };
    } finally {
      await opened.fd.close();
    }
  }
  const service = { list, upload, file, resolveInput, preview };
  services.set(root, service);
  return service;
}
