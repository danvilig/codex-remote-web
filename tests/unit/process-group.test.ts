import { expect, test } from 'bun:test';
import { reapProcessGroup } from '../../src/server/bridge/process-group.js';

test('group cleanup waits for observed death after SIGKILL instead of its delivery syscall', async () => {
  let time = 0, killed = false, dead = false;
  const signals = [];
  await reapProcessGroup(123, {
    signal: name => { signals.push(name); if (name === 'SIGKILL') killed = true; },
    isRunning: async () => !dead,
    now: () => time, graceMs: 10, killMs: 20,
    wait: async () => { time += 5; if (killed && time >= 20) dead = true; },
  });
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(dead).toBe(true);
  expect(time).toBe(20);
});

test('group cleanup reports a bounded failure when force-kill cannot be confirmed', async () => {
  let time = 0;
  await expect(reapProcessGroup(123, {
    signal: () => {}, isRunning: async () => true,
    now: () => time, wait: async () => { time += 5; }, graceMs: 10, killMs: 10,
  })).rejects.toThrow('did not exit after SIGKILL');
  expect(time).toBe(20);
});

test('group cleanup accepts ESRCH and preserves permission and observation failures', async () => {
  await reapProcessGroup(123, { signal: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
  await expect(reapProcessGroup(123, { signal: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } })).rejects.toMatchObject({ code: 'EPERM' });
  await expect(reapProcessGroup(123, { signal: () => {}, isRunning: async () => { throw new Error('cannot inspect'); } })).rejects.toThrow('cannot inspect');
});
