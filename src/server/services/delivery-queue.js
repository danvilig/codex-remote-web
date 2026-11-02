import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { createDeliveryStore, scheduleOwner, scheduleOwnerAlive } from './delivery-store.js';

const terminal = entry => ['completed', 'cancelled'].includes(entry.status);
const unresolved = status => ['prepared', 'dispatching', 'unknown'].includes(status);
const conflict = () => Object.assign(new Error('Queue changed. Refresh before trying again.'), { status: 409, code: 'QUEUE_CONFLICT' });
const blocked = () => Object.assign(new Error('Another message in this conversation is awaiting delivery confirmation. Check its status before continuing.'), { status: 409, code: 'QUEUE_DELIVERY_UNCONFIRMED' });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const copy = entry => entry && structuredClone(entry);
const publicEntry = entry => { if (!entry) return entry; const { owner, claim, fingerprint, ...value } = entry; return copy(value); };

// This lock coordinates local gateways, not an independent Desktop process.
// Native turn/start has no expected-idle precondition; check immediately before
// submission, and never replay a request whose acceptance is uncertain.
export function createDeliveryQueue({ privateRoot, submissions, request, connected, onChange = () => {}, resolveCwd, pollMs = 1000 }) {
  const store = createDeliveryStore(privateRoot), owner = scheduleOwner();
  let timer, stopped = true, ticking = false;
  async function unresolvedReceipts() {
    // A direct composer submission may have no queue entry. Its journal is
    // nevertheless authoritative for whether this conversation can advance.
    return submissions.list ? (await submissions.list()).filter(receipt => unresolved(receipt.status)) : [];
  }
  function threadBlocked(state, threadId, receipts, exceptId) {
    return state.entries.some(entry => entry.threadId === threadId && entry.id !== exceptId && ['sending', 'unknown'].includes(entry.status)) ||
      receipts.some(receipt => receipt.threadId === threadId && receipt.id !== exceptId && unresolved(receipt.status));
  }
  function changed(threadId) { try { onChange({ type: 'delivery/changed', threadId }); } catch {} }
  function recover(state) {
    let dirty = false;
    for (const entry of state.entries) {
      if (terminal(entry) || !entry.owner || scheduleOwnerAlive(entry.owner)) continue;
      entry.status = ['sending', 'unknown'].includes(entry.status) ? 'unknown' : 'paused';
      entry.error = entry.status === 'unknown' ? 'Delivery could not be confirmed. It was not replayed.' : 'The gateway stopped. Resume this queued message to continue.';
      delete entry.claim; delete entry.owner; entry.version++; dirty = true;
    }
    return dirty;
  }
  async function list(threadId) {
    const state = await store.read();
    const settled = [];
    for (const entry of state.entries.filter(entry => entry.status === 'unknown')) {
      const receipt = await submissions.get?.(entry.id);
      if (receipt && ['accepted', 'rejected'].includes(receipt.status)) settled.push(receipt);
    }
    if (settled.length) await store.transaction(current => {
      let dirty = false;
      for (const receipt of settled) { const entry = current.entries.find(item => item.id === receipt.id); if (entry?.status !== 'unknown') continue; entry.status = receipt.status === 'accepted' ? 'completed' : 'failed'; entry.submissionStatus = receipt.status; entry.version++; dirty = true; }
      // A result that was uncertain must never silently release the following
      // messages. The operator explicitly resumes the next item after
      // inspecting the recovered receipt.
      for (const receipt of settled) {
        if (receipt.status !== 'accepted') continue;
        const entry = current.entries.find(item => item.id === receipt.id);
        if (!entry) continue;
        for (const next of current.entries) {
          if (next.threadId === entry.threadId && !terminal(next) && next.id !== entry.id && next.status === 'queued') {
            next.status = 'paused'; next.requiresResume = true; next.version++; dirty = true;
          }
        }
      }
      return { changed: dirty };
    });
    const current = settled.length ? await store.read() : state;
    return { entries: current.entries.filter(entry => !terminal(entry) && (!threadId || entry.threadId === threadId)).map(publicEntry) };
  }
  async function update(id, fn) {
    let threadId;
    const result = await store.transaction(state => {
      const entry = state.entries.find(entry => entry.id === id);
      if (!entry || entry.claim?.instance !== owner.instance) return { changed: false, value: null };
      threadId = entry.threadId; const visibleChange = fn(entry, state) !== false;
      if (visibleChange) { entry.version++; entry.updatedAt = Date.now(); }
      return { value: copy(entry) };
    });
    if (result) changed(threadId);
    return result;
  }
  async function currentTurn(threadId) {
    const result = await request('thread/read', { threadId, includeTurns: true });
    return result.thread?.turns?.findLast(turn => turn.status === 'inProgress') || result.thread?.turns?.at(-1);
  }
  async function dispatch(entry) {
    try {
      if (!connected() || stopped) { await update(entry.id, item => { item.status = 'paused'; delete item.claim; }); return; }
      let turn = await currentTurn(entry.threadId);
      if (!entry.sendNow && turn?.status === 'inProgress') {
        await update(entry.id, item => { const same = item.status === 'waiting' && item.waitTurnId === turn.id; item.status = 'waiting'; item.waitTurnId = turn.id; delete item.claim; return !same; }); return;
      }
      const resumed = await request('thread/resume', { threadId: entry.threadId });
      turn = resumed.thread?.turns?.findLast(turn => turn.status === 'inProgress') || await currentTurn(entry.threadId);
      if (!entry.sendNow && turn?.status === 'inProgress') {
        await update(entry.id, item => { const same = item.status === 'waiting' && item.waitTurnId === turn.id; item.status = 'waiting'; item.waitTurnId = turn.id; delete item.claim; return !same; }); return;
      }
      const latest = await update(entry.id, item => { item.status = 'sending'; });
      if (!latest || stopped || !connected()) return;
      const steering = Boolean(entry.sendNow && turn?.status === 'inProgress');
      const params = steering ? { threadId: entry.threadId, input: entry.params.input, expectedTurnId: turn.id, clientUserMessageId: entry.id } : { ...entry.params, threadId: entry.threadId, clientUserMessageId: entry.id };
      let guardedTurn;
      const receipt = await submissions.submit({ id: entry.id, method: steering ? 'turn/steer' : 'turn/start', params, beforeDispatch: async () => {
        if (stopped || !connected()) return false;
        // This guard runs under the submission service's per-thread lock.
        // Recheck receipts here, closing the race with an immediate send from
        // another WebUI client after the queue tick reserved this message.
        const receipts = await unresolvedReceipts(), state = await store.read();
        if (threadBlocked(state, entry.threadId, receipts, entry.id)) return false;
        const live = await currentTurn(entry.threadId); guardedTurn = live;
        if (steering) return live?.status === 'inProgress' && live.id === params.expectedTurnId;
        return live?.status !== 'inProgress';
      } });
      await update(entry.id, item => {
        item.status = receipt.status === 'accepted' ? 'completed' : receipt.status === 'rejected' ? 'failed' : receipt.status === 'deferred' ? 'waiting' : 'unknown';
        if (receipt.status === 'deferred' && guardedTurn?.status === 'inProgress') item.waitTurnId = guardedTurn.id;
        if (receipt.error) item.error = typeof receipt.error === 'string' ? receipt.error : receipt.error.message;
        if (receipt.status !== 'deferred') item.submissionStatus = receipt.status; delete item.claim; delete item.sendNow;
      });
    } catch (error) {
      await update(entry.id, item => {
        // Before native submission the reservation is known not to have sent.
        item.status = item.status === 'sending' ? 'unknown' : 'failed';
        item.error = item.status === 'unknown' ? 'Delivery could not be confirmed. It was not replayed.' : error.message;
        delete item.claim;
      }).catch(() => {});
    }
  }
  async function tick() {
    if (stopped || ticking || !connected()) return;
    ticking = true;
    try {
      const receipts = await unresolvedReceipts();
      const ready = await store.transaction(state => {
        let dirty = recover(state);
        const seen = new Set(), result = [];
        for (const entry of state.entries) {
          if (terminal(entry) || seen.has(entry.threadId)) continue;
          seen.add(entry.threadId);
          if (!['queued', 'waiting'].includes(entry.status) || entry.claim || entry.requiresResume) continue;
          if (threadBlocked(state, entry.threadId, receipts, entry.id)) continue;
          // Only the owner dispatches; another live gateway may list/mutate.
          if (entry.owner && entry.owner.instance !== owner.instance && scheduleOwnerAlive(entry.owner)) continue;
          entry.claim = owner; entry.owner = owner; result.push(copy(entry)); dirty = true;
        }
        return { value: result, changed: dirty };
      });
      await Promise.allSettled(ready.map(dispatch));
    } finally { ticking = false; }
  }
  async function mutate(action, payload = {}) {
    if (typeof action === 'object') { payload = action.payload || action; action = action.action; }
    if (!['enqueue', 'edit', 'reorder', 'cancel', 'pause', 'resume', 'sendNow'].includes(action)) throw Error('Unsupported queue action');
    const receipts = ['resume', 'sendNow', 'reorder'].includes(action) ? await unresolvedReceipts() : [];
    let threadId;
    const result = await store.transaction(state => {
      recover(state);
      if (action === 'enqueue') {
        if (!identity(payload.id) || typeof payload.threadId !== 'string' || !payload.threadId || payload.threadId.length > 200 || !payload.params || payload.params.threadId !== payload.threadId || !Array.isArray(payload.params.input) || !payload.params.input.length) throw Error('Invalid queued message');
        if (Buffer.byteLength(JSON.stringify(payload)) > 256 * 1024) throw Error('Queued message is too large');
        const fingerprint = digest({ threadId: payload.threadId, params: payload.params, text: payload.text, mentions: payload.mentions });
        const previous = state.entries.find(entry => entry.id === payload.id);
        if (previous) { if (previous.fingerprint !== fingerprint) throw conflict(); return { value: copy(previous), changed: false }; }
        if (state.entries.filter(entry => !terminal(entry) && entry.threadId === payload.threadId).length >= 20 || state.entries.filter(entry => !terminal(entry)).length >= 200) throw Error('Queue is full');
        const params = structuredClone(payload.params);
        if (resolveCwd && params.cwd) params.cwd = resolveCwd(params.cwd);
        const entry = { id: payload.id, threadId: payload.threadId, params, text: String(payload.text || ''), mentions: Array.isArray(payload.mentions) ? structuredClone(payload.mentions) : [], status: payload.paused === true ? 'paused' : 'queued', owner, version: 1, fingerprint, createdAt: Date.now(), updatedAt: Date.now() };
        state.entries.push(entry); threadId = entry.threadId; return { value: copy(entry) };
      }
      const entry = state.entries.find(item => item.id === payload.id);
      if (!entry || entry.version !== payload.version || terminal(entry) || (entry.claim && !['cancel','pause'].includes(action)) || ['sending', 'unknown'].includes(entry.status)) throw conflict();
      threadId = entry.threadId;
      if (['resume', 'sendNow', 'reorder'].includes(action) && threadBlocked(state, entry.threadId, receipts, entry.id)) throw blocked();
      if (action === 'cancel') { entry.status = 'cancelled'; delete entry.claim; }
      if (action === 'pause') { entry.status = 'paused'; delete entry.claim; }
      if (action === 'resume' || action === 'sendNow') {
        // A rejected journal identity cannot be reused as a new submission.
        if (entry.submissionStatus) throw Error('Create a new message after a rejected submission.');
        entry.status = 'queued'; entry.owner = owner; delete entry.error; delete entry.requiresResume; entry.sendNow = action === 'sendNow';
        if (entry.sendNow) { state.entries = state.entries.filter(item => item !== entry); const first = state.entries.findIndex(item => item.threadId === entry.threadId && !terminal(item)); state.entries.splice(first < 0 ? state.entries.length : first, 0, entry); }
      }
      if (action === 'edit') {
        if (typeof payload.text !== 'string' || !payload.text.trim() || Buffer.byteLength(payload.text) > 128 * 1024 || entry.submissionStatus) throw Error('Invalid queued message edit');
        const old = entry.text.trim(), first = entry.params.input.find(item => item.type === 'text');
        if (!first || (old && !first.text.startsWith(old))) throw Error('This message cannot be edited safely');
        first.text = payload.text.trim() + first.text.slice(old.length); entry.text = payload.text;
      }
      if (action === 'reorder') {
        if (![-1, 1].includes(payload.direction)) throw Error('Invalid queue order');
        const same = state.entries.filter(item => item.threadId === entry.threadId && !terminal(item)), index = same.indexOf(entry), other = same[index + payload.direction];
        if (!other || other.claim || ['sending', 'unknown'].includes(other.status)) throw conflict();
        const a = state.entries.indexOf(entry), b = state.entries.indexOf(other); [state.entries[a], state.entries[b]] = [state.entries[b], state.entries[a]]; other.version++;
      }
      entry.version++; entry.updatedAt = Date.now(); return { value: copy(entry) };
    });
    changed(threadId); void tick().catch(() => {}); return publicEntry(result);
  }
  async function pauseOwned() {
    await store.transaction(state => {
      let dirty = false;
      for (const entry of state.entries) if (!terminal(entry) && entry.owner?.instance === owner.instance && entry.status !== 'paused' && entry.status !== 'unknown') {
        entry.status = entry.status === 'sending' ? 'unknown' : 'paused'; entry.version++; delete entry.claim; dirty = true;
      }
      return { changed: dirty };
    });
    changed();
  }
  return {
    list, mutate,
    async protectedAttachmentIds() {
      const state = await store.read(), ids = new Set();
      for (const entry of state.entries.filter(entry => !terminal(entry))) {
        for (const item of entry.mentions || []) if (item.source === 'attachment') ids.add(item.id);
        for (const input of entry.params?.input || []) {
          if (input.type !== 'localImage' || typeof input.path !== 'string') continue;
          const child = relative(join(privateRoot, 'remote-web-attachments'), resolve(input.path)), parts = child.split('/');
          if (!child.startsWith('..') && parts.length === 2 && identity(parts[0])) ids.add(parts[0]);
        }
      }
      return ids;
    },
    async notification(message) {
      if (message.method !== 'turn/completed') return;
      const p = message.params || {};
      if (p.turn?.status !== 'completed') await store.transaction(state => { let dirty = false; for (const entry of state.entries) if (entry.threadId === p.threadId && entry.waitTurnId === p.turn?.id && entry.status === 'waiting') { entry.status = 'paused'; entry.version++; dirty = true; } return { changed: dirty }; });
      changed(p.threadId); void tick().catch(() => {});
    },
    disconnected: pauseOwned,
    async start() { if (timer) return; stopped = false; await store.transaction(state => ({ changed: recover(state) })); timer = setInterval(() => void tick().catch(() => {}), pollMs); timer.unref?.(); void tick().catch(() => {}); },
    async stop() { stopped = true; clearInterval(timer); timer = null; await pauseOwned(); }
  };
}
