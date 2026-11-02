export function createScheduledTasks({
  container,
  search,
  state,
  t,
  openChat,
  isCurrent
}) {
  let data = { jobs: [], runs: [] },
    timer,
    generation = 0,
    busy = false,
    authFailed = false;
  const node = (tag, text = '', cls = '') => {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = cls;
    return element;
  };
  const button = (text, action) => {
    const element = node('button', t(text), 'settings-action');
    element.type = 'button';
    element.onclick = action;
    return element;
  };
  const requestId = () =>
    crypto.randomUUID?.() ||
    Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
  const status = () => container.querySelector('.schedule-status');
  const localTime = (value) => {
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  const format = (value) =>
    value ? new Date(value).toLocaleString(document.documentElement.lang) : '—';
  const active = (run) =>
    ['starting', 'running', 'waiting', 'stopping'].includes(run.status);
  async function api(payload) {
    const response = await fetch('/api/schedules', {
      cache: 'no-store',
      ...(payload
        ? {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-workspace-request': '1'
            },
            body: JSON.stringify({ ...payload, confirmed: true })
          }
        : {})
    });
    const result = await response.json();
    if (!response.ok) {
      if ([401, 403].includes(response.status)) {
        authFailed = true;
        clearInterval(timer);
      }
      throw new Error(t(result.error || 'Unable to load schedules'));
    }
    return result;
  }
  function confirmation(parent, message, action) {
    parent.querySelector('.resource-confirm')?.remove();
    const panel = node('div', '', 'resource-confirm');
    panel.append(node('p', t(message)));
    const cancel = button('Cancel', () => panel.remove()),
      confirm = button('Confirm', async () => {
        if (busy) return;
        busy = true;
        confirm.disabled = true;
        cancel.disabled = true;
        try {
          data = await action();
          if (isCurrent()) {
            panel.remove();
            render();
            status().textContent = t('Schedule saved');
          }
        } catch (error) {
          panel.querySelector('p').textContent = error.message;
          confirm.disabled = false;
          cancel.disabled = false;
        } finally {
          busy = false;
        }
      });
    panel.append(cancel, confirm);
    parent.append(panel);
    confirm.focus();
  }
  async function change(payload) {
    data = await api(payload);
    render();
    return data;
  }
  function edit(job = null) {
    const mount = container.querySelector('.schedule-editor');
    mount.replaceChildren();
    const form = node('form', '', 'schedule-form');
    form.setAttribute('aria-label', t(job ? 'Edit schedule' : 'New schedule'));
    const field = (title, input) => {
      const label = node('label', t(title));
      input.setAttribute('aria-label', t(title));
      label.append(input);
      form.append(label);
      return input;
    };
    const input = (value = '') => {
      const element = node('input', '', 'settings-input');
      element.value = value;
      return element;
    };
    const name = field('Task name', input(job?.name));
    name.required = true;
    name.maxLength = 160;
    const prompt = field(
      'Task instructions',
      node('textarea', '', 'settings-instructions')
    );
    prompt.value = job?.prompt || '';
    prompt.required = true;
    prompt.maxLength = 16000;
    const cwd = field(
      'Project directory',
      input(
        job?.cwd ||
          state.active?.cwd ||
          state.workspaceContext?.cwd ||
          state.config.defaultCwd
      )
    );
    cwd.required = true;
    const first = field(
      'Next run',
      input(
        localTime(
          job && Date.parse(job.nextRunAt) > Date.now()
            ? job.nextRunAt
            : Date.now() + 60000
        )
      )
    );
    first.type = 'datetime-local';
    first.required = true;
    const select = (id, options, value) => {
      const element = node('select', '', 'settings-select');
      element.id = id;
      for (const [key, label] of options)
        element.append(new Option(t(label), key));
      element.value = String(value);
      return element;
    };
    const interval = field(
      'Repeat',
      select(
        'scheduleRepeat',
        [
          [0, 'Once'],
          [3600000, 'Every hour'],
          [86400000, 'Every 24 hours'],
          [604800000, 'Every 7 days']
        ],
        job?.intervalMs || 0
      )
    );
    const model = field(
      'Model',
      select(
        'scheduleModel',
        [
          ['', 'Codex configuration'],
          ...state.models.map((item) => [
            item.model,
            item.displayName || item.model
          ])
        ],
        job?.model || ''
      )
    );
    const sandbox = field(
      'Permissions',
      select(
        'scheduleSandbox',
        [
          ['read-only', 'Read only'],
          ['workspace-write', 'Workspace write']
        ],
        job?.sandbox || 'read-only'
      )
    );
    const enabled = field('Enable automatic execution', input());
    enabled.type = 'checkbox';
    enabled.className = '';
    enabled.checked = job?.enabled || false;
    form.append(
      node(
        'p',
        t(
          'Scheduled tasks can use model credits. Commands follow the selected permissions and may wait for approval. The server must remain running.'
        ),
        'settings-note'
      )
    );
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    form.append(node('p', `${t('Times shown in')}: ${zone}`, 'settings-note'));
    const save = node('button', t('Save schedule'), 'settings-action primary');
    save.type = 'submit';
    form.append(
      save,
      button('Cancel', () => mount.replaceChildren())
    );
    const key = requestId();
    form.onsubmit = (event) => {
      event.preventDefault();
      const task = {
        name: name.value,
        prompt: prompt.value,
        cwd: cwd.value,
        model: model.value,
        sandbox: sandbox.value,
        intervalMs: Number(interval.value),
        nextRunAt: new Date(first.value).toISOString(),
        enabled: enabled.checked
      };
      confirmation(
        form,
        task.enabled
          ? 'Allow this task to run automatically at the selected times?'
          : 'Save this task as paused?',
        async () => {
          const result = await api({
            action: job ? 'update' : 'create',
            ...(job ? { id: job.id, revision: job.revision } : {}),
            requestId: key,
            task
          });
          mount.replaceChildren();
          return result;
        }
      );
    };
    mount.append(form);
    name.focus();
  }
  function render() {
    const list = container.querySelector('.schedule-list'),
      history = container.querySelector('.schedule-history');
    if (!list) return;
    list.replaceChildren();
    history.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    for (const job of data.jobs.filter((job) =>
      `${job.name} ${job.prompt}`.toLocaleLowerCase().includes(query)
    )) {
      const article = node('article', '', 'workspace-resource-card');
      article.dataset.scheduleId = job.id;
      article.append(
        node('h2', job.name),
        node('p', job.prompt),
        node(
          'small',
          `${t(job.enabled ? 'Enabled' : 'Paused')} · ${format(job.nextRunAt)} · ${job.cwd}`
        )
      );
      for (const element of article.children) element.dataset.i18nIgnore = '';
      const actions = node('div', '', 'resource-toolbar');
      actions.append(button('Edit', () => edit(job)));
      actions.append(
        button(job.enabled ? 'Pause' : 'Resume', () =>
          job.enabled
            ? void change({
                action: 'pause',
                id: job.id,
                revision: job.revision
              }).catch((error) => (status().textContent = error.message))
            : confirmation(
                article,
                'Allow this task to run automatically at the selected times?',
                () =>
                  api({ action: 'resume', id: job.id, revision: job.revision })
              )
        )
      );
      const runKey = requestId();
      const run = button('Run now', () =>
        confirmation(
          article,
          'Run this task now? This can use model credits.',
          () =>
            api({
              action: 'run',
              id: job.id,
              revision: job.revision,
              requestId: runKey
            })
        )
      );
      run.disabled = data.runs.some(active);
      actions.append(run);
      const remove = button('Delete', () =>
        confirmation(
          article,
          'Delete this schedule? Existing chats and run history will be kept.',
          () => api({ action: 'delete', id: job.id, revision: job.revision })
        )
      );
      remove.disabled = data.runs.some(
        (run) => run.jobId === job.id && active(run)
      );
      actions.append(remove);
      article.append(actions);
      list.append(article);
    }
    if (!list.childElementCount)
      list.append(
        node('p', t('No scheduled tasks'), 'workspace-feature-empty')
      );
    history.append(node('h2', t('Recent runs'), 'settings-section-title'));
    for (const run of [...data.runs].reverse().slice(0, 50)) {
      const article = node('article', '', 'workspace-resource-card');
      article.dataset.runStatus = run.status;
      const labels = {
        starting: 'Starting',
        running: 'Running',
        waiting: 'Waiting for approval',
        stopping: 'Stopping',
        completed: 'Completed',
        failed: 'Failed',
        interrupted: 'Interrupted',
        missed: 'Missed'
      };
      article.append(
        node('h3', run.name),
        node(
          'p',
          `${t(labels[run.status] || run.status)} · ${format(run.startedAt)}`
        )
      );
      article.querySelector('h3').dataset.i18nIgnore = '';
      if (run.error) article.append(node('p', t(run.error)));
      if (run.threadId)
        article.append(button('Open chat', () => openChat(run.threadId)));
      if (active(run)) {
        const stop = button(
          'Stop run',
          () =>
            void change({ action: 'stop', id: run.id }).catch(
              (error) => (status().textContent = error.message)
            )
        );
        stop.disabled = run.status === 'stopping';
        article.append(stop);
      }
      history.append(article);
    }
    if (!data.runs.length)
      history.append(node('p', t('No runs yet'), 'settings-note'));
  }
  async function refresh() {
    if (
      busy ||
      authFailed ||
      !isCurrent() ||
      container.querySelector('.resource-confirm')
    )
      return;
    const id = generation;
    try {
      data = await api();
      if (
        id === generation &&
        isCurrent() &&
        !container.querySelector('.resource-confirm')
      )
        render();
    } catch (error) {
      if (id === generation && isCurrent())
        status().textContent = error.message;
    }
  }
  return {
    async open() {
      generation++;
      authFailed = false;
      clearInterval(timer);
      container.replaceChildren();
      const bar = node('div', '', 'resource-toolbar');
      bar.append(
        button('New schedule', () => edit()),
        button('Refresh', () => refresh())
      );
      container.append(
        bar,
        node('p', '', 'schedule-status'),
        node('div', '', 'schedule-editor'),
        node('div', '', 'schedule-list'),
        node('section', '', 'schedule-history')
      );
      await refresh();
      timer = setInterval(() => void refresh(), 4000);
    },
    search: render,
    close() {
      generation++;
      clearInterval(timer);
    }
  };
}
