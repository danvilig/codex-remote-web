import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { chromium } from "playwright";
import { root, artifact, launchOptions } from "../helpers/browser-runtime.mjs";

// Isolated project outside HOME, private uploads, deterministic native RPC only.
const temporary = await mkdtemp("/tmp/crw-attachments-");
const home = join(temporary, "home"),
  project = join(temporary, "project");
const other = join(home, "other-project"),
  codex = join(home, ".codex");
for (const dir of [home, project, other, codex])
  await mkdir(dir, { recursive: true });
await writeFile(
  join(project, "README.md"),
  "# Fixture project\nVisible in Files, not Library.",
);
await writeFile(join(other, "other.txt"), "Second conversation directory");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6wZAAAAAASUVORK5CYII=",
  "base64",
);
const log = join(temporary, "rpc.jsonl");
const port = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn(["bun", "src/server/index.ts"], {
  cwd: root,
  stdout: "ignore",
  stderr: "ignore",
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    HOME: home,
    CODEX_HOME: codex,
    CODEX_AUTH_PATH: join(codex, "auth.json"),
    CODEX_WEBUI_AUTH_MODE: "local",
    CODEX_WEBUI_CWD: project,
    CODEX_WEBUI_REVIEW_ROOT: project,
    CODEX_WEBUI_ENABLE_TERMINAL: "false",
    CODEX_WEBUI_FIXTURE_RESOURCES: "true",
    CODEX_WEBUI_FIXTURE_OTHER_CWD: other,
    CODEX_WEBUI_FIXTURE_LOG: log,
    PATH: `${join(root, "tests/fixtures")}${delimiter}${process.env.PATH}`,
  },
});
let browser,
  page,
  phase = "startup";
const entries = async () => {
  try {
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch {
    return [];
  }
};
const uploadHeaders = {
  origin: base,
  "content-type": "application/octet-stream",
  "x-workspace-request": "1",
};
const card = (name) =>
  page
    .locator(".attachment-card")
    .filter({ has: page.locator("h2", { hasText: name }) });
async function openFiles() {
  if (!(await page.locator("#sidePanel").isVisible()))
    await page.locator("#toggleSidePanel").click();
  await page.locator("#openSidePanelTab").click();
  await page.locator("[data-side-panel-action=files]").click();
}
async function addFiles(files) {
  await page.locator("[data-composer-control=add]").click();
  await page
    .getByRole("menuitem", { name: "Files and folders", exact: true })
    .click();
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("menuitem", { name: "Upload files", exact: true })
    .click();
  await (await chooser).setFiles(files);
  await page.waitForFunction(
    () =>
      !document
        .querySelector("[data-composer-control=add]")
        .hasAttribute("aria-busy"),
  );
}
try {
  for (let i = 0; ; i++) {
    try {
      if ((await (await fetch(base + "/api/health")).json()).codex) break;
    } catch {}
    if (i > 100) throw new Error("Fixture startup failed");
    await Bun.sleep(50);
  }
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({
    viewport: { width: 1074, height: 760 },
    colorScheme: "dark",
  });
  await context.addInitScript(() => {
    if (window === window.top) localStorage.setItem("codex-webui-locale", "en");
  });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => globalThis.__codexWebuiDebug?.state.connected,
  );

  phase = "Files follows the conversation";
  await page.evaluate(() =>
    globalThis.__codexWebuiDebug.openThread("thread-A"),
  );
  await openFiles();
  await page.getByRole('treeitem',{name:'README.md',exact:true}).locator('.explorer-row-line').click();
  await page.locator('.explorer-markdown').filter({hasText:'Visible in Files'}).waitFor();
  await page.evaluate(() =>
    globalThis.__codexWebuiDebug.openThread("thread-B"),
  );
  await page.getByRole('treeitem',{name:'other.txt',exact:true}).waitFor();
  assert.equal(await page.getByRole('treeitem',{name:'README.md',exact:true}).count(),0);
  assert.equal(await page.locator('#sideFileContent .resource-location').textContent(),other);
  await page.getByRole('treeitem',{name:'other.txt',exact:true}).locator('.explorer-row-line').click();
  await page.locator('.explorer-code').filter({hasText:'Second conversation directory'}).waitFor();
  const download=await page.locator('.explorer-preview').getByRole('link',{name:'Download',exact:true}).getAttribute('href');
  assert.equal(await (await fetch(base+download)).text(),'Second conversation directory');
  await page.locator("#closeSidePanel").click();
  await page.evaluate(() =>
    globalThis.__codexWebuiDebug.openThread("thread-A"),
  );
  await page.locator("#railLibrary").click();
  await page
    .locator(".workspace-feature-empty")
    .filter({ hasText: "No shared files yet" })
    .waitFor();
  assert.equal(await page.locator("#workspaceFeatureContent h2").count(), 0);
  await page.locator("#closeWorkspaceFeature").click();

  phase = "Project dropdown and keyboard";
  await page.locator("#newTask").click();
  await page.locator("#composerProjectButton").click();
  assert.equal(await page.locator("#folderDialog").isVisible(), false);
  await page
    .getByRole("searchbox", { name: "Search projects" })
    .fill("other-project");
  assert.equal(await page.locator(".composer-project-list button").count(), 3);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (other) =>
      globalThis.__codexWebuiDebug.state.workspaceContext?.cwd === other,
    other,
  );
  await page.locator("#composerProjectButton").click();
  await page
    .locator(".composer-project-list button")
    .filter({ hasText: project })
    .click();
  await page.waitForFunction(
    (project) =>
      globalThis.__codexWebuiDebug.state.workspaceContext?.cwd === project,
    project,
  );
  await page.locator("#composerProjectButton").click();
  await page
    .locator(".composer-project-list")
    .getByRole("button", { name: "New project", exact: true })
    .click();
  await page.locator("#folderDialog[open]").waitFor();
  await page.keyboard.press("Escape");

  phase = "Upload and draft persistence";
  await addFiles([
    {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Uploaded project notes"),
    },
    { name: "picture.png", mimeType: "image/png", buffer: png },
  ]);
  assert.equal(await page.locator(".composer-context-chip").count(), 2);
  await page.waitForFunction(()=>document.querySelector('.composer-attachment-thumbnail img')?.naturalWidth===1);
  await page.locator('.composer-attachment-thumbnail').click();
  await page.locator('#imageViewer[open]').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.composer-context-chip').count(),2,'preview must not remove the attachment');
  await page.locator('#prompt').focus();
  assert.equal(await page.locator('#prompt').evaluate(el=>getComputedStyle(el).outlineStyle),'none');
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(
    () => globalThis.__codexWebuiDebug?.state.connected,
  );
  assert.equal(await page.locator(".composer-context-chip").count(), 2);
  await page.waitForFunction(()=>document.querySelector('.composer-attachment-thumbnail img')?.naturalWidth===1);
  assert.equal((await entries()).length, 0, "Reload never executes a draft");
  phase = "Native file-only submission";
  await page.locator("#sendButton").click();
  await page.waitForFunction(() =>
    Boolean(globalThis.__codexWebuiDebug.state.active),
  );
  for (let i = 0; !(await entries()).length && i < 80; i++) await Bun.sleep(50);
  const requests = await entries();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "turn/start");
  assert(
    requests[0].params.input.some(
      (item) =>
        item.type === "localImage" &&
        item.path.startsWith(codex + "/remote-web-attachments/"),
    ),
  );
  assert.match(
    requests[0].params.input.find((item) => item.type === "text").text,
    /Attached file "notes.txt"/,
  );
  assert.equal(await page.locator(".composer-context-chip").count(), 0);
  const threadId = requests[0].params.threadId;
  const imagePath=requests[0].params.input.find(item=>item.type==='localImage').path;
  const uploadedImages=page.locator(`.user-message-images .message-image-button[data-image-path=${JSON.stringify(imagePath)}]`);
  await page.waitForFunction(()=>document.querySelector('.user-message-images img')?.naturalWidth===1);
  await uploadedImages.first().click();
  await page.locator('#imageViewer[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.screenshot({path:artifact('user-uploaded-image-message.png')});
  // Replay a native Desktop image-only user message; no model request is sent.
  await page.evaluate(({threadId,imagePath})=>globalThis.__codexWebuiDebug.notify('item/completed',{threadId,turnId:'desktop-images',item:{id:'desktop-user-image',type:'userMessage',content:[{type:'localImage',path:imagePath}]}}),{threadId,imagePath});
  await page.waitForFunction(path=>[...document.querySelectorAll('.user-message-images .message-image-button')].filter(button=>button.dataset.imagePath===path&&button.querySelector('img')?.naturalWidth===1).length===2,imagePath);

  phase = "Library upload previews and downloads";
  await page.locator("#railLibrary").click();
  await card("notes.txt").waitFor();
  assert.equal(
    await page.locator("#libraryScope").inputValue(),
    "conversation",
  );
  await card("notes.txt")
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  await card("notes.txt")
    .locator("pre")
    .filter({ hasText: "Uploaded project notes" })
    .waitFor();
  const fileUrl = await card("notes.txt")
    .getByRole("link", { name: "Download", exact: true })
    .getAttribute("href");
  const downloaded = await fetch(base + fileUrl);
  assert.equal(await downloaded.text(), "Uploaded project notes");
  assert.match(downloaded.headers.get("content-disposition"), /^attachment;/);
  assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
  await card("picture.png")
    .getByRole("button", { name: "View image", exact: true })
    .click();
  await page.locator("#imageViewer[open]").waitFor();
  await page.waitForFunction(
    () => document.querySelector("#imageViewerImage").naturalWidth === 1,
  );
  await page.locator("#closeImageViewer").click();
  await page.screenshot({ path: artifact("attachments-library.png") });
  await card("notes.txt")
    .getByRole("button", { name: "Reference in chat", exact: true })
    .click();
  assert.equal(await page.locator(".composer-context-chip").count(), 1);
  await page.locator(".composer-context-chip button").click();
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(
    () => globalThis.__codexWebuiDebug?.state.connected,
  );
  assert.equal(
    (await entries()).length,
    1,
    "Reload after submit never repeats execution",
  );
  const bound = await (
    await fetch(
      base +
        "/api/attachments?" +
        new URLSearchParams({ cwd: project, threadId, scope: "conversation" }),
    )
  ).json();
  assert.equal(bound.items.length, 2);

  phase = "Uploaded image gallery";
  await page.locator("#railImages").click();
  await page.locator('.resource-image-card img[alt="picture.png"]').waitFor();
  await page.locator("#closeWorkspaceFeature").click();

  phase = "Navigation while uploading and safe send failure";
  let releaseUpload, uploadStarted;
  const held = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const started = new Promise((resolve) => {
    uploadStarted = resolve;
  });
  await page.route("**/api/attachments/upload?*", async (route) => {
    uploadStarted();
    await held;
    await route.continue();
  });
  await page
    .locator('input[type=file][data-composer-scope=main][aria-label="Upload files"]')
    .setInputFiles({
      name: "late.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Late response"),
    });
  await started;
  await page.evaluate(() =>
    globalThis.__codexWebuiDebug.openThread("thread-B"),
  );
  releaseUpload();
  await page.waitForFunction(
    () =>
      !document
        .querySelector("[data-composer-control=add]")
        .hasAttribute("aria-busy"),
  );
  assert.equal(
    await page.locator(".composer-context-chip").count(),
    0,
    "Upload must stay with its original draft",
  );
  await page.unroute("**/api/attachments/upload?*");
  await page.evaluate(
    (id) => globalThis.__codexWebuiDebug.openThread(id),
    threadId,
  );
  await page
    .locator(".composer-context-chip")
    .filter({ hasText: "late.txt" })
    .waitFor();
  await page.route("**/api/attachments/resolve", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: '{"error":"Unavailable"}',
    }),
  );
  await page.locator("#prompt").fill("Keep this message");
  await page.locator("#sendButton").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#sendButton").disabled &&
      document.querySelector("#prompt").value === "Keep this message",
  );
  assert.equal(
    await page.locator(".composer-context-chip").count(),
    1,
    "Failed resolution preserves attachments",
  );
  assert.equal(
    (await entries()).length,
    1,
    "A failed attachment resolution cannot execute a turn",
  );
  await page.unroute("**/api/attachments/resolve");
  await page.locator(".composer-context-chip button").click();
  await page.locator("#prompt").fill("");

  phase = "HTTP upload protection";
  const uploadUrl =
    base +
    "/api/attachments/upload?" +
    new URLSearchParams({ cwd: project, name: "bad.svg" });
  for (const headers of [
    {},
    { ...uploadHeaders, origin: "https://evil.example" },
  ]) {
    assert(
      [401, 403].includes(
        (await fetch(uploadUrl, { method: "POST", headers, body: "x" })).status,
      ),
    );
  }
  const svgResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: uploadHeaders,
    body: '<svg onload="alert(1)"/>',
  });
  const svg = await svgResponse.json();
  assert.equal(svg.image, false);
  const svgFile = await fetch(
    base +
      "/api/attachments/file?" +
      new URLSearchParams({ id: svg.id, view: "image" }),
  );
  assert.equal(svgFile.headers.get("content-type"), "application/octet-stream");
  const denied = await fetch(base + "/api/attachments/resolve", {
    method: "POST",
    headers: { ...uploadHeaders, "content-type": "application/json" },
    body: JSON.stringify({ ids: [svg.id], cwd: other }),
  });
  assert.equal(denied.status, 400);
  const escape = await fetch(
    base +
      "/api/attachments/upload?" +
      new URLSearchParams({ cwd: temporary, name: "file.txt" }),
    { method: "POST", headers: uploadHeaders, body: "x" },
  );
  assert.equal(escape.status, 400);
  const tooLarge = await fetch(uploadUrl, {
    method: "POST",
    headers: uploadHeaders,
    body: Buffer.alloc(20 * 1024 * 1024 + 1),
  });
  assert.equal(tooLarge.status, 413);

  phase = "Projectless paste and remote file picker";
  await page.evaluate(() => globalThis.__codexWebuiDebug.startNewTask());
  await page.locator("#composerProjectButton").click();
  await page
    .locator(".composer-project-list")
    .getByRole("button", { name: "Don't work in a project", exact: true })
    .click();
  await page.locator("#prompt").evaluate((input) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["Pasted content"], "pasted.txt", { type: "text/plain" }),
    );
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page
    .locator(".composer-context-chip")
    .filter({ hasText: "pasted.txt" })
    .waitFor();
  const homeFiles = await (
    await fetch(base + "/api/attachments?" + new URLSearchParams({ cwd: home }))
  ).json();
  assert(homeFiles.items.some((item) => item.name === "pasted.txt"));
  await page.locator("[data-composer-control=add]").click();
  await page
    .getByRole("menuitem", { name: "Files and folders", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Add remote files", exact: true })
    .click();
  await page.locator(".resource-location").filter({ hasText: home }).waitFor();
  await page.locator("#closeSidePanel").click();
  await page.locator("[data-composer-control=add]").click();
  await page.getByRole("menuitem", { name: "Plan mode", exact: true }).click();
  assert.equal(
    await page.evaluate(() => globalThis.__codexWebuiDebug.state.planMode),
    true,
  );

  phase = "Small desktop/tablet/mobile composer";
  await page.evaluate(() => globalThis.__codexWebuiDebug.startNewTask());
  for (const width of [1074, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() =>
      globalThis.__codexWebuiDebug.setSidebarOpen(false),
    );
    const layout = await page.evaluate(() => {
      const composer = document
        .querySelector("#composer")
        .getBoundingClientRect();
      const left = document
          .querySelector(".composer-left")
          .getBoundingClientRect(),
        right = document
          .querySelector(".composer-right")
          .getBoundingClientRect();
      return {
        fits: composer.left >= 0 && composer.right <= innerWidth + 1,
        separated:
          left.right <= right.left + 1 ||
          left.bottom <= right.top + 1 ||
          right.bottom <= left.top + 1,
      };
    });
    assert(layout.fits && layout.separated, `Composer fits at ${width}`);
    await page.locator("#composerProjectButton").click();
    const popup = await page.locator(".composer-project-popup").boundingBox();
    assert(popup.x >= 0 && popup.x + popup.width <= width + 1);
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1074, height: 760 });
  await page.screenshot({ path: artifact("attachments-composer.png") });
  assert.equal(
    await page
      .locator("#emptyState svg")
      .evaluate((svg) => getComputedStyle(svg).fill),
    "none",
  );
  assert.equal(await page.locator("#effortSelect").isVisible(), false);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: conversation Files, project dropdown, upload/draft/native submission, shared Library, uploaded images, HTTP guards and responsive composer",
  );
} catch (error) {
  console.error("Phase:", phase);
  if (page)
    await page
      .screenshot({ path: artifact("attachments-failure.png") })
      .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  server.kill();
  await server.exited;
  await rm(temporary, { recursive: true, force: true });
}
