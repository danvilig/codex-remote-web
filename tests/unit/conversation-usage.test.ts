import { expect, test } from "bun:test";
import { cacheHitRate, contextUsageValue, createConversationUsage, estimatedApiCost, formatTokenCount } from "../../public/conversation-usage.js";

test("selects token units without rounding across unit boundaries", () => {
  const format = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
  expect([0, 999, 1000, 352614, 999999, 1200000, 446563396, 2500000000].map(
    value => formatTokenCount(value, format),
  )).toEqual(["0", "999", "1k", "352.6k", "999.9k", "1.2M", "446M", "2.5B"]);
});

function usage(total: number, output: number, lastOutput: number, window: number | null = 200000) {
  return {
    total: { totalTokens: total, outputTokens: output },
    last: { totalTokens: 4000, outputTokens: lastOutput },
    modelContextWindow: window,
  };
}

test("uses native output counts and elapsed turn time for the estimated rate", () => {
  let clock = 100;
  const meter = createConversationUsage({ now: () => clock });
  meter.start("a", "turn");
  clock += 1000;
  meter.update("a", "turn", usage(8000, 980, 100));
  expect(meter.get("a")?.rate).toBe(100);
  clock += 1000;
  meter.update("a", "turn", usage(12000, 1020, 40));
  expect(meter.get("a")?.rate).toBe(70);
  clock += 500;
  meter.complete("a", "turn");
  expect(meter.get("a")?.rate).toBe(56);
  meter.complete("a", "turn", 4000);
  expect(meter.get("a")?.rate).toBe(35);
  meter.start("a", "turn");
  expect(meter.get("a")?.rate).toBe(35);
  meter.start("a", "next");
  expect(meter.get("a")?.rate).toBeNull();
});

test("keeps counts thread-local and ignores a history read overtaken by a notification", () => {
  const meter = createConversationUsage();
  const persisted = usage(5000, 200, 60);
  expect(meter.restore("a", persisted, null)).toBe(true);
  expect(meter.get("a")?.rate).toBeNull();
  const latest = usage(8000, 250, 50);
  meter.update("a", "turn", latest);
  expect(meter.restore("a", persisted, persisted)).toBe(false);
  expect(meter.restore("a", persisted, latest)).toBe(false);
  expect(meter.get("a")?.usage).toBe(latest);
  expect(meter.get("b")).toBeUndefined();
});

test("keeps reported context counts exact and handles unavailable limits", () => {
  expect(contextUsageValue(usage(5000, 200, 60))).toEqual({
    usedTokens: 4000, contextWindow: 200000, percent: 2,
  });
  expect(contextUsageValue(usage(5000, 200, 60, 3000))).toEqual({
    usedTokens: 4000, contextWindow: 3000, percent: 100,
  });
  expect(contextUsageValue(usage(5000, 200, 60, null))).toBeNull();
});

test("measures the first visible text and prices observed requests at their input tier", () => {
  let now = 100;
  const meter = createConversationUsage({ now: () => now });
  meter.start("a", "turn", "gpt-6.2-sol");
  now = 200;
  expect(meter.firstText("a", "turn", " ")).toBe(false);
  expect(meter.firstText("a", "previous", "First")).toBe(false);
  now = 600;
  expect(meter.firstText("a", "turn", "Visible")).toBe(true);
  now = 900;
  expect(meter.firstText("a", "turn", " delta")).toBe(false);
  expect(meter.get("a")?.turn?.ttft).toBe(500);
  const short = { inputTokens: 1000, cachedInputTokens: 500, cacheWriteInputTokens: 100, outputTokens: 100, totalTokens: 1100 };
  const long = { inputTokens: 300000, cachedInputTokens: 200000, outputTokens: 200, totalTokens: 300200 };
  meter.update("a", "turn", { total: short, last: short });
  meter.update("a", "turn", { total: short, last: short });
  meter.update("a", "turn", {
    last: long,
    total: { inputTokens: 301000, cachedInputTokens: 200500, outputTokens: 300, totalTokens: 301300 },
  });
  const record = meter.get("a");
  expect(cacheHitRate(record.usage)).toBe(200500 / 301000);
  expect(estimatedApiCost(record.turn)?.low).toBeCloseTo(0.4451, 8);
  expect(estimatedApiCost(record.turn)?.high).toBeCloseTo(0.44535, 8);
  meter.reroute("a", "turn");
  expect(estimatedApiCost(record.turn)).toBeNull();
});

test("does not estimate an unknown model or a turn with incomplete reporting", () => {
  const meter = createConversationUsage();
  const last = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 5, totalTokens: 105 };
  expect(cacheHitRate({ total: last })).toBe(0);
  expect(cacheHitRate({ total: { inputTokens: 100 } })).toBeNull();
  meter.start("a", "turn", "unlisted-model");
  meter.update("a", "turn", { total: last, last });
  expect(estimatedApiCost(meter.get("a")?.turn)).toBeNull();
  meter.setModel("a", "turn", "gpt-6.2-sol");
  expect(estimatedApiCost(meter.get("a")?.turn)?.low).toBeCloseTo(0.00025, 8);
  meter.update("a", "turn", { total: { ...last, totalTokens: 315 }, last });
  expect(estimatedApiCost(meter.get("a")?.turn)).toBeNull();
});
