import { renderImagePreview } from './rendering.js';

// The server's opaque ID endpoint enforces attachment ownership and content type.
// No client filename/path becomes an arbitrary image URL.
export function attachmentThumbnail(mention) {
  if (mention.source !== 'attachment' || mention.icon !== 'image' || !/^[a-f0-9-]{36}$/i.test(mention.id)) return '';
  return renderImagePreview(`/api/attachments/file?id=${encodeURIComponent(mention.id)}&view=image`, { title: mention.title, className: 'composer-attachment-thumbnail' });
}

export function createComposerAttachments({
  state,
  t,
  menu,
  anchor,
  prompt,
  draftKey,
  applyToDraft,
  toast,
  setBusy,
  openFiles,
  togglePlan,
  extraItems,
  scope = "main",
}) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  input.dataset.composerScope = scope;
  input.setAttribute("aria-label", t("Upload files"));
  document.body.append(input);
  const folder = document.createElement("input");
  folder.type = "file";
  folder.multiple = true;
  folder.setAttribute("webkitdirectory", "");
  folder.hidden = true;
  folder.dataset.composerScope = scope;
  document.body.append(folder);
  let uploading = false;
  const cwd = () =>
    state.active?.cwd ||
    (state.projectless
      ? state.config.home
      : state.workspaceContext?.cwd || state.config.defaultCwd);
  async function upload(files) {
    if (uploading) return;
    const entries = [...files];
    if (!entries.length) return;
    if (
      entries.length +
        state.composerMentions.filter((item) => item.source === "attachment")
          .length >
        20 ||
      entries.some((file) => file.size > 20 * 1024 * 1024)
    ) {
      toast(t("Choose up to 20 files, at most 20 MiB each."));
      return;
    }
    const key = draftKey(),
      project = cwd();
    uploading = true;
    setBusy(true);
    anchor.setAttribute("aria-busy", "true");
    const uploaded = [];
    try {
      for (const file of entries) {
        const response = await fetch(
          "/api/attachments/upload?" +
            new URLSearchParams({ cwd: project, name: file.name }),
          {
            method: "POST",
            headers: {
              "content-type": "application/octet-stream",
              "x-workspace-request": "1",
            },
            body: file,
          },
        );
        const result = await response.json();
        if (!response.ok) throw new Error(t(result.error));
        uploaded.push({
          id: result.id,
          source: "attachment",
          title: result.name,
          icon: result.image ? "image" : "file",
        });
        applyToDraft(key, uploaded);
        uploaded.length = 0;
      }
    } catch (error) {
      toast(error.message || t("Upload failed"));
    } finally {
      uploading = false;
      setBusy(false);
      anchor.removeAttribute("aria-busy");
      input.value = "";
      folder.value = "";
    }
  }
  input.onchange = () => upload(input.files);
  folder.onchange = () => upload(folder.files);
  anchor.onclick = async () => {
    if(uploading)return;
    const project=cwd(),thread=state.active?.id;
    const extra=await extraItems();
    if(project!==cwd()||thread!==state.active?.id)return;
    menu.open(anchor, [
      {
        label: "Files and folders",
        icon: "paperclip",
        children: [
          { label: "Upload files", icon: "file", action: () => input.click() },
          {
            label: "Upload folder",
            icon: "folder",
            action: () => folder.click(),
          },
          { label: "Add remote files", icon: "folderOpen", action: openFiles },
        ],
      },
      {
        label: state.planMode ? "Turn plan mode off" : "Plan mode",
        icon: "list",
        action: togglePlan,
      },
      ...extra,
    ]);
  };
  prompt.addEventListener("paste", (event) => {
    const files = event.clipboardData?.files;
    if (files?.length) {
      event.preventDefault();
      void upload(files);
    }
  });
  const composer = prompt.closest("form");
  composer.addEventListener("dragover", (event) => {
    if ([...event.dataTransfer.types].includes("Files")) {
      event.preventDefault();
      composer.classList.add("attachment-dragover");
    }
  });
  composer.addEventListener("dragleave", (event) => {
    if (!composer.contains(event.relatedTarget))
      composer.classList.remove("attachment-dragover");
  });
  composer.addEventListener("drop", (event) => {
    composer.classList.remove("attachment-dragover");
    if (event.dataTransfer.files.length) {
      event.preventDefault();
      void upload(event.dataTransfer.files);
    }
  });
  async function prepare(mentions, cwd, threadId, bind = false) {
    const ids = mentions
      .filter((item) => item.source === "attachment")
      .map((item) => item.id);
    if (!ids.length) return [];
    const response = await fetch("/api/attachments/resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-workspace-request": "1",
      },
      body: JSON.stringify({ ids, cwd, threadId, bind }),
    });
    if (!response.ok)
      throw new Error(
        t(
          "Attachment unavailable. Check the file, project and storage permissions.",
        ),
      );
    return (await response.json()).items;
  }
  return {
    prepare,
    upload,
    get busy() {
      return uploading;
    },
  };
}
