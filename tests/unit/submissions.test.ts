import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSubmissionService, submissionResult } from '../../src/server/services/submissions.js';

const roots: string[] = [], services: ReturnType<typeof createSubmissionService>[] = [];
test('RPC retries preserve every unfinished receipt as uncertain rather than report a rejected send', () => {
  for (const status of ['prepared', 'dispatching', 'unknown']) {
    expect(() => submissionResult({ id: 'duplicate', status })).toThrow(expect.objectContaining({ code: 'SUBMISSION_UNKNOWN', data: { submissionId: 'duplicate', status } }));
  }
  expect(() => submissionResult({ id: 'rejected', status: 'rejected', error: { code: -32602, message: 'native refusal' } })).toThrow(expect.objectContaining({ code: -32602, message: 'native refusal' }));
  expect(submissionResult({ id: 'accepted', status: 'accepted', result: { turn: { id: 'native-turn' } } })).toEqual({ turn: { id: 'native-turn' } });
});
const input = (id = randomUUID(), threadId = 'thread-1') => ({ id, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'hello' }] } });
async function fixture(request: (method: string, params: any, options?: any) => Promise<any>, privateRoot?: string) {
  privateRoot ||= await mkdtemp(join(tmpdir(), 'crw-submissions-'));
  if (!roots.includes(privateRoot)) roots.push(privateRoot);
  const service = createSubmissionService({ privateRoot, request, connected: () => true });
  services.push(service);
  return { service, privateRoot };
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.close().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function worker(root: string, submission: any, delay = 30, crash: boolean | 'prepared' = false) {
  const module = pathToFileURL(join(import.meta.dir, '../../src/server/services/submissions.js')).href;
  const code = `import {createSubmissionService} from ${JSON.stringify(module)};
    import {appendFile} from 'node:fs/promises';
    const root=${JSON.stringify(root)}, input=${JSON.stringify(submission)};
    const service=createSubmissionService({privateRoot:root,connected:()=>true,request:async(method,params)=>{
      await appendFile(root+'/dispatches',JSON.stringify({kind:'start',id:params.clientUserMessageId})+'\\n');
      ${crash ? "process.stdout.write('entered\\n');await new Promise(()=>{setInterval(()=>{},1000)});" : `await new Promise(resolve=>setTimeout(resolve,${delay}));`}
      await appendFile(root+'/dispatches',JSON.stringify({kind:'end',id:params.clientUserMessageId})+'\\n');
      return {turn:{id:'turn-'+params.clientUserMessageId,items:[]}};
    }});
    console.log(JSON.stringify(await service.submit({...input,${crash === 'prepared' ? "beforeDispatch:async()=>{console.log('prepared');await new Promise(()=>setInterval(()=>{},1000));return true}" : ''}})));`;
  const child = spawn(process.execPath, ['--eval', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const done = new Promise<string>((resolve, reject) => child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`worker ${code}: ${errors}`))));
  return { child, done, output: () => output };
}

describe('durable submission receipts', () => {
  test('concurrent retries dispatch once and preserve the original result', async () => {
    const calls: any[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { service, privateRoot } = await fixture(async (method, params) => { calls.push({ method, params }); await gate; return { turn: { id: 'native-turn', status: 'inProgress' } }; });
    const submission = input();
    const a = service.submit(submission), b = service.submit({ ...submission, params: { input: submission.params.input, threadId: 'thread-1' } });
    while (!calls.length) await new Promise(resolve => setTimeout(resolve, 5));
    expect((await service.get(submission.id))?.status).toBe('dispatching');
    release();
    const [first, second] = await Promise.all([a, b]);
    expect(first).toEqual(second);
    expect(first.result).toEqual({ turn: { id: 'native-turn', status: 'inProgress' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].params.clientUserMessageId).toBe(submission.id);
    const next = (await fixture(async () => { throw new Error('must not redispatch'); }, privateRoot)).service;
    expect(await next.submit(submission)).toEqual(first);
    const bytes = await readFile(join(privateRoot, 'remote-web-submissions/receipts.json'), 'utf8');
    expect(bytes).not.toContain('hello');
    expect(first).not.toHaveProperty('owner');
    expect(first).not.toHaveProperty('digest');
  });

  test('same UUID with different payload conflicts, while identical texts with distinct UUIDs remain separate', async () => {
    let writes = 0;
    const { service } = await fixture(async () => ({ turn: { id: `turn-${++writes}` } }));
    const submission = input();
    await service.submit(submission);
    await expect(service.submit({ ...submission, params: { ...submission.params, input: [{ type: 'text', text: 'different' }] } })).rejects.toMatchObject({ code: 'SUBMISSION_CONFLICT', status: 409 });
    await service.submit(input());
    expect(writes).toBe(2);
    expect(await service.list({ threadId: 'thread-1' })).toHaveLength(2);
    expect(await service.list({ threadId: 'other' })).toEqual([]);
    await expect(service.submit(input('not-a-uuid'))).rejects.toMatchObject({ code: 'SUBMISSION_INVALID' });
  });

  test('only definitive native rejection or pre-send failure is rejected; ambiguous failures are never replayed', async () => {
    let writes = 0;
    const failures = [Object.assign(new Error('denied'), { nativeResponse: true, code: -32602 }), Object.assign(new Error('not sent'), { dispatchState: 'not-sent' }), Object.assign(new Error('timeout'), { code: 'RPC_TIMEOUT' }), new Error('socket lost')];
    const { service } = await fixture(async () => { throw failures[writes++]; });
    for (const [index, status] of ['rejected', 'rejected', 'unknown', 'unknown'].entries()) {
      const submission = input();
      const receipt = await service.submit(submission);
      expect(receipt.status).toBe(status);
      expect(await service.submit(submission)).toEqual(receipt);
      if (index === 0) expect(receipt.error?.code).toBe(-32602);
    }
    expect(writes).toBe(4);
  });

  test('reconciliation accepts exact native clientId across pages, never a matching message body', async () => {
    const submission = input();
    let pages = 0;
    let reveal = false;
    const { service } = await fixture(async method => {
      if (method === 'turn/start') throw new Error('lost reply');
      pages++;
      if (pages % 2) return { data: [{ id: 'wrong-turn', items: [{ type: 'userMessage', clientId: randomUUID(), content: [{ type: 'text', text: 'hello' }] }] }], nextCursor: 'next' };
      return { data: reveal ? [{ id: 'matched-turn', items: [{ type: 'userMessage', clientId: submission.id }] }] : [], nextCursor: null };
    });
    await service.submit(submission);
    expect((await service.reconcile(submission.id))?.status).toBe('unknown');
    reveal = true;
    const recovered = await service.reconcile(submission.id);
    expect(recovered).toMatchObject({ status: 'accepted', turnId: 'matched-turn', result: { turn: { id: 'matched-turn' } } });
    expect(pages).toBe(4);
  });

  test('recover does not interfere with another live gateway; closing own unresolved send is unknown until late success', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const a = await fixture(async () => { await gate; return { turnId: 'steered-turn' }; });
    const b = await fixture(async () => { throw new Error('must not send'); }, a.privateRoot);
    const submission = { ...input(), method: 'turn/steer', params: { ...input().params, expectedTurnId: 'steered-turn' } };
    const sending = a.service.submit(submission);
    while ((await b.service.get(submission.id))?.status !== 'dispatching') await new Promise(resolve => setTimeout(resolve, 5));
    expect((await b.service.recover())[0].status).toBe('dispatching');
    await a.service.close();
    expect((await b.service.get(submission.id))?.status).toBe('unknown');
    release();
    expect((await sending).status).toBe('accepted');
    expect((await b.service.get(submission.id))?.result).toEqual({ turnId: 'steered-turn' });
  });

  test('independent gateway processes deduplicate UUIDs and serialize different sends to one thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crw-submission-process-')); roots.push(root);
    const submission = input();
    const a = worker(root, submission, 70), b = worker(root, submission, 70);
    const replies = (await Promise.all([a.done, b.done])).map(line => JSON.parse(line.trim()));
    expect(replies.some(receipt => receipt.status === 'accepted')).toBe(true);
    let events = (await readFile(join(root, 'dispatches'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.kind === 'start')).toHaveLength(1);
    const c = worker(root, input(), 70), d = worker(root, input(), 70);
    await Promise.all([c.done, d.done]);
    events = (await readFile(join(root, 'dispatches'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.kind)).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);
  }, 10000);

  test('queue guard executes under the shared thread lock and safely defers without consuming its UUID', async () => {
    let release!: () => void, started!: () => void, active = false, guardCalls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const main = await fixture(async () => { active = true; started(); await gate; return { turn: { id: 'main-turn' } }; });
    let queueWrites = 0;
    const queue = await fixture(async () => { queueWrites++; return { turn: { id: 'queued-turn' } }; }, main.privateRoot);
    const mainSend = main.service.submit(input()); await entered;
    const queued = input();
    const waiting = queue.service.submit({ ...queued, beforeDispatch: async () => { guardCalls++; return !active; } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(guardCalls).toBe(0);
    release(); await mainSend;
    expect(await waiting).toMatchObject({ id: queued.id, status: 'deferred' });
    expect(queueWrites).toBe(0);
    expect(await queue.service.get(queued.id)).toBeNull();
    active = false;
    expect((await queue.service.submit({ ...queued, beforeDispatch: () => !active })).status).toBe('accepted');
    expect(queueWrites).toBe(1);
  });

  test('late native success settles the original unknown receipt without a second dispatch', async () => {
    let options: any, writes = 0;
    const { service } = await fixture(async (_method, _params, extra) => { writes++; options = extra; throw Object.assign(new Error('timeout'), { code: 'RPC_TIMEOUT' }); });
    const submission = input();
    expect((await service.submit(submission)).status).toBe('unknown');
    await options.onLateResponse({ turn: { id: 'late-native-turn' } });
    expect((await service.get(submission.id))?.status).toBe('accepted');
    expect((await service.submit(submission)).result).toEqual({ turn: { id: 'late-native-turn' } });
    expect(writes).toBe(1);
  });

  test('process death during dispatch recovers unknown, never dispatches again, and can reconcile later', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crw-submission-crash-')); roots.push(root);
    const submission = input(), child = worker(root, submission, 0, true);
    const exited = child.done.catch(() => '');
    while (!child.output().includes('entered')) await new Promise(resolve => setTimeout(resolve, 5));
    child.child.kill('SIGKILL'); await exited;
    let writes = 0;
    const { service } = await fixture(async method => {
      if (method !== 'thread/turns/list') { writes++; throw new Error('must not execute'); }
      return { data: [{ id: 'accepted-before-crash', items: [{ type: 'userMessage', clientId: submission.id }] }], nextCursor: null };
    }, root);
    expect((await service.recover())[0].status).toBe('unknown');
    expect((await service.submit(submission)).status).toBe('unknown');
    expect((await service.reconcile(submission.id))?.status).toBe('accepted');
    expect(writes).toBe(0);
  }, 10000);

  test('process death after durable preparation but before native dispatch is definitively unsent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crw-submission-prepared-crash-')); roots.push(root);
    const submission = input(), child = worker(root, submission, 0, 'prepared');
    const exited = child.done.catch(() => '');
    while (!child.output().includes('prepared')) await new Promise(resolve => setTimeout(resolve, 5));
    child.child.kill('SIGKILL'); await exited;
    const {service} = await fixture(async () => {throw new Error('must not execute');},root);
    expect((await service.recover())[0]).toMatchObject({status:'rejected',error:{code:'SUBMISSION_NOT_DISPATCHED'}});
    expect((await service.submit(submission)).status).toBe('rejected');
    await expect(readFile(join(root,'dispatches'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
  },10000);

  test('unsafe symlinked storage is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crw-submission-unsafe-')); roots.push(root);
    const other = join(root, 'other'); await mkdir(other, { mode: 0o700 });
    await symlink(other, join(root, 'remote-web-submissions'));
    const { service } = await fixture(async () => ({}), root);
    await expect(service.submit(input())).rejects.toMatchObject({ code: 'SUBMISSION_STORAGE_UNSAFE' });
  });
});
