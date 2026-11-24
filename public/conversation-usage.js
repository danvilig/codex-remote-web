const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Standard text prices in USD per million tokens.
// https://developers.openai.com/api/docs/pricing
const standardPrices = new Map([
  ['gpt-6.2-sol', { input: 2, cached: 0.1, output: 10, write: [2.5, 5], long: 272000 }],
  ['gpt-6.2-astra', { input: 8, cached: 0.4, output: 40, write: [10, 20], long: 272000 }],
  ['gpt-5.5', { input: 5, cached: 0.5, output: 30, long: 272000 }],
  ['gpt-5.3-codex', { input: 1.75, cached: 0.175, output: 14 }],
]);

export function cacheHitRate(usage) {
  const input = tokenCount(usage?.total?.inputTokens);
  const cached = tokenCount(usage?.total?.cachedInputTokens);
  return input && cached !== null && cached <= input ? cached / input : null;
}

function billableTokens(usage) {
  const input = tokenCount(usage?.inputTokens);
  const cached = tokenCount(usage?.cachedInputTokens);
  const output = tokenCount(usage?.outputTokens);
  const write = tokenCount(usage?.cacheWriteInputTokens ?? 0);
  if (input === null || cached === null || output === null || write === null || cached + write > input) return null;
  return { input, cached, output, write };
}

export function estimatedApiCost(turn) {
  const model = turn?.model?.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const price = standardPrices.get(model);
  if (!price || turn.incomplete || turn.rerouted || !turn.requests) return null;
  let low = 0, high = 0;
  for (const [key, tokens] of turn.billable.entries()) {
    if (!tokens) continue;
    if (tokens.write && !price.write) return null;
    const long = key === 1 && price.long !== undefined;
    const inputFactor = long ? 2 : 1;
    const charge = ((tokens.input - tokens.cached - tokens.write) * price.input +
      tokens.cached * price.cached) * inputFactor + tokens.output * price.output * (long ? 1.5 : 1);
    low += (charge + tokens.write * (price.write?.[0] ?? 0) * inputFactor) / 1e6;
    high += (charge + tokens.write * (price.write?.[1] ?? 0) * inputFactor) / 1e6;
  }
  return { low, high };
}

const tokenUnits = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];

export function formatTokenCount(value, format) {
  const unit = tokenUnits.find(([size]) => value >= size);
  if (!unit) return format.format(value);
  const [size, suffix] = unit;
  const step = suffix !== 'k' && value >= size * 100 ? size : size / 10;
  return format.format(Math.floor(value / step) * (step / size)) + suffix;
}

export function contextUsageValue(usage) {
  const usedTokens = tokenCount(usage?.last?.totalTokens);
  const contextWindow = tokenCount(usage?.modelContextWindow);
  if (usedTokens === null || !contextWindow) return null;
  return {
    usedTokens,
    contextWindow,
    percent: Math.min(100, usedTokens / contextWindow * 100),
  };
}

export function createConversationUsage({ now = () => performance.now() } = {}) {
  const conversations = new Map();

  function entry(threadId) {
    let record = conversations.get(threadId);
    if (!record) record = { usage: null, turn: null, rate: null };
    conversations.delete(threadId);
    conversations.set(threadId, record);
    if (conversations.size > 64) conversations.delete(conversations.keys().next().value);
    return record;
  }

  return {
    get(threadId) { return conversations.get(threadId); },
    restore(threadId, usage, previousUsage) {
      if (!usage) return false;
      const record = entry(threadId);
      const currentTotal = tokenCount(record.usage?.total?.totalTokens);
      const restoredTotal = tokenCount(usage.total?.totalTokens);
      if (record.usage !== previousUsage || restoredTotal === null) return false;
      if (currentTotal !== null && (restoredTotal < currentTotal ||
        (restoredTotal === currentTotal && contextUsageValue(record.usage)))) return false;
      record.usage = usage;
      return true;
    },
    start(threadId, turnId, model) {
      if (!threadId || !turnId) return;
      const record = entry(threadId);
      if (record.turn?.id === turnId) return;
      record.turn = {
        id: turnId, model, started: now(), ttft: null, baseline: null, output: null, duration: null,
        nativeTiming: false, billable: [], requests: 0, reportedTotal: tokenCount(record.usage?.total?.totalTokens),
      };
      record.rate = null;
    },
    setModel(threadId, turnId, model) {
      const turn = conversations.get(threadId)?.turn;
      if (turn?.id !== turnId || typeof model !== 'string' || !model || turn.model === model) return false;
      turn.model = model;
      return true;
    },
    reroute(threadId, turnId) {
      const turn = conversations.get(threadId)?.turn;
      if (turn?.id === turnId) turn.rerouted = true;
    },
    firstText(threadId, turnId, delta) {
      const turn = conversations.get(threadId)?.turn;
      if (!turn || turn.id !== turnId || turn.ttft !== null || turn.duration !== null ||
          typeof delta !== 'string' || !delta.trim()) return false;
      turn.ttft = Math.max(0, now() - turn.started);
      return true;
    },
    update(threadId, turnId, usage) {
      if (!threadId || !usage) return;
      const record = entry(threadId);
      const total = tokenCount(usage.total?.totalTokens);
      const previousTotal = tokenCount(record.usage?.total?.totalTokens);
      if (total !== null && previousTotal !== null && total < previousTotal) return;
      record.usage = usage;

      const turn = record.turn;
      if (turn?.id === turnId) {
        const last = tokenCount(usage.last?.totalTokens);
        if (total !== null && (turn.reportedTotal === null || total > turn.reportedTotal)) {
          const tokens = billableTokens(usage.last);
          if (!tokens || last === null || (turn.reportedTotal !== null && total - turn.reportedTotal !== last)) {
            turn.incomplete = true;
          } else {
            const tier = tokens.input > 272000 ? 1 : 0;
            const bucket = turn.billable[tier] ||= { input: 0, cached: 0, output: 0, write: 0 };
            for (const key of Object.keys(bucket)) bucket[key] += tokens[key];
            turn.requests++;
          }
          turn.reportedTotal = total;
        }
      }
      const totalOutput = tokenCount(usage.total?.outputTokens);
      const lastOutput = tokenCount(usage.last?.outputTokens);
      if (!turn || turn.id !== turnId || totalOutput === null || lastOutput === null) return;
      if (turn.baseline === null) {
        if (totalOutput < lastOutput) return;
        turn.baseline = totalOutput - lastOutput;
      }
      const output = totalOutput - turn.baseline;
      if (output < 0 || (turn.output !== null && output <= turn.output)) return;
      turn.output = output;
      const elapsed = turn.duration ?? now() - turn.started;
      record.rate = elapsed >= 1 ? output * 1000 / elapsed : null;
    },
    complete(threadId, turnId, duration) {
      const record = conversations.get(threadId);
      const turn = record?.turn;
      const nativeTiming = Number.isFinite(duration) && duration > 0;
      if (!turn || turn.id !== turnId || turn.nativeTiming || (turn.duration !== null && !nativeTiming)) return false;
      turn.nativeTiming = nativeTiming;
      turn.duration = nativeTiming ? duration : now() - turn.started;
      record.rate = turn.output !== null && turn.duration >= 1 ? turn.output * 1000 / turn.duration : null;
      return true;
    },
  };
}
