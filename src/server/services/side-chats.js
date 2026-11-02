// Page-owned, memory-only native branches. No transcript or page key is persisted.
export function createSideChatService({ request, resolveCwd, now = Date.now, ttl = 600_000 }) {
  const sessions = new Map();
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
  const key = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
  const only = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k));
  function get(sessionId) {
    const session = sessions.get(sessionId);
    if (!key(sessionId) || !session || session.closed || !session.thread) throw Error('Side chat expired');
    if(now()-session.seen>ttl){void release(sessionId);throw Error('Side chat expired');}
    session.seen = now(); return session;
  }
  const state = session => ({ thread: session.thread, turns: [...session.turns.values()], activeTurnId: [...session.turns.values()].find(t => t.status === 'inProgress')?.id || '', overflow: session.overflow });
  function record(session, turn) {
    if (!validId(turn?.id)) return;
    const old = session.turns.get(turn.id), next = { ...old, ...turn, items: turn.items?.length ? turn.items : old?.items || [] };
    const bytes = JSON.stringify(next).length, previous = old ? JSON.stringify(old).length : 0;
    if (session.bytes + bytes - previous > 8 * 1024 * 1024 || (!old && session.turns.size >= 200)) { session.overflow = true; if(old)old.status = next.status; return; }
    session.bytes += bytes - previous; session.turns.set(turn.id, next);
  }
  function notify(message) {
    const p = message.params || {};
    const session = [...sessions.values()].find(s => s.thread?.id === p.threadId);
    if (!session) return;
    if (message.method === 'thread/closed') { session.closed = true; return; }
    if (message.method === 'turn/started' || message.method === 'turn/completed') { record(session, p.turn); return; }
    if (!p.turnId || !p.itemId && !p.item?.id) return;
    const turn = session.turns.get(p.turnId) || { id: p.turnId, status: 'inProgress', items: [] };
    if (['item/started', 'item/completed'].includes(message.method)) {
      const items = turn.items.filter(item => item.id !== p.item.id && !(p.item.type === 'userMessage' && item.id.startsWith('side-input:')));
      items.push(p.item); record(session, { ...turn, items });
    } else if (message.method === 'item/agentMessage/delta') {
      const item = turn.items.find(item => item.id === p.itemId) || { id: p.itemId, type: 'agentMessage', phase: 'final_answer', text: '' };
      record(session, { ...turn, items: [...turn.items.filter(i => i.id !== p.itemId), { ...item, text: (item.text || '') + (p.delta || '') }] });
    }
  }
  function observeTurn(params, result) {
    const session = [...sessions.values()].find(s => s.thread?.id === params.threadId);
    if (!session || !result.turn?.id) return;
    const previous = session.turns.get(result.turn.id);
    record(session, { ...result.turn, status: previous?.status || result.turn.status, items: previous?.items?.some(i => i.type === 'userMessage') ? previous.items : [{ id: `side-input:${result.turn.id}`, type: 'userMessage', content: params.input }, ...(previous?.items || [])] });
    session.model = params.model; session.effort = params.effort;
  }
  async function startTurn(params,execute) {
    const session=[...sessions.values()].find(s=>s.thread?.id===params.threadId);
    if(!session)return execute();
    if(session.closed||now()-session.seen>ttl||session.submitting||[...session.turns.values()].some(t=>t.status==='inProgress'))throw Error('Side chat is unavailable or busy');
    const pending=(async()=>{const result=await execute();observeTurn(params,result);return result;})();
    session.submitting=pending;
    try{return await pending;}finally{if(session.submitting===pending)session.submitting=null;}
  }
  async function create(payload) {
    if (!only(payload, ['action', 'sessionId', 'sourceThreadId', 'cwd']) || !key(payload.sessionId) || payload.sourceThreadId != null && !validId(payload.sourceThreadId)) throw Error('Invalid side chat');
    const existing = sessions.get(payload.sessionId);
    if (existing) { if(existing.closed)throw Error('Side chat expired'); await existing.creating; return state(existing); }
    if (sessions.size >= 32) throw Error('Too many side chats');
    const session = { seen: now(), turns: new Map(), bytes: 0, overflow: false, closed: false, thread: null };
    sessions.set(payload.sessionId, session);
    session.creating = (async () => {
      let result;
      if (payload.sourceThreadId) {
        const source = (await request('thread/read', { threadId: payload.sourceThreadId, includeTurns: false })).thread;
        resolveCwd(source.cwd);
        const history = await request('thread/turns/list', { threadId: source.id, limit: 2, sortDirection: 'desc', itemsView: 'full' });
        const completed = history.data?.find(turn => turn.status !== 'inProgress');
        session.source = { threadId: source.id, ...(completed ? { lastTurnId: completed.id } : {}) };
        // Fork a stable prefix when the main chat is running. Empty source chats
        // can still be forked natively; they have no persistent turn boundary.
        session.hasSourceHistory = Boolean(completed);
        session.sourceItems = completed ? [] : exportItems([...(history.data || [])].reverse());
        if(JSON.stringify(session.sourceItems).length>8*1024*1024){session.sourceItems=[];session.overflow=true;}
        result = await request('thread/fork', { ...session.source, ephemeral: true, excludeTurns: true });
      } else result = await request('thread/start', { cwd: resolveCwd(payload.cwd), ephemeral: true });
      if (!result.thread?.id || result.thread.ephemeral !== true) throw Error('Native temporary chats are unavailable');
      session.thread = result.thread;
      if (session.closed) await cleanup(session);
    })();
    try { await session.creating; if(session.closed)throw Error('Side chat closed'); return state(session); }
    catch (error) { sessions.delete(payload.sessionId); throw error; }
  }
  async function cleanup(session) {
    if (!session.thread) return;
    const active = [...session.turns.values()].find(t => t.status === 'inProgress');
    if (active) await request('turn/interrupt', { threadId: session.thread.id, turnId: active.id }).catch(() => {});
    await request('thread/unsubscribe', { threadId: session.thread.id }).catch(() => {});
  }
  async function release(sessionId) {
    if (!key(sessionId)) throw Error('Invalid side chat');
    const session = sessions.get(sessionId);
    if (!session) return { released: true };
    session.closed = true;
    await session.submitting?.catch(()=>{});
    if (session.thread) await cleanup(session);
    if(sessions.get(sessionId)===session)sessions.delete(sessionId);
    return { released: true };
  }
  function exportItems(turns) {
    const items = [];
    for (const turn of turns) for (const item of turn.items || []) {
      let role = 'user', text = '';
      if (item.type === 'userMessage') {
        text = (item.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
        const content = [{ type: 'input_text', text: text || 'Attached image' }, ...(item.content || []).filter(p => p.type === 'localImage').map(p => ({ type: 'input_text', text: `Attached image file: ${p.path}` }))];
        items.push({ type: 'message', role, content }); continue;
      }
      if (item.type === 'agentMessage') { role = 'assistant'; text = item.text || (item.content || []).map(p => p.text || '').join('\n'); }
      else text = `[Side chat tool record: ${item.type}]\n${JSON.stringify(item)}`;
      if (text) items.push({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
    }
    return items;
  }
  async function promote(session, turnId) {
    if (session.promoting) return session.promoting;
    if (!turnId && session.promoted) return { thread: session.promoted };
    if (session.overflow || [...session.turns.values()].some(t => t.status === 'inProgress')) throw Error('Stop the side chat before saving');
    const turns = [...session.turns.values()];
    const index = turnId ? turns.findIndex(t => t.id === turnId) : turns.length - 1;
    if (index < 0) throw Error('Nothing to save');
    // Native ephemeral threads cannot be resumed or forked to disk. Create a
    // persistent native prefix, then inject visible side messages/tool records.
    // Injection appends context only; it never executes or replays tools.
    session.promoting = (async () => {
      if (!session.saveTarget) {
        const result = session.source && session.hasSourceHistory
          ? await request('thread/fork', { ...session.source, ephemeral: false, excludeTurns: true })
          : await request('thread/start', { cwd: session.thread.cwd, ephemeral: false });
        session.saveTarget = result.thread;
      }
      if (session.saveUncertain) throw Error('Previous save needs manual review');
      const items = [...(session.sourceItems || []),...exportItems(turns.slice(0, index + 1))];
      session.saveUncertain = true;
      await request('thread/inject_items', { threadId: session.saveTarget.id, items });
      session.promoted = session.saveTarget;
      return { thread: session.promoted };
    })();
    try { return await session.promoting; } finally { session.promoting = null; }
  }
  async function handle(payload) {
    if (!only(payload, ['action', 'sessionId', 'sourceThreadId', 'cwd', 'turnId'])) throw Error('Invalid side chat action');
    if (payload.action === 'create') return create(payload);
    if (!only(payload, ['action', 'sessionId', ...(payload.action === 'promote' ? ['turnId'] : [])])) throw Error('Invalid side chat action');
    if (payload.action === 'release') return release(payload.sessionId);
    const session = get(payload.sessionId);
    if (payload.action === 'snapshot') return state(session);
    if (payload.action === 'promote' && (payload.turnId == null || validId(payload.turnId))) return promote(session, payload.turnId);
    throw Error('Invalid side chat action');
  }
  const timer = setInterval(() => { for (const [id, s] of sessions) if (now() - s.seen > ttl) void release(id); }, 30_000); timer.unref?.();
  return { handle, notify, observeTurn, startTurn, owns(threadId) { return [...sessions.values()].some(session => session.thread?.id === threadId); }, clear() { sessions.clear(); }, async stop() { clearInterval(timer); await Promise.allSettled([...sessions.keys()].map(release)); } };
}
