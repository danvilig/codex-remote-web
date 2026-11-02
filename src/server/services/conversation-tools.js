// Only explicit user actions reach native conversation mutations. No execution
// retries, arbitrary native config, or client-provided skill paths are accepted.
export function createConversationTools(request) {
  const id = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 512;
  const keys = (payload, allowed) =>
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload).every((key) => allowed.includes(key));
  async function fork(payload) {
    if (
      !keys(payload, ["threadId", "turnId"]) ||
      !id(payload.threadId) ||
      (payload.turnId != null && !id(payload.turnId))
    )
      throw new Error("Invalid fork");
    // lastTurnId is native and inclusive: do not copy later turns then roll back.
    const result = await request("thread/fork", {
      threadId: payload.threadId,
      ...(payload.turnId ? { lastTurnId: payload.turnId } : {}),
      ephemeral: false,
    });
    if (!result?.thread?.id || result.thread.id === payload.threadId)
      throw new Error("Fork unavailable");
    return { thread: result.thread };
  }
  async function goal(payload) {
    if (
      !keys(payload, ["threadId", "action", "objective", "tokenBudget"]) ||
      !id(payload.threadId)
    )
      throw new Error("Invalid goal");
    const { threadId, action } = payload;
    if (action === "get") return request("thread/goal/get", { threadId });
    if (action === "clear")
      return request("thread/goal/clear", { threadId, origin: "user" });
    if (action === "pause" || action === "resume")
      return request("thread/goal/set", {
        threadId,
        status: action === "pause" ? "paused" : "active",
        origin: "user",
      });
    if (
      action !== "set" ||
      typeof payload.objective !== "string" ||
      !payload.objective.trim() ||
      payload.objective.length > 16000
    )
      throw new Error("Invalid objective");
    if (
      payload.tokenBudget != null &&
      (!Number.isSafeInteger(payload.tokenBudget) ||
        payload.tokenBudget < 1 ||
        payload.tokenBudget > 1_000_000_000)
    )
      throw new Error("Invalid budget");
    return request("thread/goal/set", {
      threadId,
      objective: payload.objective.trim(),
      origin: "user",
      ...(payload.tokenBudget != null
        ? { tokenBudget: payload.tokenBudget }
        : {}),
    });
  }
  return { fork, goal };
}
