// Keep work logs separate from the copyable final answer. Reconciliation updates
// existing controls so polling never resets an explicit expansion choice.
import { highlightFences } from './code-editor.js';
import { updateAnswerLinks } from './message-links.js';

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
    row.reference = file.path === '/dev/null' ? null : source;
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
    slot.classList.toggle("is-streaming", !done && hasFinal);
    if (done && hasFinal) highlightFences(slot);
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
        runtime = turn.querySelector(".runtime-progress"),
        open = (runtime?.open ?? (turn.dataset.workExpanded === "true")) || !done;
      body.hidden = !runtime && done && !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.title = t(open ? "Hide work" : "Show work");
      toggle.setAttribute("aria-label", toggle.title);
      divider.hidden = !(done && stream.children.length);
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
      done && hasFinal && !slot.querySelector('.message-html-preview') && (final().length > 800 || slot.scrollHeight > 300);
    const expanded = turn.dataset.answerExpanded === "true";
    slot.classList.toggle("answer-collapsed", long && !expanded);
    more.hidden = !long;
    more.textContent = t(expanded ? "Collapse answer" : "Show full answer");
    more.setAttribute("aria-expanded", String(expanded));
    let changes = turn.querySelector(".turn-change-summary");
    const review = state.turnDiffs.get(turnId);
    const showChanges = done && Boolean(review?.hasChanges);
    if (changes) changes.hidden = !showChanges;
    if (showChanges) {
      if (!changes) {
        changes = document.createElement("details");
        changes.className = "turn-change-summary";
        more.after(changes);
      }
      const cwd = getCwd();
      const signature = JSON.stringify([
        review.files,
        review.linesAdded,
        review.linesDeleted,
        cwd,
      ]);
      if (changes.dataset.signature !== signature) {
        changes.dataset.signature = signature;
        changes.replaceChildren();
        const summary = document.createElement("summary");
        const files = changedFileRows(review.files, cwd);
        summary.textContent = t(files.length === 1 ? "Edited 1 file" : "Edited {count} files", {
          count: files.length,
        });
        summary.append(changeStats(review));
        changes.append(summary);
        for (const file of files) {
          const row = document.createElement(file.reference ? "a" : "div");
          row.className = 'turn-change-file';
          row.dataset.i18nIgnore = "";
          if (file.reference) {
            row.href = '#file-reference';
            row.dataset.fileReference = file.reference;
            if (cwd) row.dataset.fileCwd = cwd;
          }
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
      let copyTimer;
      const copy = button("Copy answer", "copy", async () => {
        try {
          await navigator.clipboard.writeText(final());
          if (copyIcon.parentNode === copy) copyIcon.replaceWith(copyConfirmation);
          clearTimeout(copyTimer);
          copyTimer = setTimeout(() => copyConfirmation.replaceWith(copyIcon), 1800);
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
      const copyIcon = copy.querySelector(".icon-slot");
      const iconTemplate = document.createElement("template");
      iconTemplate.innerHTML = icon("check", "turn-copy-confirmation");
      const copyConfirmation = iconTemplate.content.firstElementChild;
      for (const [control, label] of [[copy, "Copy answer"], [branch, "Fork in new chat"]]) {
        const caption = document.createElement("span");
        caption.textContent = t(label);
        control.append(caption);
      }
      actions.append(copy, branch);
      turn.append(actions);
    }
    actions.hidden = !done || !hasFinal;
    updateAnswerLinks(turn, slot, done && hasFinal);
  }
  return { update };
}
