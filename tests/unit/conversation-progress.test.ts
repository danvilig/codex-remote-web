import { test, expect } from 'bun:test';
import { JSDOM } from 'jsdom';
import { runtimeStatus, elapsedTime, createRuntimeProgress, createConversationLoading } from '../../public/conversation-progress.js';

const t = (s: string, values: Record<string, unknown> = {}) => s.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
const running = () => ({ status: 'inProgress', lastEvent: 1000, items: new Map([['cmd', { id: 'cmd', type: 'commandExecution', status: 'inProgress', command: 'bun test' }]]) });

test('activity status uses native operations, connection, waiting and real event freshness', () => {
  const entry = running();
  expect(runtimeStatus(entry, { connected: true, now: 1001 })).toMatchObject({ label: 'Running command', detail: 'bun test', tone: 'active' });
  expect(runtimeStatus(entry, { connected: true, now: 21000 }).tone).toBe('quiet');
  expect(runtimeStatus(entry, { connected: false, waiting: 'Waiting for approval' }).label).toBe('Connection interrupted');
  expect(runtimeStatus(entry, { connected: true, waiting: 'Waiting for approval' }).tone).toBe('waiting');
  expect(runtimeStatus({ ...entry, status: 'interrupted' }, { connected: true }).label).toBe('Work interrupted');
  entry.items.set('read', { id: 'read', type: 'commandExecution', status: 'inProgress', command: 'cat README.md' });
  expect(runtimeStatus(entry, { connected: true, now: 1001 })).toMatchObject({ label: 'Reading', detail: 'README.md', glyph: 'file' });
  expect(elapsedTime(87000)).toBe('1m 27s');
});

test('unchanged snapshots confirm running without faking new activity; terminal states stop the indicator', () => {
  const dom = new JSDOM('<main></main>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  let time = 1000;
  const state = { active: { id: 'thread' }, connected: true, turns: new Map(), serverRequests: new Map() };
  const ensureTurn = (id: string) => {
    if (!state.turns.has(id)) {
      const turn = document.createElement('article'); turn.innerHTML = '<div class="turn-final-slot"></div>';
      document.querySelector('main')!.append(turn); state.turns.set(id, turn);
    }
    return state.turns.get(id);
  };
  const runtime = createRuntimeProgress({ state, t, icon: () => '', ensureTurn, now: () => time });
  try {
    runtime.notify('turn/started', { turn: { id: 'turn' } });
    runtime.notify('item/started', { turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: 'bun test' } });
    const turn = { id: 'turn', status: 'inProgress', items: [...running().items.values()] };
    runtime.snapshot(turn);
    time += 25000; runtime.snapshot(turn);
    expect(document.querySelector('.runtime-progress')!.getAttribute('data-tone')).toBe('quiet');
    expect(document.querySelector('.runtime-freshness')!.textContent).toContain('still reports this turn as running');
    time += 11000; runtime.refresh();
    expect(document.querySelector('.runtime-freshness')!.textContent).toContain('Waiting for a fresh server status');
    runtime.notify('item/commandExecution/outputDelta', { turnId: 'turn', itemId: 'cmd', delta: 'Tests running' });
    expect(document.querySelector('.runtime-progress')!.getAttribute('data-tone')).toBe('active');
    state.serverRequests.set('approval', { params: { threadId: 'thread', turnId: 'turn' }, method: 'item/permissions/requestApproval' });
    runtime.refresh(); expect(document.querySelector('.runtime-heading strong')!.textContent).toBe('Waiting for approval');
    state.connected = false; runtime.refresh();
    expect(document.querySelector('.runtime-heading strong')!.textContent).toBe('Connection interrupted');
    state.connected = true; state.serverRequests.clear();
    runtime.notify('turn/completed', { turn: { id: 'turn', status: 'interrupted' } });
    expect(document.querySelector('.runtime-heading strong')!.textContent).toBe('Work interrupted');
    runtime.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    expect(document.querySelector('.runtime-progress')).toBeNull();
    const observed = ensureTurn('observed');
    runtime.snapshot({ id: 'observed', status: 'inProgress', items: [] });
    expect(observed.querySelector('.runtime-elapsed').textContent).toBe('Observed for 0s');
    runtime.snapshot({ id: 'observed', status: 'inProgress', startedAtMs: time - 5000, items: [] });
    expect(observed.querySelector('.runtime-elapsed').textContent).toBe('Elapsed 5s');
  } finally { runtime.clear(); globalThis.document = previous; dom.window.close(); }
});

test('history metadata cannot start work and loading suppresses runtime panels until confirmed rendering completes', () => {
  const dom = new JSDOM('<main></main>'), previous = globalThis.document;
  globalThis.document = dom.window.document;
  let loading = true;
  const state = { active: { id: 'thread' }, connected: true, turns: new Map(), serverRequests: new Map() };
  const ensureTurn = (id: string) => {
    if (!state.turns.has(id)) {
      const turn = document.createElement('article'); turn.innerHTML = '<div class="turn-final-slot"></div>';
      document.querySelector('main')!.append(turn); state.turns.set(id, turn);
    }
    return state.turns.get(id);
  };
  const runtime = createRuntimeProgress({ state, t, icon: () => '', ensureTurn, isLoading: () => loading });
  try {
    for (const [method, params] of [
      ['turn/diff/updated', { turnId: 'old' }],
      ['turn/plan/updated', { turnId: 'old', plan: [] }],
      ['item/completed', { turnId: 'old', item: { id: 'file', type: 'fileChange' } }],
      ['turn/completed', { turn: { id: 'old', status: 'completed' } }],
    ] as const) runtime.notify(method, params);
    expect(state.turns.size).toBe(0);
    runtime.notify('turn/started', { turn: { id: 'running' } });
    expect(state.turns.size).toBe(0);
    ensureTurn('running');
    runtime.snapshot({ id: 'running', status: 'inProgress', items: [] });
    expect(document.querySelector('.runtime-progress')).toBeNull();
    loading = false; runtime.refresh();
    expect(document.querySelector('.runtime-heading strong')!.textContent).toBe('Working');
    loading = true; runtime.refresh();
    expect(document.querySelector('.runtime-progress')).toBeNull();
    runtime.notify('turn/completed', { turn: { id: 'running', status: 'completed' } });
    loading = false; runtime.refresh();
    expect(document.querySelector('.runtime-progress')).toBeNull();
  } finally { runtime.clear(); globalThis.document = previous; dom.window.close(); }
});

test('history loading has indeterminate read progress, measured render counts, slow/failure/retry feedback', () => {
  const dom = new JSDOM('<main></main>'); const previous = globalThis.document;
  globalThis.document = dom.window.document;
  let time = 1000, retries = 0;
  const root = document.querySelector('main')!;
  const loader = createConversationLoading(root, { t, now: () => time, retry: () => retries++ });
  try {
    expect(root.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('progress')!.hasAttribute('value')).toBe(false);
    time += 10000; loader.refresh();
    expect(root.querySelector('small')!.textContent).not.toContain('retry safely');
    expect(root.querySelector('button')!.hidden).toBe(true);
    loader.render(3, 10);
    expect(root.querySelector('progress')!.value).toBe(3);
    expect(root.querySelector('strong')!.textContent).toContain('3/10');
    loader.fail();
    expect(root.hasAttribute('aria-busy')).toBe(false);
    expect(root.textContent!.toLowerCase()).toContain('your message will not be sent');
    time = 60999; loader.refresh();
    expect(root.querySelector('button')!.hidden).toBe(true);
    time = 61000; loader.refresh();
    expect(root.querySelector('button')!.hidden).toBe(false);
    root.querySelector('button')!.click(); expect(retries).toBe(1);
    loader.finish(); expect(root.children.length).toBe(0);
  } finally { loader.finish(); globalThis.document = previous; dom.window.close(); }
});

test('pending history loading offers retry only after a full minute', () => {
  const dom = new JSDOM('<main></main>'), previous = globalThis.document;
  globalThis.document = dom.window.document;
  let time = 0;
  const root = document.querySelector('main')!;
  const loader = createConversationLoading(root, { t, now: () => time, retry() {} });
  try {
    time = 59999; loader.refresh();
    expect(root.querySelector('button')!.hidden).toBe(true);
    time = 60000; loader.refresh();
    expect(root.querySelector('button')!.hidden).toBe(false);
    expect(root.querySelector('small')!.textContent).toContain('longer to load');
  } finally { loader.finish(); globalThis.document = previous; dom.window.close(); }
});
