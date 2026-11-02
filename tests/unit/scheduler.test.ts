import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from '../../src/server/services/scheduler.js';
import { createScheduleStore } from '../../src/server/services/schedule-store.js';
async function fixture(run: (env: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'crw-schedules-')),
    home = join(root, 'home'),
    project = join(root, 'project'),
    privateRoot = join(home, '.codex');
  await mkdir(home);
  await mkdir(project);
  let now = Date.parse('2030-01-01T00:00:00Z');
  const calls: any[] = [];
  const request = async (method: string, params: any) => {
    calls.push({ method, params });
    return method === 'thread/start'
      ? { thread: { id: `thread-${calls.length}` } }
      : method === 'turn/start'
        ? { turn: { id: 'turn-1' } }
        : {};
  };
  const options = {
    request,
    privateRoot,
    browseRoots: [home, project],
    home,
    connected: () => true,
    clock: () => now
  };
  const engine = createScheduler(options);
  const task = (extra = {}) => ({
    name: 'Review changes',
    prompt: 'Read and summarize the diff.',
    cwd: project,
    model: '',
    sandbox: 'read-only',
    intervalMs: 3600000,
    nextRunAt: new Date(now + 1000).toISOString(),
    enabled: true,
    ...extra
  });
  const create = (extra = {}, requestId = 'create-0000000001') =>
    engine.mutate({
      action: 'create',
      confirmed: true,
      requestId,
      task: task(extra)
    });
  try {
    await run({
      root,
      home,
      project,
      privateRoot,
      calls,
      request,
      options,
      engine,
      task,
      create,
      advance: (ms: number) => (now += ms)
    });
  } finally {
    await engine.stop();
    await rm(root, { recursive: true, force: true });
  }
}
test('persistent scheduled execution reserves before RPC, retains permissions, waits for approval and records completion', () =>
  fixture(async (e) => {
    await e.create();
    await e.create();
    expect((await e.engine.list()).jobs).toHaveLength(1);
    expect(e.calls).toHaveLength(0);
    e.advance(1001);
    await e.engine.tick();
    const state = await e.engine.list();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].status).toBe('running');
    expect(e.calls[0]).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: e.project,
        sandbox: 'read-only',
        approvalPolicy: 'on-request'
      }
    });
    expect(e.calls[1]).toMatchObject({
      method: 'turn/start',
      params: {
        input: [{ type: 'text', text: 'Read and summarize the diff.' }]
      }
    });
    await e.engine.notification({
      method: 'item/commandExecution/requestApproval',
      params: { threadId: state.runs[0].threadId }
    });
    expect((await e.engine.list()).runs[0].status).toBe('waiting');
    await e.engine.tick();
    expect(e.calls).toHaveLength(2);
    await e.engine.notification({
      method: 'turn/completed',
      params: {
        threadId: state.runs[0].threadId,
        turn: { id: 'turn-1', status: 'completed' }
      }
    });
    expect((await e.engine.list()).runs[0].status).toBe('completed');
    const other = createScheduler(e.options);
    expect((await other.list()).runs[0].status).toBe('completed');
    await other.stop();
    const file = await readFile(
      join(e.privateRoot, 'remote-web-scheduler/schedules.json'),
      'utf8'
    );
    expect(file).toContain('Review changes');
  }));
test('two gateways competing for the same due task only dispatch once', () =>
  fixture(async (e) => {
    await e.create();
    e.advance(1001);
    const other = createScheduler(e.options);
    try {
      await Promise.all([e.engine.tick(), other.tick()]);
      expect(
        e.calls.filter((call) => call.method === 'turn/start')
      ).toHaveLength(1);
      expect((await other.list()).runs).toHaveLength(1);
    } finally {
      await other.stop();
    }
  }));
test('ambiguous dispatch failure pauses the task and never replays after restart', () =>
  fixture(async (e) => {
    const failing = createScheduler({
      ...e.options,
      request: async () => {
        throw new Error('lost response');
      }
    });
    try {
      await e.create();
      e.advance(1001);
      await failing.tick();
      const state = await failing.list();
      expect(state.runs[0].status).toBe('interrupted');
      expect(state.jobs[0].enabled).toBe(false);
      await e.engine.tick();
      expect(e.calls).toHaveLength(0);
    } finally {
      await failing.stop();
    }
  }));
test('missed times are recorded without catch-up execution and dead owners are paused', () =>
  fixture(async (e) => {
    await e.create({ intervalMs: 0 });
    e.advance(120000);
    await e.engine.tick();
    let state = await e.engine.list();
    expect(state.runs[0].status).toBe('missed');
    expect(state.jobs[0].enabled).toBe(false);
    expect(e.calls).toHaveLength(0);
    await e.create({}, 'create-0000000002');
    e.advance(1001);
    await e.engine.tick();
    const recovery = createScheduler({ ...e.options, ownerAlive: () => false });
    try {
      await recovery.tick();
      state = await recovery.list();
      expect(state.runs.at(-1).status).toBe('interrupted');
      expect(state.jobs.at(-1).enabled).toBe(false);
      expect(
        e.calls.filter((call) => call.method === 'turn/start')
      ).toHaveLength(1);
    } finally {
      await recovery.stop();
    }
  }));
test('cross-gateway stop records intent; owning gateway interrupts and retains run history after deletion', () =>
  fixture(async (e) => {
    await e.create();
    e.advance(1001);
    await e.engine.tick();
    let state = await e.engine.list();
    const other = createScheduler(e.options);
    try {
      await other.mutate({
        action: 'stop',
        id: state.runs[0].id,
        confirmed: true
      });
      await e.engine.tick();
      expect(e.calls.at(-1).method).toBe('turn/interrupt');
      await e.engine.notification({
        method: 'turn/completed',
        params: {
          threadId: state.runs[0].threadId,
          turn: { id: 'turn-1', status: 'interrupted' }
        }
      });
      state = await e.engine.list();
      await other.mutate({
        action: 'delete',
        id: state.jobs[0].id,
        revision: state.jobs[0].revision,
        confirmed: true
      });
      expect((await other.list()).jobs).toHaveLength(0);
      expect((await other.list()).runs).toHaveLength(1);
    } finally {
      await other.stop();
    }
  }));
test('completion arriving before turn/start acknowledgement is not overwritten', () =>
  fixture(async (e) => {
    let engine: any;
    engine = createScheduler({
      ...e.options,
      request: async (method: string) => {
        if (method === 'thread/start')
          return { thread: { id: 'early-thread' } };
        await engine.notification({
          method: 'turn/completed',
          params: {
            threadId: 'early-thread',
            turn: { id: 'early-turn', status: 'completed' }
          }
        });
        return { turn: { id: 'early-turn' } };
      }
    });
    try {
      await e.create();
      e.advance(1001);
      await engine.tick();
      expect((await engine.list()).runs[0].status).toBe('completed');
    } finally {
      await engine.stop();
    }
  }));
test('schedule input enforces project boundary, explicit confirmation, revisions and bounded permissions', () =>
  fixture(async (e) => {
    await expect(e.create({ cwd: e.root })).rejects.toThrow();
    await symlink(e.root, join(e.project, 'escape'));
    await expect(
      e.create({ cwd: join(e.project, 'escape') })
    ).rejects.toThrow();
    await expect(e.create({ sandbox: 'danger-full-access' })).rejects.toThrow();
    await expect(e.create({ intervalMs: 1 })).rejects.toThrow();
    await expect(
      e.engine.mutate({ action: 'create', task: e.task() })
    ).rejects.toThrow();
    await e.create();
    const job = (await e.engine.list()).jobs[0];
    await expect(
      e.engine.mutate({
        action: 'pause',
        id: job.id,
        revision: 99,
        confirmed: true
      })
    ).rejects.toThrow();
  }));
test('scheduler refuses symlinked or permissive state files', () =>
  fixture(async (e) => {
    await e.create();
    const path = join(e.privateRoot, 'remote-web-scheduler/schedules.json');
    await chmod(path, 0o644);
    await expect(e.engine.list()).rejects.toThrow();
    await chmod(path, 0o600);
    const store = createScheduleStore(join(e.root, 'linked'));
    await mkdir(join(e.root, 'linked'));
    await symlink(e.privateRoot, join(e.root, 'linked/remote-web-scheduler'));
    await expect(store.transaction(() => ({ value: null }))).rejects.toThrow();
  }));
test('bounded history never evicts an active execution or permits overlapping dispatch', () =>
  fixture(async (e) => {
    await e.create();
    e.advance(1001);
    await e.engine.tick();
    const store = createScheduleStore(e.privateRoot);
    await store.transaction((state: any) => {
      for (let i = 0; i < 210; i++)
        state.runs.push({ id: `missed-${i}`, status: 'missed' });
      return {};
    });
    const state = await e.engine.list();
    expect(state.runs).toHaveLength(200);
    expect(state.runs.some((run: any) => run.status === 'running')).toBe(true);
    await e.engine.tick();
    expect(
      e.calls.filter((call: any) => call.method === 'turn/start')
    ).toHaveLength(1);
  }));
test('a failed stop acknowledgement is retried without starting another turn', () =>
  fixture(async (e) => {
    let attempts = 0;
    const engine = createScheduler({
      ...e.options,
      request: async (method: string, params: any) => {
        if (method === 'turn/interrupt' && ++attempts === 1)
          throw new Error('temporary interruption');
        return e.request(method, params);
      }
    });
    try {
      await e.create();
      e.advance(1001);
      await engine.tick();
      let state = await engine.list();
      await engine.mutate({
        action: 'stop',
        id: state.runs[0].id,
        confirmed: true
      });
      for (let i = 0; i < 20; i++) {
        if ((await engine.list()).runs[0].interruptSent === false) break;
        await Bun.sleep(10);
      }
      await engine.tick();
      expect(attempts).toBe(2);
      expect(
        e.calls.filter((call: any) => call.method === 'turn/start')
      ).toHaveLength(1);
    } finally {
      await engine.stop();
    }
  }));
