import { randomUUID } from 'node:crypto';
import { resolveBrowsePath, isDirectory } from '../files/folders.js';
import {
  createScheduleStore,
  scheduleOwner,
  scheduleOwnerAlive
} from './schedule-store.js';
const active = (run) =>
  ['starting', 'running', 'waiting', 'stopping'].includes(run.status);
const intervals = new Set([0, 3600000, 86400000, 604800000]);
const conflict = () => {
  const error = new Error(
    'Schedule changed or already running. Reload before trying again.'
  );
  error.status = 409;
  return error;
};
export function createScheduler({
  request,
  privateRoot,
  browseRoots,
  home,
  connected,
  clock = Date.now,
  ownerAlive = scheduleOwnerAlive,
  pollMs = 10000
}) {
  const store = createScheduleStore(privateRoot),
    owner = scheduleOwner();
  let timer = null,
    stopped = false,
    ticking = false;
  const publicState = (state) => ({
    jobs: state.jobs.map((job) => ({ ...job, creationKey: undefined })),
    runs: state.runs.map(({ owner, ...run }) => run),
    serverTime: new Date(clock()).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
  function validate(input) {
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some(
        (key) =>
          ![
            'name',
            'prompt',
            'cwd',
            'model',
            'sandbox',
            'intervalMs',
            'nextRunAt',
            'enabled'
          ].includes(key)
      ) ||
      typeof input.cwd !== 'string'
    )
      throw new Error('Unsupported schedule settings');
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 160 ||
      typeof input.prompt !== 'string' ||
      !input.prompt.trim() ||
      Buffer.byteLength(input.prompt) > 16000
    )
      throw new Error('Enter a task name and prompt');
    const cwd = resolveBrowsePath(input.cwd, browseRoots, home);
    if (!isDirectory(cwd)) throw new Error('Invalid project');
    if (
      !['read-only', 'workspace-write'].includes(input.sandbox) ||
      !intervals.has(input.intervalMs) ||
      typeof input.enabled !== 'boolean' ||
      typeof input.model !== 'string' ||
      input.model.length > 160
    )
      throw new Error('Unsupported schedule settings');
    const nextRunAt = Date.parse(input.nextRunAt);
    if (
      !Number.isFinite(nextRunAt) ||
      nextRunAt < clock() - 1000 ||
      nextRunAt > clock() + 366 * 86400000
    )
      throw new Error('Choose a future start time');
    return {
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      cwd,
      model: input.model,
      sandbox: input.sandbox,
      intervalMs: input.intervalMs,
      nextRunAt: new Date(nextRunAt).toISOString(),
      enabled: input.enabled
    };
  }
  const advance = (job, now) => {
    if (!job.intervalMs) job.enabled = false;
    else {
      const at = Date.parse(job.nextRunAt);
      job.nextRunAt = new Date(
        at +
          (Math.floor(Math.max(0, now - at) / job.intervalMs) + 1) *
            job.intervalMs
      ).toISOString();
    }
    job.revision++;
  };
  function recover(state) {
    let changed = false;
    for (const run of state.runs)
      if (active(run) && !ownerAlive(run.owner)) {
        run.status = 'interrupted';
        run.finishedAt = new Date(clock()).toISOString();
        run.error = 'The gateway stopped. This run was not replayed.';
        const job = state.jobs.find((job) => job.id === run.jobId);
        if (job) {
          job.enabled = false;
          job.revision++;
        }
        changed = true;
      }
    return changed;
  }
  async function list() {
    const state = await store.read();
    return publicState(state);
  }
  async function updateRun(id, change) {
    return store.transaction((state) => {
      const run = state.runs.find((run) => run.id === id);
      if (!run || !active(run) || run.owner?.instance !== owner.instance)
        return { value: null, changed: false };
      change(run, state);
      return { value: { ...run } };
    });
  }
  async function launch(id) {
    try {
      let state = await store.read(),
        run = state.runs.find((run) => run.id === id),
        job = state.jobs.find((job) => job.id === run?.jobId);
      if (stopped || !run || !active(run) || !job) return;
      const cwd = resolveBrowsePath(job.cwd, browseRoots, home);
      if (!isDirectory(cwd)) throw new Error('Project unavailable');
      const started = await request('thread/start', {
        cwd,
        sandbox: job.sandbox,
        approvalPolicy: 'on-request',
        ...(job.model ? { model: job.model } : {})
      });
      if (typeof started.thread?.id !== 'string')
        throw new Error('Missing thread');
      run = await updateRun(id, (run) => {
        run.threadId = started.thread.id;
      });
      if (!run) return;
      if (run.cancelRequested || stopped) {
        await updateRun(id, (run) => {
          run.status = 'interrupted';
          run.finishedAt = new Date(clock()).toISOString();
        });
        return;
      }
      const response = await request('turn/start', {
        threadId: run.threadId,
        input: [{ type: 'text', text: job.prompt, text_elements: [] }]
      });
      run = await updateRun(id, (run) => {
        if (typeof response.turn?.id !== 'string')
          throw new Error('Missing turn');
        run.turnId = response.turn.id;
        run.status = run.status === 'waiting' ? 'waiting' : 'running';
      });
      if (run?.cancelRequested && run.turnId)
        await request('turn/interrupt', {
          threadId: run.threadId,
          turnId: run.turnId
        });
    } catch {
      await updateRun(id, (run, state) => {
        run.status = 'interrupted';
        run.finishedAt = new Date(clock()).toISOString();
        run.error =
          'Execution could not be confirmed. This run was not retried.';
        const job = state.jobs.find((job) => job.id === run.jobId);
        if (job) {
          job.enabled = false;
          job.revision++;
        }
      }).catch(() => {});
    }
  }
  function reserve(state, job, trigger, requestId = null) {
    if (state.runs.some(active)) throw conflict();
    const run = {
      id: randomUUID(),
      jobId: job.id,
      name: job.name,
      status: 'starting',
      startedAt: new Date(clock()).toISOString(),
      finishedAt: null,
      threadId: null,
      turnId: null,
      trigger,
      requestId,
      owner
    };
    state.runs.push(run);
    return run;
  }
  async function interruptRun(id, params) {
    try {
      await request('turn/interrupt', params);
    } catch {
      await updateRun(id, (run) => {
        run.interruptSent = false;
        run.error =
          'The stop request could not be confirmed. Retrying while connected.';
      });
    }
  }
  async function mutate(payload) {
    if (
      !payload ||
      payload.confirmed !== true ||
      ![
        'create',
        'update',
        'delete',
        'pause',
        'resume',
        'run',
        'stop'
      ].includes(payload.action) ||
      Object.keys(payload).some(
        (key) =>
          ![
            'action',
            'confirmed',
            'id',
            'revision',
            'requestId',
            'task'
          ].includes(key)
      )
    )
      throw new Error('Confirm a supported schedule change');
    if (
      !['pause', 'stop', 'delete'].includes(payload.action) &&
      (!connected() || stopped)
    )
      throw new Error('Connect to Codex before changing schedules');
    let dispatch = null,
      interrupt = null;
    const result = await store.transaction((state) => {
      recover(state);
      if (payload.action === 'create') {
        if (
          typeof payload.requestId !== 'string' ||
          !/^[a-zA-Z0-9-]{16,80}$/.test(payload.requestId)
        )
          throw new Error('Request identity required');
        if (state.jobs.some((job) => job.creationKey === payload.requestId))
          return { value: publicState(state), changed: false };
        if (state.jobs.length >= 30)
          throw new Error('At most 30 schedules are supported');
        state.jobs.push({
          ...validate(payload.task),
          id: randomUUID(),
          creationKey: payload.requestId,
          revision: 1,
          createdAt: new Date(clock()).toISOString()
        });
      } else if (payload.action === 'stop') {
        const run = state.runs.find((run) => run.id === payload.id);
        if (!run || !active(run)) throw conflict();
        // Other local gateways record intent; the owning App Server interrupts on its next tick.
        run.cancelRequested = true;
        run.status = 'stopping';
        if (run.turnId && run.owner.instance === owner.instance) {
          run.interruptSent = true;
          interrupt = {
            id: run.id,
            params: { threadId: run.threadId, turnId: run.turnId }
          };
        }
      } else {
        const job = state.jobs.find((job) => job.id === payload.id);
        if (!job || job.revision !== payload.revision) throw conflict();
        if (payload.action === 'run') {
          if (
            typeof payload.requestId !== 'string' ||
            !/^[a-zA-Z0-9-]{16,80}$/.test(payload.requestId)
          )
            throw new Error('Request identity required');
          if (state.runs.some((run) => run.requestId === payload.requestId))
            return { value: publicState(state), changed: false };
          dispatch = reserve(state, job, 'manual', payload.requestId).id;
        } else if (payload.action === 'delete') {
          if (state.runs.some((run) => run.jobId === job.id && active(run)))
            throw conflict();
          state.jobs = state.jobs.filter((item) => item !== job);
        } else if (payload.action === 'update') {
          if (state.runs.some((run) => run.jobId === job.id && active(run)))
            throw conflict();
          Object.assign(job, validate(payload.task));
          job.revision++;
        } else {
          job.enabled = payload.action === 'resume';
          if (job.enabled && Date.parse(job.nextRunAt) <= clock())
            job.nextRunAt = new Date(clock() + 60000).toISOString();
          job.revision++;
        }
      }
      return { value: publicState(state) };
    });
    if (dispatch) void launch(dispatch);
    if (interrupt) void interruptRun(interrupt.id, interrupt.params);
    return result;
  }
  async function tick() {
    if (stopped || ticking || !connected() || !(await store.exists())) return;
    ticking = true;
    try {
      const id = await store.transaction((state) => {
        let changed = recover(state),
          selected = null;
        const now = clock(),
          interrupts = [];
        for (const run of state.runs)
          if (
            active(run) &&
            run.cancelRequested &&
            run.turnId &&
            run.owner?.instance === owner.instance &&
            !run.interruptSent
          ) {
            run.interruptSent = true;
            interrupts.push({
              id: run.id,
              params: { threadId: run.threadId, turnId: run.turnId }
            });
            changed = true;
          }
        for (const job of state.jobs)
          if (job.enabled && Date.parse(job.nextRunAt) <= now) {
            if (now - Date.parse(job.nextRunAt) > 60000) {
              state.runs.push({
                id: randomUUID(),
                jobId: job.id,
                name: job.name,
                status: 'missed',
                startedAt: job.nextRunAt,
                finishedAt: new Date(now).toISOString(),
                trigger: 'scheduled',
                error:
                  'The scheduled time passed while execution was unavailable.'
              });
              advance(job, now);
              changed = true;
            } else if (!state.runs.some(active) && !selected) {
              selected = reserve(state, job, 'scheduled').id;
              advance(job, now);
              changed = true;
            }
          }
        return { value: { selected, interrupts }, changed };
      });
      for (const item of id.interrupts)
        await interruptRun(item.id, item.params);
      if (id.selected) await launch(id.selected);
    } finally {
      ticking = false;
    }
  }
  async function notification(message) {
    const p = message.params || {};
    if (
      !p.threadId ||
      ![
        'turn/completed',
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
        'item/tool/requestUserInput'
      ].includes(message.method) ||
      !(await store.exists())
    )
      return;
    await store.transaction((state) => {
      const run = state.runs.find(
        (run) =>
          active(run) &&
          run.threadId === p.threadId &&
          run.owner?.instance === owner.instance
      );
      if (!run) return { changed: false };
      if (message.method === 'turn/completed') {
        if (run.turnId && p.turn?.id !== run.turnId) return { changed: false };
        run.status =
          p.turn?.status === 'completed'
            ? 'completed'
            : p.turn?.status === 'failed'
              ? 'failed'
              : 'interrupted';
        run.finishedAt = new Date(clock()).toISOString();
      } else run.status = 'waiting';
      return {};
    });
  }
  async function interrupted() {
    if (!(await store.exists())) return;
    await store.transaction((state) => {
      let changed = false;
      for (const run of state.runs)
        if (active(run) && run.owner?.instance === owner.instance) {
          run.status = 'interrupted';
          run.finishedAt = new Date(clock()).toISOString();
          run.error = 'The gateway stopped. This run was not replayed.';
          const job = state.jobs.find((job) => job.id === run.jobId);
          if (job) {
            job.enabled = false;
            job.revision++;
          }
          changed = true;
        }
      return { changed };
    });
  }
  return {
    list,
    mutate,
    tick,
    notification,
    disconnected: interrupted,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick().catch(() => {}), pollMs);
      timer.unref?.();
      void tick().catch(() => {});
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await interrupted();
    }
  };
}
