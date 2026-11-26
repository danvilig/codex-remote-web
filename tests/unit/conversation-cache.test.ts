import { expect, test } from "bun:test";
import { createConversationCache } from "../../public/conversation-cache.js";

const message = (text: string) => ({ id: "answer", type: "agentMessage", phase: "final_answer", text });
const turn = (text: string, status = "inProgress") => ({ id: "turn-1", status, items: [message(text)] });
const thread = (id: string, turns = [turn("First")]) => ({ id, turns });

test("merges streamed text with an older read and accepts a completed answer", () => {
  const cache = createConversationCache();
  cache.set(thread("a"));
  cache.track("a", "item/agentMessage/delta", { turnId: "turn-1", itemId: "answer", delta: " second" });
  cache.set(thread("a"));
  expect(cache.get("a").thread.turns).toMatchObject([turn("First second")]);

  cache.track("a", "item/completed", { turnId: "turn-1", item: message("First second.") });
  cache.track("a", "turn/completed", { turn: { id: "turn-1", status: "completed", items: [] } });
  expect(cache.merge(thread("a")).turns).toMatchObject([turn("First second.", "completed")]);
  expect(cache.rememberTurn("a", turn("Canonical answer", "completed"))).toMatchObject(turn("Canonical answer", "completed"));
  expect(cache.get("a").thread.turns).toMatchObject([turn("Canonical answer", "completed")]);
});

test("prefers retaining pinned entries and clears stream updates with history", () => {
  const cache = createConversationCache({ maxEntries: 2 });
  cache.setPins(["pinned"]);
  cache.set(thread("pinned"));
  cache.set(thread("recent"));
  cache.set(thread("new"));
  expect(cache.get("recent")).toBeNull();
  expect(cache.isRecent("pinned")).toBe(true);
  cache.track("pinned", "item/agentMessage/delta", { turnId: "turn-1", itemId: "answer", delta: " cached" });
  expect(cache.get("pinned").thread.turns[0].items[0].text).toBe("First cached");
  cache.clear();
  expect(cache.get("pinned")).toBeNull();
  expect(cache.get("new")).toBeNull();
});

test("retains progress from repeated polls when a thread has no delta notifications", () => {
  const cache = createConversationCache();
  cache.set(thread("a"));
  cache.rememberTurn("a", turn("First poll"));
  cache.rememberTurn("a", turn("First poll followed by more output"));
  expect(cache.get("a").thread.turns).toMatchObject([turn("First poll followed by more output")]);
});
