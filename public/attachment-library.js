import { renderAssistantMarkdown, agentMessageText } from "./rendering.js";
export function createAttachmentLibrary({
  container,
  search,
  state,
  t,
  reference,
  openImage,
  openChat,
  rpc,
  isCurrent,
}) {
  let scope = "project",
    generation = 0;
  const node = (tag, text = "", cls = "") => {
    const el = document.createElement(tag);
    el.textContent = text;
    el.className = cls;
    return el;
  };
  const cwd = () =>
    state.active?.cwd ||
    (state.projectless
      ? state.config.home
      : state.workspaceContext?.cwd || state.config.defaultCwd);
  const button = (text, action) => {
    const el = node("button", t(text), "settings-action");
    el.type = "button";
    el.onclick = action;
    return el;
  };
  async function preview(url, article) {
    let pre = article.querySelector("pre");
    if (pre) {
      pre.remove();
      return;
    }
    pre = node("pre", t("Loading…"), "resource-file-preview");
    pre.dataset.i18nIgnore = "";
    article.append(pre);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error();
      pre.textContent = (await response.json()).text;
    } catch {
      pre.textContent = t(
        "Preview unavailable. Download this file to open it.",
      );
    }
  }
  function card(item) {
    const article = node(
      "article",
      "",
      "workspace-resource-card attachment-card",
    );
    article.dataset.attachmentId = item.id || "";
    const heading = node("h2", item.name);
    heading.dataset.i18nIgnore = "";
    const subtitle = node("small", item.threadName || t("Project uploads"));
    if (item.threadName) subtitle.dataset.i18nIgnore = "";
    article.append(heading, subtitle);
    const url =
      item.url ||
      "/api/attachments/file?" + new URLSearchParams({ id: item.id });
    if (item.image) {
      const image = node("img");
      image.src = url + "&view=image";
      image.alt = item.name;
      image.loading = "lazy";
      const view = button("View image", () => openImage(image.src, item.name));
      view.setAttribute("aria-label", t("View image"));
      view.prepend(image);
      article.append(view);
    }
    article.append(
      button("Preview", () =>
        preview(
          item.preview ||
            "/api/attachments/preview?" + new URLSearchParams({ id: item.id }),
          article,
        ),
      ),
    );
    const link = node("a", t("Download"), "settings-action");
    link.href = url;
    link.download = item.name;
    article.append(link);
    article.append(
      button("Reference in chat", () =>
        reference(
          item.id
            ? {
                id: item.id,
                source: "attachment",
                title: item.name,
                icon: item.image ? "image" : "file",
              }
            : `@${item.path}`,
        ),
      ),
    );
    if (item.threadId)
      article.append(button("Open chat", () => openChat(item.threadId)));
    return article;
  }
  async function history(list, request) {
    const chats = (
        scope === "conversation"
          ? [state.active]
          : state.threads.filter((chat) => chat.cwd === cwd())
      )
        .filter(Boolean)
        .slice(0, 20),
      seen = new Set();
    for (let i = 0; i < chats.length; i += 3) {
      const group = chats.slice(i, i + 3),
        responses = await Promise.allSettled(
          group.map((chat) =>
            rpc("thread/turns/list", {
              threadId: chat.id,
              limit: 20,
              sortDirection: "desc",
              itemsView: "full",
            }),
          ),
        );
      if (request !== generation || !isCurrent()) return;
      responses.forEach((response, index) => {
        if (response.status !== "fulfilled") return;
        const chat = group[index];
        for (const turn of response.value.data || [])
          for (const item of turn.items || []) {
            if (item.type !== "agentMessage") continue;
            const template = document.createElement("template");
            template.innerHTML = renderAssistantMarkdown(
              agentMessageText(item),
              { cwd: chat.cwd },
            );
            for (const link of template.content.querySelectorAll(
              "a[data-file-download]",
            )) {
              const url = new URL(link.href, location.origin);
              if (
                url.origin !== location.origin ||
                url.pathname !== "/api/files/download"
              )
                continue;
              const path = url.searchParams.get("path");
              if (
                !path ||
                seen.has(path) ||
                !`${link.textContent} ${path}`
                  .toLocaleLowerCase()
                  .includes(search.value.trim().toLocaleLowerCase())
              )
                continue;
              seen.add(path);
              list.querySelector(".workspace-feature-empty")?.remove();
              list.append(
                card({
                  name: link.textContent || path.split("/").at(-1),
                  path,
                  url: url.pathname + url.search,
                  preview:
                    "/api/library/preview?" + new URLSearchParams({ path }),
                  threadId: chat.id,
                  threadName: chat.name || chat.id,
                }),
              );
            }
          }
      });
    }
  }
  async function load() {
    const request = ++generation;
    container.replaceChildren();
    const bar = node("div", "", "resource-toolbar"),
      select = node("select", "", "settings-select");
    select.id = "libraryScope";
    select.setAttribute("aria-label", t("Library source"));
    select.append(
      new Option(t("Project uploads"), "project"),
      new Option(t("Current conversation"), "conversation"),
    );
    select.value = scope;
    select.options[1].disabled = !state.active;
    select.onchange = () => {
      scope = select.value;
      load();
    };
    bar.append(select, button("Refresh", load));
    container.append(
      bar,
      node(
        "p",
        t(
          "Uploaded files and files shared in recent conversations. Server folders are available in Files.",
        ),
        "settings-note",
      ),
    );
    const list = node("div", "", "resource-list");
    container.append(list);
    try {
      const response = await fetch(
        "/api/attachments?" +
          new URLSearchParams({
            cwd: cwd(),
            scope,
            threadId: state.active?.id || "",
            query: search.value.trim(),
          }),
      );
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (request !== generation || !isCurrent()) return;
      for (const item of result.items) list.append(card(item));
      await history(list, request);
      if (!list.children.length)
        list.append(
          node(
            "p",
            t(
              "No shared files yet. Add files from the composer to see them here.",
            ),
            "workspace-feature-empty",
          ),
        );
    } catch {
      if (request === generation && isCurrent())
        list.append(
          node("p", t("Unable to load shared files"), "settings-note"),
        );
    }
  }
  return {
    open() {
      scope = state.active ? "conversation" : "project";
      return load();
    },
    search: load,
    close() {
      generation++;
    },
  };
}
