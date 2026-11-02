// Keep work logs separate from the copyable final answer. Reconciliation updates
// existing controls so polling never resets an explicit expansion choice.
export function changedFileRows(files, cwd = '') {
  const normalize = value => String(value || '').replace(/\\/g, '/').replace(/\/$/, '');
  const base = normalize(cwd);
  const rows = new Map();
  for (const file of files) {
    const source = normalize(file.path === '/dev/null' ? file.oldPath : file.path);
    let path = source.replace(/^\.\//, '');
    if (/^(\/|[A-Za-z]:\/)/.test(source)) {
      if (base) {
        const parts = source.split('/'), root = base.split('/');
        let common = 0;
        while (common < parts.length && common < root.length && parts[common] === root[common]) common++;
        path = [...root.slice(common).filter(Boolean).map(() => '..'), ...parts.slice(common)].join('/');
      } else path = source.split('/').at(-1);
    }
    const row = rows.get(path) || { path, linesAdded: 0, linesDeleted: 0 };
    row.linesAdded += file.linesAdded || 0;
    row.linesDeleted += file.linesDeleted || 0;
    rows.set(path, row);
  }
  return [...rows.values()];
}

export function createTurnPresentation({
  state,
  t,
  icon,
  toast,
  fork,
  openReview,
  getCwd = () => state.active?.cwd || state.workspaceContext?.cwd || state.config?.defaultCwd || '',
}) {
  function changeStats(file) {
    const stats = document.createElement('span');
    stats.className = 'turn-change-stats';
    const added = document.createElement('span');
    added.className = 'plus'; added.textContent = `+${file.linesAdded}`;
    const removed = document.createElement('span');
    removed.className = 'minus'; removed.textContent = `−${file.linesDeleted}`;
    stats.append(added, document.createTextNode(' '), removed);
    return stats;
  }
  function button(label, glyph, action) {
    const node = document.createElement("button");
    node.type = "button";
    node.title = t(label);
    node.setAttribute("aria-label", t(label));
    node.innerHTML = icon(glyph);
    node.onclick = action;
    return node;
  }
  function update(turnId, completed) {
    const turn = state.turns.get(turnId);
    if (!turn) return;
    if (completed !== undefined) turn.dataset.completed = String(completed);
    const done = turn.dataset.completed === "true",
      stream = turn.querySelector(".turn-event-stream"),
      body = turn.querySelector(".assistant-body"),
      slot = turn.querySelector(".turn-final-slot");
    const final = () =>
      [...slot.querySelectorAll(".message-text")]
        .map((node) => node.dataset.raw || node.textContent)
        .join("\n\n");
    const hasFinal = Boolean(final().trim()),
      divider = turn.querySelector(".worked-for-divider");
    if (!divider.querySelector("button")) {
      const label = divider.querySelector("span"),
        toggle = button("Show work", "chevronRight", () => {
          const open = toggle.getAttribute("aria-expanded") !== "true";
          turn.dataset.workExpanded = String(open);
          update(turnId);
        });
      toggle.className = "turn-work-toggle";
      body.id ||= `turn-work-${turnId}`;
      toggle.setAttribute("aria-controls", body.id);
      toggle.prepend(label);
      divider.prepend(toggle);
    }
    function applyWork() {
      const toggle = divider.querySelector("button"),
        open = turn.dataset.workExpanded === "true" || !done;
      body.hidden = done && hasFinal && !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.title = t(open ? "Hide work" : "Show work");
      toggle.setAttribute("aria-label", toggle.title);
      divider.hidden = !(done && stream.children.length && hasFinal);
    }
    applyWork();
    let more = turn.querySelector(".turn-answer-toggle");
    if (!more) {
      more = document.createElement("button");
      more.type = "button";
      more.className = "turn-answer-toggle";
      more.onclick = () => {
        turn.dataset.answerExpanded = String(
          turn.dataset.answerExpanded !== "true",
        );
        update(turnId);
      };
      slot.after(more);
    }
    const long =
      done && hasFinal && (final().length > 800 || slot.scrollHeight > 300);
    const expanded = turn.dataset.answerExpanded === "true";
    slot.classList.toggle("answer-collapsed", long && !expanded);
    more.hidden = !long;
    more.textContent = t(expanded ? "Collapse answer" : "Show full answer");
    more.setAttribute("aria-expanded", String(expanded));
    let changes = turn.querySelector(".turn-change-summary");
    const review = state.turnDiffs.get(turnId);
    if (review?.hasChanges) {
      if (!changes) {
        changes = document.createElement("details");
        changes.className = "turn-change-summary";
        more.after(changes);
      }
      const signature = JSON.stringify([
        review.files,
        review.linesAdded,
        review.linesDeleted,
        getCwd(),
      ]);
      if (changes.dataset.signature !== signature) {
        changes.dataset.signature = signature;
        changes.replaceChildren();
        const summary = document.createElement("summary");
        const files = changedFileRows(review.files, getCwd());
        summary.textContent = t("Edited {count} files", {
          count: files.length,
        });
        summary.append(changeStats(review));
        changes.append(summary);
        for (const file of files) {
          const row = document.createElement("div");
          row.className = 'turn-change-file';
          row.dataset.i18nIgnore = "";
          const path = document.createElement('span');
          path.className = 'turn-change-path';
          path.textContent = file.path;
          row.append(path, changeStats(file));
          changes.append(row);
        }
        const view = document.createElement("button");
        view.type = "button";
        view.textContent = t("View changes");
        view.onclick = () => openReview(review);
        changes.append(view);
      }
    }
    let actions = turn.querySelector(".turn-message-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "turn-message-actions";
      const copy = button("Copy answer", "copy", async () => {
        try {
          await navigator.clipboard.writeText(final());
          toast(t("Copied"));
        } catch {
          toast(t("Copy failed. Select the answer and copy it."));
        }
      });
      const branch = button("Fork in new chat", "gitBranch", async () => {
        branch.disabled = true;
        try {
          await fork({ threadId: turn.dataset.threadId, turnId });
        } catch (error) {
          toast(error.message);
        } finally {
          branch.disabled = false;
        }
      });
      actions.append(copy, branch);
      turn.append(actions);
    }
    actions.hidden = !done || !hasFinal;
  }
  return { update };
}
