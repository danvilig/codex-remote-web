import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureSession, sessionDefinition } from '../../desktop/session.js';
import { readPrivate, writePrivate } from '../../src/server/desktop/private-store.js';

// A Unix executable shim can emulate powershell.exe without touching the host
// scheduler. These tests validate transaction control flow, not Windows COM.
const offline = process.platform === 'win32' ? test.skip : test;
const task = (definition, enabled = true, settings = 'managed') => ({
  definition, enabled, xml: JSON.stringify({ definition, settings }),
});
async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), 'desktop-windows-session-'));
  const directory = join(home, 'desktop'), system = join(home, 'Windows');
  const bin = join(system, 'System32/WindowsPowerShell/v1.0');
  const previousEnv = { SystemRoot: process.env.SystemRoot, CRW_TASK_TEST_ROOT: process.env.CRW_TASK_TEST_ROOT };
  const options = { platform: 'win32', home, directory, executable: 'C:\\fixture\\Application.exe' };
  const definition = sessionDefinition(options), record = join(directory, 'session.json');
  const getTask = async () => {
    try { return JSON.parse(await readFile(join(home, 'task.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  try {
    await mkdir(bin, { recursive: true });
    const scheduler = await readFile(new URL('../fixtures/windows-session-scheduler.js', import.meta.url), 'utf8');
    await writeFile(join(bin, 'powershell.exe'), '#!' + Bun.which('node') + '\n' + scheduler, { mode: 0o700 });
    Object.assign(process.env, { SystemRoot: system, CRW_TASK_TEST_ROOT: home });
    await run({ options, definition, record, pending: join(directory, 'session-windows-pending.json'), getTask,
      setTask: next => next ? writeFile(join(home, 'task.json'), JSON.stringify(next)) : rm(join(home, 'task.json'), { force: true }),
      fault: value => writeFile(join(home, 'fault.json'), JSON.stringify(value)),
      writable: () => chmod(directory, 0o700),
      calls: async () => (await readFile(join(home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).operation),
    });
  } finally {
    await chmod(directory, 0o700).catch(() => {});
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}

offline('identical Windows enable repairs a missing or disabled scheduled task', async () => fixture(async f => {
  await configureSession(true, f.options);
  await configureSession(true, f.options);
  expect(await f.calls()).toEqual(['inspect', 'apply', 'inspect']);
  expect(await readPrivate(f.pending)).toBeNull();
  for (const existing of [null, task(f.definition, false)]) {
    await f.setTask(existing);
    await configureSession(true, f.options);
    expect(await f.getTask()).toEqual(task(f.definition));
    expect(await readPrivate(f.record)).toEqual(f.definition);
  }
  expect((await f.calls()).filter(value => value === 'inspect')).toHaveLength(4);
  expect((await f.calls()).filter(value => value === 'apply')).toHaveLength(3);
}));

offline('identical Windows enable preserves a foreign scheduled task', async () => fixture(async f => {
  await configureSession(true, f.options);
  const foreign = task({ ...f.definition, executable: 'C:\\fixture\\Foreign.exe' });
  await f.setTask(foreign);
  await expect(configureSession(true, f.options)).rejects.toThrow('changed');
  expect(await f.getTask()).toEqual(foreign);
  expect(await readPrivate(f.record)).toEqual(f.definition);
  expect((await f.calls()).filter(value => value === 'apply')).toHaveLength(1);
}));

for (const operation of ['create', 'update', 'delete']) {
  offline(`Windows ${operation} rolls back exact task state after private-record persistence fails`, async () => fixture(async f => {
    let before = null;
    if (operation !== 'create') {
      await configureSession(true, f.options);
      // Capture a disabled task and customized settings, rather than deriving
      // rollback from the saved launcher's enabled=true default.
      before = task(f.definition, false, 'retained settings');
      await f.setTask(before);
    }
    await f.fault({ readonly: true });
    const options = operation === 'update' ? { ...f.options, executable: 'C:\\fixture\\Updated.exe' } : f.options;
    await expect(configureSession(operation !== 'delete', options)).rejects.toMatchObject({ code: 'EACCES' });
    expect(await f.getTask()).toEqual(before);
    expect(await readPrivate(f.record)).toEqual(operation === 'create' ? null : f.definition);
    expect((await f.calls()).at(-1)).toBe('rollback');
    // Rollback succeeded, but read-only state still prevents deleting intent.
    expect(await readPrivate(f.pending)).not.toBeNull();
    await f.writable(); await f.fault({});
    // A subsequent unregister must remain useful after the failed transaction.
    await configureSession(false, f.options);
    expect(await f.getTask()).toBeNull();
    expect(await readPrivate(f.record)).toBeNull();
    expect(await readPrivate(f.pending)).toBeNull();
  }));
}

offline('Windows persistence rollback preserves a concurrently replaced task and reports both failures', async () => fixture(async f => {
  await configureSession(true, f.options);
  const foreign = task({ ...f.definition, executable: 'C:\\fixture\\Other.exe' }, true, 'foreign');
  await f.fault({ readonly: true, foreignAfterApply: foreign });
  let failure;
  try { await configureSession(true, { ...f.options, executable: 'C:\\fixture\\Updated.exe' }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors[0]).toMatchObject({ code: 'EACCES' });
  expect(failure.errors[1].message).toContain('changed before rollback');
  expect(await f.getTask()).toEqual(foreign);
  expect(await readPrivate(f.record)).toEqual(f.definition);
  expect(await readPrivate(f.pending)).not.toBeNull();
}));

offline('Windows scheduler rollback failure is surfaced alongside the persistence error', async () => fixture(async f => {
  await f.fault({ readonly: true, rollbackFailure: true });
  let failure;
  try { await configureSession(true, f.options); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors[0]).toMatchObject({ code: 'EACCES' });
  expect(failure.errors[1].message).toContain('scheduler rollback failed');
  expect(await f.getTask()).toEqual(task(f.definition));
  expect(await readPrivate(f.record)).toBeNull();
  expect(await readPrivate(f.pending)).not.toBeNull();
}));

offline('Windows apply checks the inspected task again before overwriting it', async () => fixture(async f => {
  await configureSession(true, f.options);
  const foreign = task({ ...f.definition, executable: 'C:\\fixture\\Other.exe' });
  await f.fault({ changeBeforeApply: foreign });
  await expect(configureSession(true, { ...f.options, executable: 'C:\\fixture\\Updated.exe' })).rejects.toMatchObject({ code: 'SESSION_RECOVERY_REQUIRED' });
  expect(await f.getTask()).toEqual(foreign);
  expect(await readPrivate(f.record)).toEqual(f.definition);
  expect(await readPrivate(f.pending)).not.toBeNull();
}));

for (const faultName of ['exitAfterApply', 'malformedApplyReply']) {
  for (const operation of ['create', 'update', 'delete']) {
    offline(`Windows uncertain ${operation} retains durable intent after ${faultName}`, async () => fixture(async f => {
      if (operation !== 'create') await configureSession(true, f.options);
      const options = operation === 'update' ? { ...f.options, executable: 'C:\\fixture\\Updated.exe' } : f.options;
      const intended = operation === 'delete' ? null : task(sessionDefinition(options));
      await f.fault({ [faultName]: true });
      await expect(configureSession(operation !== 'delete', options)).rejects.toMatchObject({ code: 'SESSION_RECOVERY_REQUIRED' });
      expect(await f.getTask()).toEqual(intended);
      expect(await readPrivate(f.record)).toEqual(operation === 'create' ? null : f.definition);
      const pending = await readPrivate(f.pending);
      expect(pending).not.toBeNull();
      expect(Object.hasOwn(pending, 'after')).toBe(false);
      const calls = await f.calls();
      await f.fault({});
      // Even missing/foreign saved ownership cannot turn uncertain startup
      // into an uninstall success through the expectedInstallation shortcut.
      await expect(configureSession(false, { ...f.options, expectedInstallation: 'C:\\fixture\\Unrelated.exe' })).rejects.toMatchObject({ code: 'SESSION_RECOVERY_REQUIRED' });
      expect(await f.getTask()).toEqual(intended);
      expect(await readPrivate(f.pending)).toEqual(pending);
      expect((await f.calls()).slice(calls.length)).toEqual(['snapshot']);
    }));
  }
}

offline('Windows failed apply with confirmed unchanged actual state clears pending intent', async () => fixture(async f => {
  await configureSession(true, f.options);
  await f.fault({ exitBeforeApply: true });
  await expect(configureSession(true, { ...f.options, executable: 'C:\\fixture\\Updated.exe' })).rejects.toThrow('before mutation');
  expect(await f.getTask()).toEqual(task(f.definition));
  expect(await readPrivate(f.record)).toEqual(f.definition);
  expect(await readPrivate(f.pending)).toBeNull();
  expect((await f.calls()).at(-1)).toBe('snapshot');
  await f.fault({});
  await configureSession(false, f.options);
  expect(await f.getTask()).toBeNull();
}));

for (const invalid of ['task-name', 'saved-name', 'snapshot']) {
  offline(`Windows pending intent rejects invalid ${invalid} before querying the scheduler`, async () => fixture(async f => {
    await configureSession(true, f.options);
    const current = await f.getTask();
    const pending = { version: 1, spec: f.definition, saved: f.definition, enabled: true, before: { xml: current.xml, enabled: current.enabled } };
    if (invalid === 'task-name') pending.spec = { ...f.definition, name: 'Foreign task name' };
    if (invalid === 'saved-name') pending.saved = { ...f.definition, name: 'Foreign task name' };
    if (invalid === 'snapshot') pending.before = { xml: '', enabled: true };
    await writePrivate(f.pending, pending);
    const calls = await f.calls();
    await expect(configureSession(false, { ...f.options, expectedInstallation: 'C:\\fixture\\Unrelated.exe' })).rejects.toMatchObject({ code: 'SESSION_RECOVERY_REQUIRED' });
    expect(await f.calls()).toEqual(calls);
    expect(await f.getTask()).toEqual(current);
    expect(await readPrivate(f.pending)).toEqual(pending);
    expect(await readPrivate(f.record)).toEqual(f.definition);
  }));
}

offline('Windows literal null pending intent is invalid rather than absent', async () => fixture(async f => {
  await configureSession(true, f.options);
  await writePrivate(f.pending, null);
  const calls = await f.calls();
  await expect(configureSession(false, { ...f.options, expectedInstallation: 'C:\\fixture\\Unrelated.exe' })).rejects.toMatchObject({ code: 'SESSION_RECOVERY_REQUIRED' });
  expect(await f.calls()).toEqual(calls);
  expect(await Bun.file(f.pending).exists()).toBe(true);
  expect(await f.getTask()).toEqual(task(f.definition));
  expect(await readPrivate(f.record)).toEqual(f.definition);
}));

offline('Windows fully committed interrupted registration clears intent without rolling back', async () => fixture(async f => {
  await configureSession(true, f.options);
  const before = await f.getTask();
  const options = { ...f.options, executable: 'C:\\fixture\\Updated.exe' };
  const intended = sessionDefinition(options), after = task(intended);
  // Model a process exit after both task and private record commit, before
  // removing the durable completed intent. Recovery must preserve that commit.
  await f.setTask(after);
  await writePrivate(f.record, intended);
  await writePrivate(f.pending, { version: 1, spec: intended, saved: f.definition, enabled: true,
    before: { xml: before.xml, enabled: before.enabled }, after: { xml: after.xml, enabled: after.enabled } });
  const calls = await f.calls();
  await configureSession(true, options);
  expect((await f.calls()).slice(calls.length)).toEqual(['snapshot', 'inspect']);
  expect(await f.getTask()).toEqual(after);
  expect(await readPrivate(f.record)).toEqual(intended);
  expect(await readPrivate(f.pending)).toBeNull();
}));

offline('Windows interrupted record commit restores the old record when actual task proves rollback', async () => fixture(async f => {
  await configureSession(true, f.options);
  const before = await f.getTask(), intended = sessionDefinition({ ...f.options, executable: 'C:\\fixture\\Updated.exe' });
  const after = task(intended);
  // The task rollback completed, but interruption left the new private record
  // and journal. Exact original XML is evidence to restore the old record.
  await writePrivate(f.record, intended);
  await writePrivate(f.pending, { version: 1, spec: intended, saved: f.definition, enabled: true,
    before: { xml: before.xml, enabled: before.enabled }, after: { xml: after.xml, enabled: after.enabled } });
  const calls = await f.calls();
  await configureSession(true, f.options);
  expect((await f.calls()).slice(calls.length)).toEqual(['snapshot', 'inspect']);
  expect(await f.getTask()).toEqual(before);
  expect(await readPrivate(f.record)).toEqual(f.definition);
  expect(await readPrivate(f.pending)).toBeNull();
}));

offline('Windows failure to persist original task intent prevents scheduler mutation', async () => fixture(async f => {
  await configureSession(true, f.options);
  const before = await f.getTask(), calls = await f.calls();
  await f.fault({ readonlyInspect: true });
  await expect(configureSession(true, { ...f.options, executable: 'C:\\fixture\\Updated.exe' })).rejects.toMatchObject({ code: 'EACCES' });
  expect((await f.calls()).slice(calls.length)).toEqual(['inspect']);
  expect(await f.getTask()).toEqual(before);
  expect(await readPrivate(f.record)).toEqual(f.definition);
  expect(await readPrivate(f.pending)).toBeNull();
}));
