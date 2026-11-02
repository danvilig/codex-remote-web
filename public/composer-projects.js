export function createComposerProjects({
  anchor,
  state,
  t,
  icon,
  choose,
  add,
}) {
  let popup;
  function close() {
    popup?.remove();
    popup = null;
    anchor.setAttribute("aria-expanded", "false");
  }
  function open() {
    if (popup) {
      close();
      return;
    }
    const panel = document.createElement("div");
    popup = panel;
    panel.className = "composer-project-popup";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", t("Choose project"));
    anchor.setAttribute("aria-expanded", "true");
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = t("Search projects");
    search.setAttribute("aria-label", t("Search projects"));
    const list = document.createElement("div");
    list.className = "composer-project-list";
    panel.append(search, list);
    let saved = [];
    try {
      saved =
        JSON.parse(localStorage.getItem("codex-remote-web-projects")) || [];
    } catch {}
    if (!Array.isArray(saved)) saved = [];
    const projects = [
      ...new Set(
        [
          state.workspaceContext?.cwd,
          state.config.defaultCwd,
          ...saved,
          ...state.threads.map((thread) => thread.cwd),
        ].filter((path) => typeof path === "string" && path.startsWith("/")),
      ),
    ];
    const selected = state.projectless ? null : state.workspaceContext?.cwd;
    function row(label, glyph, action, checked = false) {
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = icon(glyph);
      const text = document.createElement("span");
      text.className = "composer-project-copy";
      text.textContent = label;
      button.append(text);
      if (checked) button.insertAdjacentHTML("beforeend", icon("check"));
      button.onclick = () => {
        close();
        action();
      };
      return button;
    }
    function render() {
      list.replaceChildren();
      for (const path of projects.filter((path) =>
        path.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()),
      )) {
        const button = row(
          path.split("/").filter(Boolean).at(-1) || path,
          "folderOpen",
          () => choose(path),
          selected === path,
        );
        button.dataset.i18nIgnore = "";
        button.title = path;
        const subtitle = document.createElement("small");
        subtitle.textContent = path;
        button.querySelector(".composer-project-copy").append(subtitle);
        list.append(button);
      }
      list.append(
        row(t("New project"), "plus", add),
        row(
          t("Don't work in a project"),
          "x",
          () => choose("~"),
          selected === null,
        ),
      );
    }
    search.oninput = render;
    panel.onkeydown = (event) => {
      const buttons = [...list.querySelectorAll("button")],
        index = buttons.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        anchor.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        buttons[
          index < 0
            ? event.key === "ArrowDown"
              ? 0
              : buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length
        ]?.focus();
      }
    };
    document.body.append(panel);
    render();
    const box = anchor.getBoundingClientRect();
    panel.style.width = `${Math.min(350, innerWidth - 24)}px`;
    const height = panel.getBoundingClientRect().height;
    panel.style.left = `${Math.max(12, Math.min(box.left, innerWidth - panel.offsetWidth - 12))}px`;
    panel.style.top = `${Math.max(12, box.top - height - 8)}px`;
    search.focus();
  }
  document.addEventListener("pointerdown", (event) => {
    if (
      popup &&
      !popup.contains(event.target) &&
      !anchor.contains(event.target)
    )
      close();
  });
  addEventListener("resize", close);
  addEventListener("popstate", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab") close();
  });
  return { open, close };
}
