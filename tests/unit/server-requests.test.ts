import { describe, expect, test } from "bun:test";
import { ServerRequestStore } from "../../src/server/bridge/server-requests.js";

const request = { id: "question-1", method: "item/tool/requestUserInput", params: { threadId: "thread-1", questions: [{ id: "choice", options: [{ label: "A" }], isOther: false }] } };

describe("pending server requests", () => {
  test("replays pending questions and permits exactly one response", () => {
    const store = new ServerRequestStore(), sent: unknown[] = [];
    store.add(request);
    expect(store.list()).toEqual([request]);
    expect(store.respond(request.id, { answers: { choice: { answers: ["A"] } } }, null, message => sent.push(message))).toEqual({ threadId: "thread-1", requestId: request.id });
    expect(store.list()).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(() => store.respond(request.id, {}, null, () => {})).toThrow("no longer pending");
  });

  test("keeps a request pending when validation or transport fails", () => {
    const store = new ServerRequestStore(); store.add(request);
    expect(() => store.respond(request.id, { answers: { choice: { answers: ["forged"] } } }, null, () => {})).toThrow();
    expect(() => store.respond(request.id, { answers: { choice: { answers: ["A"] } } }, null, () => { throw new Error("closed"); })).toThrow("closed");
    expect(store.list()).toEqual([request]);
    store.remove(request.id); expect(store.list()).toEqual([]);
  });

  test('epoch mode rejects stale approvals even if native reuses its request ID', () => {
    const store = new ServerRequestStore({ requireEpoch: true }), sent: unknown[] = [];
    const old = store.add(request);
    expect(store.list()[0].requestEpoch).toBe(store.epoch);
    expect(() => store.respond(request.id, {}, null, () => {})).toThrow('earlier connection');
    store.clear();
    const current = store.add(request);
    expect(current.requestEpoch).not.toBe(old.requestEpoch);
    expect(() => store.respond(request.id, {}, null, message => sent.push(message), old.requestEpoch)).toThrow('earlier connection');
    expect(sent).toHaveLength(0);
    store.respond(request.id, { answers: { choice: { answers: ['A'] } } }, null, message => sent.push(message), current.requestEpoch);
    expect(sent).toHaveLength(1);
    expect(store.list()).toEqual([]);
  });
});
