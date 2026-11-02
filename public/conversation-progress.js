import { summarizeActivity } from '../src/shared/codex-surfaces.js';

export function elapsedTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// A spinner is only animation. Freshness comes from actual notifications and
// successful reads, never from a local timer or an unchanged polling snapshot.
export function runtimeStatus(entry, { connected, waiting, now = Date.now() }) {
  if (entry.status !== 'inProgress') return {
    label: entry.status === 'interrupted' ? 'Work interrupted' : 'Work failed',
    glyph: 'triangleAlert', tone: 'error',
  };
  if (!connected) return { label: 'Connection interrupted', glyph: 'triangleAlert', tone: 'offline' };
  if (waiting) return { label: waiting, glyph: 'circleHelp', tone: 'waiting' };
  const active = [...entry.items.values()].reverse().find(item => summarizeActivity(item).active);
  const data = active && summarizeActivity(active);
  const glyph = active?.type === 'fileChange' ? 'fileDiff' : active?.type === 'webSearch' || data?.category === 'search' ? 'search' : data?.category === 'command' ? 'terminal' : data?.category === 'read' || data?.category === 'list' ? 'file' : 'loaderCircle';
  return {
    label: active?.type === 'agentMessage' ? 'Writing response' : data?.label || 'Working',
    detail: ['reasoning', 'agentMessage'].includes(active?.type) ? '' : data?.detail || '', glyph,
    tone: now - entry.lastEvent >= 20000 ? 'quiet' : 'active',
  };
}

export function createRuntimeProgress({ state, t, icon, ensureTurn, authRequired = () => false, isLoading = () => false, now = () => Date.now() }) {
  const entries = new Map();
  let timer;
  function entryFor(id) {
    if (!entries.has(id)) entries.set(id, { id, status: 'inProgress', started: now(), startedKnown: false, lastEvent: now(), confirmed: 0, items: new Map() });
    return entries.get(id);
  }
  function refresh() {
    clearTimeout(timer);
    if (isLoading()) {
      for (const turn of state.turns.values()) turn.querySelector('.runtime-progress')?.remove();
      return;
    }
    for (const entry of entries.values()) {
      const turn = state.turns.get(entry.id);
      if (!turn?.isConnected) continue;
      let panel = turn.querySelector('.runtime-progress');
      if (entry.status === 'completed') { panel?.remove(); continue; }
      if (!panel) {
        panel = document.createElement('section');
        panel.className = 'runtime-progress';
        panel.dataset.i18nIgnore = '';
        panel.innerHTML = '<div class="runtime-heading"><span class="runtime-glyph" aria-hidden="true"></span><strong role="status" aria-live="polite"></strong><span class="runtime-elapsed"></span></div><code class="runtime-detail"></code><small class="runtime-freshness"></small><details class="runtime-plan"><summary></summary><progress></progress><ol></ol></details>';
        turn.querySelector('.turn-final-slot').before(panel);
      }
      const requests = [...state.serverRequests.values()].filter(request => request.params?.threadId === state.active?.id && (!request.params.turnId || request.params.turnId === entry.id));
      const waiting = requests.length ? (requests.some(r => r.method === 'item/tool/requestUserInput') ? 'Waiting for your answer' : 'Waiting for approval') : null;
      const model = authRequired() ? { label: 'Sign in to reconnect', glyph: 'shield', tone: 'offline' } : runtimeStatus(entry, { connected: state.connected, waiting, now: now() });
      panel.dataset.tone = model.tone;
      const setText = (selector, text) => { const node = panel.querySelector(selector); if (node.textContent !== text) node.textContent = text; return node; };
      const glyph = panel.querySelector('.runtime-glyph');
      if (glyph.dataset.icon !== model.glyph) { glyph.dataset.icon = model.glyph; glyph.innerHTML = icon(model.glyph); }
      setText('strong', t(model.label));
      setText('.runtime-elapsed', t(entry.startedKnown ? 'Elapsed {time}' : 'Observed for {time}', { time: elapsedTime((entry.ended || now()) - entry.started) }));
      const detail = setText('.runtime-detail', model.detail || '');
      detail.hidden = !model.detail;
      detail.title = model.detail || '';
      const age = elapsedTime(now() - entry.lastEvent);
      const freshness = model.tone === 'offline' ? 'Progress is unavailable until the connection returns. No request will be resent.'
        : model.tone === 'waiting' ? 'Your response is needed to continue.'
        : model.tone === 'error' ? 'Execution stopped. Review the work and errors above.'
        : model.tone === 'quiet' ? (now() - entry.confirmed < 10000 ? 'No new output for {time}. Codex still reports this turn as running.' : 'No new output for {time}. Waiting for a fresh server status.')
        : 'Last activity {time} ago';
      setText('.runtime-freshness', t(freshness, { time: age }));
      const plan = panel.querySelector('.runtime-plan');
      plan.hidden = !entry.plan?.length;
      if (entry.plan?.length) {
        const done = entry.plan.filter(step => step.status === 'completed').length;
        setText('summary', t('Plan · {done}/{total} steps', { done, total: entry.plan.length }));
        const progress = plan.querySelector('progress');
        progress.max = entry.plan.length; progress.value = done;
        progress.setAttribute('aria-label', t('Plan progress'));
        const signature = JSON.stringify(entry.plan);
        if (plan.dataset.signature !== signature) {
          plan.dataset.signature = signature;
          plan.querySelector('ol').replaceChildren(...entry.plan.map(step => {
            const li = document.createElement('li'); li.dataset.status = step.status;
            li.textContent = `${step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '•' : '○'} ${step.step}`;
            return li;
          }));
        }
      }
    }
    clearTimeout(timer);
    if ([...entries.values()].some(entry => entry.status === 'inProgress')) timer = setTimeout(refresh, 1000);
  }
  function snapshot(turn) {
    if (!turn?.id) return;
    if (!entries.has(turn.id) && turn.status !== 'inProgress') return;
    const entry = entryFor(turn.id), signature = JSON.stringify(turn.items || []);
    if (entry.signature !== signature) { entry.signature = signature; entry.lastEvent = now(); }
    entry.status = turn.status || 'completed';
    if (turn.status !== 'inProgress') entry.ended ||= now();
    const started = turn.startedAtMs || (turn.startedAt ? turn.startedAt * 1000 : 0);
    if (started) { entry.started = started; entry.startedKnown = true; }
    entry.items = new Map((turn.items || []).map(item => [item.id, item]));
    entry.confirmed = now(); refresh();
  }
  function notify(method, p) {
    const id = p.turnId || p.turn?.id;
    if (!id || !(method.startsWith('item/') || method.startsWith('turn/'))) return;
    // History replay, completed items and diff metadata do not establish that
    // execution is running. Only an actual start/delta or snapshot can do so.
    const runningEvent = method === 'turn/started' || method === 'item/started' || method.endsWith('/delta') || method.endsWith('/outputDelta') || method.startsWith('item/reasoning/') || method === 'item/fileChange/patchUpdated';
    if (!entries.has(id) && !runningEvent) return;
    const entry = entryFor(id);
    entry.lastEvent = now();
    if (method === 'turn/started') {
      const started = p.turn?.startedAtMs || (p.turn?.startedAt ? p.turn.startedAt * 1000 : 0);
      if (!entry.startedKnown) entry.started = started || now();
      entry.startedKnown = true; entry.status = 'inProgress'; delete entry.ended;
    }
    if (method === 'turn/completed') { entry.status = p.turn?.status || 'completed'; entry.ended = now(); }
    if (p.item) entry.items.set(p.item.id, { ...p.item, status: method === 'item/started' ? 'inProgress' : ['failed', 'declined', 'interrupted', 'cancelled', 'canceled'].includes(p.item.status) ? p.item.status : 'completed' });
    if (method === 'item/agentMessage/delta') entry.items.set(p.itemId, { id: p.itemId, type: 'agentMessage', status: 'inProgress' });
    if (method.startsWith('item/reasoning/')) entry.items.set(p.itemId, { id: p.itemId, type: 'reasoning', status: 'inProgress' });
    if (method === 'turn/plan/updated') entry.plan = Array.isArray(p.plan) ? p.plan : [];
    if (!isLoading()) ensureTurn(id);
    refresh();
  }
  return { notify, snapshot, refresh,
    confirmed(id) { const entry = entries.get(id); if (entry) { entry.confirmed = now(); refresh(); } },
    clear() { clearTimeout(timer); entries.clear(); },
  };
}

export function createConversationLoading(root, { t, retry, now = () => Date.now() }) {
  const started = now(), node = document.createElement('section');
  node.className = 'conversation-loading conversation-load-progress';
  node.dataset.i18nIgnore = '';
  node.innerHTML = '<span class="conversation-load-spinner" aria-hidden="true"></span><strong role="status"></strong><progress></progress><small></small><button type="button" hidden></button>';
  root.replaceChildren(node); root.setAttribute('aria-busy', 'true');
  const progress = node.querySelector('progress'), label = node.querySelector('strong'), hint = node.querySelector('small'), button = node.querySelector('button');
  progress.setAttribute('aria-label', t('Conversation loading progress'));
  button.textContent = t('Retry loading'); button.onclick = retry;
  let stage = 'reading', total = 0, loaded = 0, failure = false, timer;
  function refresh() {
    if (!node.isConnected) return;
    const time = elapsedTime(now() - started), slow = now() - started >= 60000;
    button.textContent = t('Retry loading');
    progress.setAttribute('aria-label', t('Conversation loading progress'));
    const text = t(failure ? 'Could not load conversation' : stage === 'reading' ? 'Loading conversation…' : 'Rendering messages · {loaded}/{total}', { loaded, total });
    if (label.textContent !== text) label.textContent = text;
    hint.textContent = t(failure ? (slow ? 'Your draft is kept. Retry loading history; your message will not be sent.' : 'Your draft is kept. Your message will not be sent. Retry is available after 60 seconds.') : slow && stage === 'reading' ? 'History is taking longer to load. You can wait or retry safely. · {time}' : 'Elapsed {time}', { time });
    button.hidden = !slow;
    progress.hidden = failure;
    node.classList.toggle('load-failed', failure);
    if (failure && slow) clearInterval(timer);
  }
  timer = setInterval(refresh, 1000); refresh();
  return {
    refresh,
    render(complete, count) { stage = 'rendering'; total = count; loaded = complete; progress.max = Math.max(1, count); progress.value = complete; refresh(); },
    fail() { failure = true; root.removeAttribute('aria-busy'); refresh(); },
    finish() { clearInterval(timer); node.remove(); root.removeAttribute('aria-busy'); },
  };
}
