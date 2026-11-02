import { validateUserInputAnswers } from "../../shared/user-input.js";
import { randomUUID } from 'node:crypto';

export class ServerRequestStore {
  #pending = new Map();
  #epoch = randomUUID();
  #requireEpoch;

  constructor({ requireEpoch = false } = {}) { this.#requireEpoch = requireEpoch; }
  get epoch() { return this.#epoch; }

  add(request) {
    const entry = this.#requireEpoch ? { ...request, requestEpoch: this.#epoch } : request;
    this.#pending.set(request.id, entry);
    return entry;
  }
  list() { return [...this.#pending.values()]; }
  remove(id) { this.#pending.delete(id); }
  clear() { this.#pending.clear(); this.#epoch = randomUUID(); }

  respond(id, result, error, send, requestEpoch) {
    if (this.#requireEpoch && requestEpoch !== this.#epoch)
      throw Object.assign(new Error('This request belongs to an earlier connection. Refresh pending approvals.'), { code: 'REQUEST_STALE', status: 409 });
    const request = this.#pending.get(id);
    if (!request) throw new Error("This request is no longer pending");
    if (!error && request.method === "item/tool/requestUserInput") validateUserInputAnswers(request, result);
    send(error ? { id, error } : { id, result });
    this.#pending.delete(id);
    return { threadId: request.params?.threadId, requestId: id };
  }
}
