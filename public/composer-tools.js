export function createComposerTools({
  state,
  t,
  icon,
  toast,
  ensureThread,
  onGoalChanged,
  addSkill,
  scope = 'main',
}) {
  const cwd = () =>
    state.active?.cwd ||
    (state.projectless
      ? state.config.home
      : state.workspaceContext?.cwd || state.config.defaultCwd);
  async function json(path, payload) {
    const response = await fetch(
      path,
      payload
        ? {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-workspace-request": "1",
            },
            body: JSON.stringify(payload),
          }
        : { cache: "no-store" },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(t(result.error || "Action unavailable"));
    return result;
  }
  const dialog = document.createElement("dialog");
  dialog.className = "composer-goal-dialog";
  dialog.dataset.composerScope = scope;
  dialog.setAttribute("aria-label", t("Goal"));
  const form = document.createElement("form"),
    title = document.createElement("h2");
  title.textContent = t("Goal");
  const description = document.createElement("p");
  description.className = "settings-note";
  description.textContent = t(
    "Save a persistent objective for this chat. Send a message to begin.",
  );
  const objective = document.createElement("textarea");
  objective.rows = 5;
  objective.maxLength = 16000;
  objective.required = true;
  objective.placeholder = t("What should Codex keep pursuing?");
  objective.setAttribute("aria-label", t("Goal objective"));
  const budget = document.createElement("input");
  budget.type = "number";
  budget.min = "1";
  budget.max = "1000000000";
  budget.step = "1";
  budget.placeholder = t("Token budget (optional)");
  budget.setAttribute("aria-label", t("Token budget (optional)"));
  const status = document.createElement("p");
  status.className = "settings-note";
  status.role = "status";
  const actions = document.createElement("div");
  actions.className = "goal-actions";
  const button = (label, action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t(label);
    button.onclick = action;
    return button;
  };
  const cancel = button("Cancel", () => dialog.close()),
    save = button("Save goal", () => form.requestSubmit()),
    pause = button("Pause goal", () => mutate("pause")),
    resume = button("Resume goal", () => mutate("resume")),
    clear = button("Clear goal", () => mutate("clear"));
  actions.append(cancel, pause, resume, clear, save);
  form.append(title, description, objective, budget, status, actions);
  dialog.append(form);
  document.body.append(dialog);
  let target = null,
    goal = null,
    busy = false,
    requestId = 0;
  function sync() {
    objective.value = goal?.objective || "";
    budget.value = goal?.tokenBudget || "";
    pause.hidden = !goal || goal.status !== "active";
    resume.hidden =
      !goal ||
      !["paused", "blocked", "budgetLimited", "usageLimited"].includes(
        goal.status,
      );
    clear.hidden = !goal;
    status.textContent = goal
      ? t("Goal status: {status}", { status: goal.status })
      : "";
  }
  async function mutate(action) {
    if (busy) return;
    busy = true;
    for (const node of actions.children) node.disabled = true;
    try {
      if (!target) target = await ensureThread();
      const result = await json("/api/conversation/goal", {
        threadId: target.id,
        action,
        ...(action === "set"
          ? {
              objective: objective.value,
              ...(budget.value ? { tokenBudget: Number(budget.value) } : {}),
            }
          : {}),
      });
      goal = result.goal || null;
      onGoalChanged(target.id, goal);
      sync();
      if (action === "set") dialog.close();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      for (const node of actions.children) node.disabled = false;
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    void mutate("set");
  };
  async function openGoal() {
    target = state.active ? { ...state.active } : null;
    goal = null;
    sync();
    dialog.showModal();
    objective.focus();
    const id = ++requestId;
    const loading = Boolean(target);
    objective.disabled = budget.disabled = save.disabled = loading;
    if (target)
      try {
        const result = await json(
          "/api/conversation/goal?" +
            new URLSearchParams({ threadId: target.id }),
        );
        if (id === requestId && dialog.open) {
          goal = result.goal;
          onGoalChanged(target.id, goal);
          sync();
        }
      } catch (error) {
        if (id === requestId) status.textContent = error.message;
      } finally {
        if (id === requestId) objective.disabled = budget.disabled = save.disabled = false;
      }
  }
  return {
    openGoal,
    async refreshGoal(threadId) {
      try {
        const result = await json('/api/conversation/goal?' + new URLSearchParams({ threadId }));
        onGoalChanged(threadId, result.goal);
      } catch { /* Older App Servers may not expose native goals. */ }
    },
    async menuItems() {
      let items = [];
      try {
        items =
          (
            await json(
              "/api/composer/tools?" + new URLSearchParams({ cwd: cwd() }),
            )
          ).items || [];
      } catch {}
      // Populate from actual enabled native skills, including plugin skills such
      // as Visualize. An absent plugin is never represented by a dead button.
      const skills = items
        .slice()
        .sort(
          (a, b) =>
            Number(/visualize/i.test(b.name)) -
            Number(/visualize/i.test(a.name)),
        )
        .slice(0, 20);
      return [
        {
          label: "Goal",
          icon: "target",
          description: "Set a goal to keep pursuing",
          action: openGoal,
        },
        ...(skills.length
          ? [
              {
                label: "Skills and plugins",
                icon: "customize",
                children: skills.map((item) => ({
                  label: /^(visualize[:/]?)?visualize$/i.test(item.name)
                    ? "Visualize"
                    : item.name,
                  description: item.description,
                  icon: /visualize/i.test(item.name) ? "sparkles" : "customize",
                  action: () =>
                    addSkill({
                      id: `skill:${item.id}`,
                      source: "skill",
                      title: item.name,
                      icon: "customize",
                    }),
                })),
              },
            ]
          : []),
      ];
    },
    async prepare(mentions, project) {
      const ids = mentions
        .filter((item) => item.source === "skill")
        .map((item) => item.id.replace(/^skill:/, ""));
      if (!ids.length) return [];
      return (
        await json(
          "/api/composer/tools?" + new URLSearchParams({ cwd: project }),
          { ids },
        )
      ).items;
    },
  };
}
