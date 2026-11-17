// Disposable Task Scheduler substitute for executable-level transaction tests.
// It exercises the production process boundary and private-store writes, without
// claiming to validate Windows COM behavior or registering a real login task.
const { readFileSync, writeFileSync, rmSync, appendFileSync, chmodSync } = require('node:fs');
const { join } = require('node:path');
const root = process.env.CRW_TASK_TEST_ROOT;
const taskPath = join(root, 'task.json');
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const input = key => JSON.parse(Buffer.from(process.env[key], 'base64').toString('utf8'));
const snapshot = task => task && { xml: task.xml, enabled: task.enabled };
const save = task => task ? writeFileSync(taskPath, JSON.stringify(task)) : rmSync(taskPath, { force: true });
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const operation = process.env.CRW_TASK_OPERATION;
const spec = input('CRW_TASK_SPEC'), previous = input('CRW_TASK_PREVIOUS');
const fault = read(join(root, 'fault.json')) || {};
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ operation, spec }) + '\n');
try {
  let current = read(taskPath);
  if (['inspect', 'apply'].includes(operation) && current && (!previous || current.definition.executable !== previous.executable || current.definition.arguments !== previous.arguments)) {
    throw new Error('The background task changed; preserve it');
  }
  let result;
  if (operation === 'inspect' || operation === 'snapshot') {
    result = snapshot(current);
    if (operation === 'inspect' && fault.readonlyInspect) chmodSync(join(root, 'desktop'), 0o500);
  }
  else if (operation === 'apply') {
    if (fault.exitBeforeApply) throw new Error('Simulated scheduler failure before mutation');
    if (fault.changeBeforeApply) {
      current = fault.changeBeforeApply;
      save(current);
    }
    if (!equal(snapshot(current), input('CRW_TASK_BEFORE'))) throw new Error('The background task changed; preserve it');
    const next = process.env.CRW_TASK_ENABLED === '1'
      ? { definition: spec, xml: JSON.stringify({ definition: spec, settings: 'managed' }), enabled: true }
      : null;
    save(next); result = snapshot(next);
    if (fault.foreignAfterApply) save(fault.foreignAfterApply);
    if (fault.readonly) chmodSync(join(root, 'desktop'), 0o500);
    if (fault.exitAfterApply) throw new Error('Simulated lost reply after scheduler mutation');
    if (fault.malformedApplyReply) { process.stdout.write('{invalid JSON'); process.exit(0); }
  } else if (operation === 'rollback') {
    if (fault.rollbackFailure) throw new Error('Simulated scheduler rollback failed');
    if (!equal(snapshot(current), input('CRW_TASK_AFTER'))) throw new Error('The background task changed before rollback; preserve it');
    const before = input('CRW_TASK_BEFORE');
    save(before && { ...before, definition: JSON.parse(before.xml).definition });
    result = before;
  } else throw new Error('Unknown scheduler operation');
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error.message); process.exitCode = 1;
}
