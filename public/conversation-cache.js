const PREVIEW_TURNS = 20;
const CACHE_ENTRY_SIZE = 512 * 1024;
const FRESH_MS = 30_000;

export function mergeConversationTurn(snapshot, live) {
  if (!snapshot || !live) return snapshot || live;
  const completed = snapshot.status !== 'inProgress';
  const items = new Map((snapshot.items || []).map(item => [item.id, item]));
  for (const item of live.items || []) {
    if (item.phase === 'context_summary') {
      const match = [...items.values()].find(candidate => candidate.type === 'agentMessage' &&
        (candidate.id === item.id || candidate.text === item.text));
      if (match) items.set(match.id, { ...match, phase: item.phase });
      else items.set(item.id, item);
      continue;
    }
    const current = items.get(item.id);
    if (!current) {
      if (!completed || !['final_answer', 'commentary'].includes(item.phase)) items.set(item.id, item);
      continue;
    }
    if (completed || current.status === 'completed' || current.phase === 'context_summary') continue;
    const incoming = typeof current.text === 'string' ? current.text : '';
    if (item.type === 'agentMessage' && typeof item.text === 'string' &&
        (live.status !== 'inProgress' || item.status === 'completed' || item.text.startsWith(incoming))) {
      items.set(item.id, { ...current, ...item });
    } else if (item.type !== 'agentMessage') {
      items.set(item.id, { ...item, ...current });
    }
  }
  return { ...live, ...snapshot, status: completed ? snapshot.status : live.status, items: [...items.values()] };
}

// Tab-local snapshots and incremental updates. Drafts and actionable requests
// remain outside the cache. Limits are in UTF-16 code units.
export function createConversationCache({ maxEntries = 24, maxSize = 8 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let pins = new Set();
  let size = 0;

  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return;
    size -= entry.size;
    entries.delete(id);
  }

  function touch(id, entry) {
    entries.delete(id);
    entries.set(id, entry);
  }

  function trim(protectedId) {
    while (entries.size > maxEntries || size > maxSize) {
      const ids = [...entries.keys()];
      remove(ids.find(id => id !== protectedId && !pins.has(id)) ??
        ids.find(id => id !== protectedId) ?? protectedId);
    }
  }

  function ensure(id) {
    const previous = entries.get(id);
    if (previous) return previous;
    const entry = { history: null, complete: false, readAt: 0, live: new Map(), size: 0 };
    entries.set(id, entry);
    return entry;
  }

  function overlay(thread, entry) {
    if (!entry?.live.size) return thread;
    const turns = (thread.turns || []).slice();
    for (const { turn } of entry.live.values()) {
      const index = turns.findIndex(candidate => candidate.id === turn.id);
      if (index < 0) turns.push(turn);
      else turns[index] = mergeConversationTurn(turns[index], turn);
    }
    return { ...thread, turns };
  }

  function saveTurn(id, entry, turn, nextSize, fromEvents = false) {
    if (nextSize > CACHE_ENTRY_SIZE) return false;
    const oldSize = entry.live.get(turn.id)?.size || 0;
    entry.live.set(turn.id, { turn, size: nextSize, fromEvents });
    entry.size += nextSize - oldSize;
    size += nextSize - oldSize;
    while (entry.live.size > 4) {
      const first = entry.live.keys().next().value;
      const bytes = entry.live.get(first).size;
      entry.live.delete(first);
      entry.size -= bytes;
      size -= bytes;
    }
    touch(id, entry);
    trim(id);
    return true;
  }

  return {
    get(id) {
      const entry = entries.get(id);
      if (!entry || (!entry.history && !entry.live.size)) return null;
      touch(id, entry);
      const thread = overlay(entry.history || { id, turns: [] }, entry);
      return {
        thread: { ...thread, turns: thread.turns.slice() },
        fresh: entry.complete && Date.now() - entry.readAt < FRESH_MS,
      };
    },
    isWarm(id) { return !!entries.get(id)?.readAt; },
    isRecent(id) { return Date.now() - (entries.get(id)?.readAt || 0) < FRESH_MS; },
    summary(id) {
      const history = entries.get(id)?.history;
      if (!history) return null;
      const { turns, ...summary } = history;
      return summary;
    },
    setPins(ids) { pins = new Set(ids); },
    set(thread) {
      const entry = ensure(thread.id);
      const json = conversationCacheSnapshot(thread);
      if (json) {
        const history = JSON.parse(json);
        size += json.length - (entry.historySize || 0);
        entry.size += json.length - (entry.historySize || 0);
        entry.historySize = json.length;
        entry.history = history;
        entry.complete = history.turns.length === thread.turns.length;
      } else entry.complete = false;
      entry.readAt = Date.now();
      touch(thread.id, entry);
      trim(thread.id);
    },
    merge(thread) { return overlay(thread, entries.get(thread.id)); },
    rememberTurn(id, turn) {
      const entry = ensure(id);
      const existing = entry.live.get(turn.id);
      const merged = mergeConversationTurn(turn, existing?.turn);
      const newSummary = turn.items?.some(item => item.phase === 'context_summary' &&
        !existing?.turn.items.some(previous => previous.id === item.id && previous.phase === item.phase));
      // Keep the event accumulator when a polling snapshot may already include
      // deltas that are still in flight on the notification channel.
      if (!existing?.fromEvents || turn.status !== 'inProgress' || newSummary) {
        saveTurn(id, entry, merged, JSON.stringify(merged).length, existing?.fromEvents);
      }
      return merged;
    },
    track(threadId, method, params) {
      const explicit = params.turn, item = params.item;
      const turnId = explicit?.id || params.turnId;
      const messageDelta = method === 'item/agentMessage/delta' && typeof params.delta === 'string';
      if (!turnId || !(method === 'turn/started' || method === 'turn/completed' ||
          method === 'item/started' || method === 'item/completed' || messageDelta)) return null;
      const entry = ensure(threadId);
      const existing = entry.live.get(turnId);
      const baseline = entry.history?.turns.find(turn => turn.id === turnId);
      if (baseline && baseline.status !== 'inProgress' && !existing) return null;
      const previous = existing?.turn || baseline || { id: turnId, status: 'inProgress', items: [] };
      if (previous.status !== 'inProgress') return null;
      let updated;
      let next;
      if (explicit) {
        const status = explicit.status || (method === 'turn/completed' ? 'completed' : 'inProgress');
        next = { ...previous, ...explicit, status, items: previous.items.slice() };
        for (const item of explicit.items || []) {
          const index = next.items.findIndex(old => old.id === item.id);
          if (index < 0) next.items.push(item);
          else if (status !== 'inProgress' || item.text || !next.items[index].text) next.items[index] = item;
        }
      } else {
        const itemId = item?.id || params.itemId;
        if (!itemId) return null;
        const index = previous.items.findIndex(candidate => candidate.id === itemId);
        const old = previous.items[index];
        if (messageDelta) {
          if (old?.status === 'completed') return old;
          updated = { ...old, id: itemId, type: 'agentMessage', phase: params.phase || old?.phase, text: (old?.text || '') + params.delta };
        } else {
          if (!item || (method === 'item/started' && old)) return old;
          updated = { ...old, ...item, status: method === 'item/completed' ? item.status || 'completed' : 'inProgress' };
        }
        const items = previous.items.slice();
        if (index < 0) items.push(updated);
        else items[index] = updated;
        next = { ...previous, items };
      }
      const oldSize = existing?.size || 0;
      // Charge only the added text for a delta, with one initial estimate for the turn.
      const nextSize = messageDelta && existing ? oldSize + params.delta.length + (previous.items.length === next.items.length ? 0 : 128)
        : JSON.stringify(next).length;
      return saveTurn(threadId, entry, next, nextSize, true) ? updated : null;
    },
    remove,
    clear() { entries.clear(); size = 0; },
  };
}

export function conversationCacheSnapshot(thread, limit = PREVIEW_TURNS, maxSize = CACHE_ENTRY_SIZE) {
  const turns = thread.turns;
  if (!Array.isArray(turns)) return null;
  const { id, name, preview, cwd, source, projectless, status, ephemeral, updatedAt, recencyAt, createdAt, historyCursor } = thread;
  const metadata = JSON.stringify({ id, name, preview, cwd, source, projectless, status, ephemeral, updatedAt, recencyAt, createdAt, historyCursor });
  let size = metadata.length + 32;
  const tail = [];
  for (let i = turns.length - 1; i >= Math.max(0, turns.length - limit); i--) {
    const turn = JSON.stringify(turns[i]);
    if (size + turn.length + 1 > maxSize) break;
    size += turn.length + 1;
    tail.unshift(turn);
  }
  if (!tail.length && turns.length) return null;
  return `${metadata.slice(0, -1)},"turns":[${tail.join(',')}]}`;
}
