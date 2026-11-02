import { constants } from 'node:fs';
import { mkdir, open, lstat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { scheduleOwner, scheduleOwnerAlive } from './schedule-store.js';
import { acquirePrivateLock } from './private-lock.js';

const statuses = new Set(['prepared', 'dispatching', 'accepted', 'rejected', 'unknown']);
const pending = new Set(['prepared', 'dispatching']);
const maxBytes = 32 * 1024 * 1024;
const failure = (message, code, status = 409) => Object.assign(new Error(message), { code, status });
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const hash = value => createHash('sha256').update(value).digest('hex');
const publicReceipt = ({ digest, owner, ...receipt }) => structuredClone(receipt);
const errorInfo = (error, fallback) => ({
  code: typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : fallback,
  message: typeof error?.message === 'string' ? error.message.slice(0, 2000) : 'Submission could not be confirmed'
});

// A retry handled by another gateway can observe a receipt before dispatch.
// Only a rejected receipt proves failure; every other unfinished state must
// keep the browser in recovery rather than offer a fresh automatic send.
export function submissionResult(receipt) {
  if (receipt.status === 'accepted') return receipt.result;
  const rejected = receipt.status === 'rejected';
  throw Object.assign(new Error(receipt.error?.message || (typeof receipt.error === 'string' ? receipt.error : rejected ? 'Codex rejected this message.' : 'Delivery could not be confirmed. It was not replayed.')), {
    code: rejected ? receipt.error?.code || 'SUBMISSION_REJECTED' : 'SUBMISSION_UNKNOWN',
    data: { submissionId: receipt.id, status: receipt.status }
  });
}

// These receipts deduplicate gateway dispatch, not native execution. A crash in
// the native acceptance window is intentionally left unknown and never replayed.
export function createSubmissionService({ privateRoot, request, connected, onChange = () => {} }) {
  const directory = join(privateRoot, 'remote-web-submissions');
  const stateFile = join(directory, 'receipts.json');
  const owner = scheduleOwner(), inFlight = new Map();
  let closed = false;

  async function ensureDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
      throw failure('Unsafe submission directory', 'SUBMISSION_STORAGE_UNSAFE', 500);
  }
  async function readPrivate(path, limit = maxBytes) {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > limit)
        throw failure('Unsafe submission state', 'SUBMISSION_STORAGE_UNSAFE', 500);
      return { data: JSON.parse(await fd.readFile('utf8')), stat };
    } finally { await fd.close(); }
  }
  async function lock(name, waitMs = 5000) {
    await ensureDirectory();
    return acquirePrivateLock(join(directory, name), { timeoutMs: waitMs, legacyOwnerAlive: scheduleOwnerAlive });
  }
  async function load() {
    try {
      const { data } = await readPrivate(stateFile);
      if (data.format !== 1 || !Array.isArray(data.receipts) || data.receipts.length > 10000 || data.receipts.some(item => !statuses.has(item.status)))
        throw failure('Invalid submission state', 'SUBMISSION_STORAGE_UNSAFE', 500);
      return data;
    } catch (error) { if (error.code === 'ENOENT') return { format: 1, receipts: [] }; throw error; }
  }
  async function save(state) {
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > maxBytes) throw failure('Submission storage limit reached', 'SUBMISSION_STORAGE_FULL', 507);
    const temporary = join(directory, `.state-${randomUUID()}`), fd = await open(temporary, 'wx', 0o600);
    try { await fd.writeFile(data); await fd.sync(); }
    finally { await fd.close(); }
    try {
      await rename(temporary, stateFile);
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async function transaction(change) {
    const release = await lock('store.lock');
    try {
      const state = await load(), result = await change(state);
      if (result.changed !== false) await save(state);
      return result.value;
    } finally { await release(); }
  }
  function notify(receipt) { try { onChange(publicReceipt(receipt)); } catch { /* observers never change delivery */ } }
  function recoverState(state, own = false) {
    let changed = false;
    for (const receipt of state.receipts) {
      if (!pending.has(receipt.status) || !(own ? receipt.owner?.instance === owner.instance : !scheduleOwnerAlive(receipt.owner))) continue;
      receipt.error = { code: receipt.status === 'prepared' ? 'SUBMISSION_NOT_DISPATCHED' : 'SUBMISSION_UNKNOWN', message: receipt.status === 'prepared' ? 'The gateway stopped before dispatch. This submission was not sent.' : 'Native acceptance could not be confirmed. This submission was not replayed.' };
      receipt.status = receipt.status === 'prepared' ? 'rejected' : 'unknown';
      receipt.updatedAt = new Date().toISOString();
      changed = true;
    }
    return changed;
  }
  async function recover() {
    return transaction(state => {
      const changed = recoverState(state);
      return { changed, value: state.receipts.map(publicReceipt) };
    });
  }
  async function get(id) {
    return transaction(state => {
      const changed = recoverState(state);
      return { changed, value: state.receipts.find(item => item.id === id) ? publicReceipt(state.receipts.find(item => item.id === id)) : null };
    });
  }
  async function list({ threadId } = {}) {
    return transaction(state => ({ changed: recoverState(state), value: state.receipts.filter(item => !threadId || item.threadId === threadId).map(publicReceipt) }));
  }
  async function update(id, change) {
    const receipt = await transaction(state => {
      const item = state.receipts.find(item => item.id === id);
      if (!item) throw failure('Submission receipt not found', 'SUBMISSION_NOT_FOUND', 404);
      const changed = change(item) !== false;
      if (changed) item.updatedAt = new Date().toISOString();
      return { changed, value: publicReceipt(item) };
    });
    notify(receipt);
    return receipt;
  }
  function validate(input) {
    if (!input || typeof input.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id))
      throw failure('A submission UUID is required', 'SUBMISSION_INVALID', 400);
    if (!['turn/start', 'turn/steer'].includes(input.method) || !input.params || typeof input.params !== 'object' || Array.isArray(input.params) || typeof input.params.threadId !== 'string' || !input.params.threadId || input.params.threadId.length > 300 || !Array.isArray(input.params.input) || !input.params.input.length || (input.method === 'turn/steer' && (typeof input.params.expectedTurnId !== 'string' || !input.params.expectedTurnId)))
      throw failure('Unsupported submission parameters', 'SUBMISSION_INVALID', 400);
    if (input.params.clientUserMessageId != null && input.params.clientUserMessageId !== input.id)
      throw failure('Submission identity does not match native message identity', 'SUBMISSION_CONFLICT');
    let params;
    try { params = JSON.parse(JSON.stringify(input.params)); }
    catch { throw failure('Invalid submission payload', 'SUBMISSION_INVALID', 400); }
    params.clientUserMessageId = input.id;
    const serialized = canonical({ method: input.method, params });
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw failure('Submission is too large', 'SUBMISSION_INVALID', 413);
    return { ...input, params, digest: hash(serialized) };
  }
  async function dispatch(input) {
    const reserved = await transaction(state => {
      recoverState(state);
      const existing = state.receipts.find(item => item.id === input.id);
      if (existing) {
        if (existing.digest !== input.digest) throw failure('Submission UUID was already used for different content', 'SUBMISSION_CONFLICT');
        return { value: { created: false, receipt: publicReceipt(existing) } };
      }
      if (closed || !connected()) throw failure('Connect to Codex before sending', 'SUBMISSION_UNAVAILABLE', 503);
      if (state.receipts.length >= 10000) throw failure('Submission receipt capacity reached', 'SUBMISSION_STORAGE_FULL', 507);
      const now = new Date().toISOString(), receipt = { id: input.id, status: 'prepared', method: input.method, threadId: input.params.threadId, ...(input.params.expectedTurnId ? { targetTurnId: input.params.expectedTurnId } : {}), digest: input.digest, owner, createdAt: now, updatedAt: now };
      state.receipts.push(receipt);
      return { value: { created: true, receipt: publicReceipt(receipt) } };
    });
    if (!reserved.created) return reserved.receipt;
    notify(reserved.receipt);
    let release;
    try {
      release = await lock(`thread-${hash(input.params.threadId)}.lock`, 120000);
      if (closed || !connected()) return update(input.id, receipt => {
        if (receipt.status !== 'prepared') return false;
        receipt.status = 'rejected'; receipt.error = { code: 'SUBMISSION_NOT_DISPATCHED', message: 'The gateway disconnected before dispatch. This submission was not sent.' };
      });
      if (input.beforeDispatch && await input.beforeDispatch() === false) {
        const deferred = await transaction(state => {
          const receipt = state.receipts.find(item => item.id === input.id);
          if (receipt?.status !== 'prepared' || receipt.owner?.instance !== owner.instance)
            return { changed: false, value: receipt ? publicReceipt(receipt) : null };
          state.receipts = state.receipts.filter(item => item !== receipt);
          return { value: { id: input.id, status: 'deferred', threadId: receipt.threadId, method: receipt.method } };
        });
        if (deferred) notify(deferred);
        return deferred;
      }
      const receipt = await update(input.id, receipt => {
        if (receipt.status !== 'prepared') return false;
        receipt.status = 'dispatching';
      });
      if (receipt.status !== 'dispatching') return receipt;
      try {
        const result = await request(input.method, input.params, {
          onLateResponse: (result, error) => update(input.id, receipt => {
            if (!['dispatching', 'unknown'].includes(receipt.status)) return false;
            if (error) {
              if (error.nativeResponse !== true) return false;
              receipt.status = 'rejected'; receipt.error = errorInfo(error, 'SUBMISSION_REJECTED');
            } else {
              receipt.status = 'accepted'; receipt.result = result;
              const turnId = result?.turn?.id || result?.turnId;
              if (turnId) receipt.turnId = turnId;
              delete receipt.error;
            }
          })
        });
        return await update(input.id, receipt => {
          if (!['dispatching', 'unknown'].includes(receipt.status)) return false;
          receipt.status = 'accepted'; receipt.result = result;
          const turnId = result?.turn?.id || result?.turnId;
          if (turnId) receipt.turnId = turnId;
          delete receipt.error;
        });
      } catch (error) {
        return await update(input.id, receipt => {
          if (!['dispatching', 'unknown'].includes(receipt.status)) return false;
          // Only an explicit JSON-RPC error proves native rejection. A socket
          // write or timeout error does not prove whether native accepted it.
          receipt.status = error?.nativeResponse === true || error?.dispatchState === 'not-sent' ? 'rejected' : 'unknown';
          receipt.error = errorInfo(error, receipt.status === 'rejected' ? 'SUBMISSION_REJECTED' : 'SUBMISSION_UNKNOWN');
        });
      }
    } catch (error) {
      return update(input.id, receipt => {
        if (!pending.has(receipt.status)) return false;
        const unsent = receipt.status === 'prepared';
        receipt.status = unsent ? 'rejected' : 'unknown';
        receipt.error = errorInfo(error, unsent ? 'SUBMISSION_NOT_DISPATCHED' : 'SUBMISSION_UNKNOWN');
      });
    } finally { if (release) await release(); }
  }
  async function submit(value) {
    const input = validate(value), existing = inFlight.get(input.id);
    if (existing) {
      if (existing.digest !== input.digest) throw failure('Submission UUID was already used for different content', 'SUBMISSION_CONFLICT');
      return existing.promise;
    }
    const promise = dispatch(input);
    inFlight.set(input.id, { digest: input.digest, promise });
    try { return await promise; } finally { inFlight.delete(input.id); }
  }
  async function reconcile(id) {
    const receipt = await get(id);
    if (!receipt || receipt.status !== 'unknown' || closed || !connected()) return receipt;
    // Exact clientId is the only positive evidence. A missing item, failed read
    // or exhausted scan leaves acceptance unknown; none authorizes resending.
    let cursor, match;
    try {
      for (let page = 0; page < 20; page++) {
        const result = await request('thread/turns/list', { threadId: receipt.threadId, limit: 50, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
        for (const turn of result?.data || []) {
          if (turn.items?.some(item => item.type === 'userMessage' && item.clientId === id)) { match = turn; break; }
        }
        if (match || !result?.nextCursor || result.nextCursor === cursor) break;
        cursor = result.nextCursor;
      }
    } catch { return get(id); }
    if (!match) return get(id);
    return update(id, current => {
      if (current.status !== 'unknown') return false;
      current.status = 'accepted'; current.turnId = match.id; current.reconciledAt = new Date().toISOString();
      current.result = current.method === 'turn/steer' ? { turnId: match.id } : { turn: match };
      delete current.error;
    });
  }
  async function close() {
    closed = true;
    await transaction(state => ({ changed: recoverState(state, true) }));
  }
  return { submit, get, list, reconcile, recover, close };
}
