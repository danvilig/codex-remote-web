export function isForeignConversationEvent(method, params, activeThreadId) {
  return (method.startsWith("item/") || method.startsWith("turn/"))
    && typeof params.threadId === "string"
    && params.threadId !== activeThreadId;
}

export function collaborationMode(planMode, model, effort) {
  return {
    mode: planMode ? "plan" : "default",
    settings: { model, reasoning_effort: effort || null, developer_instructions: null },
  };
}

export function notificationApi(scope = globalThis) {
  return typeof scope.Notification === "function" ? scope.Notification : null;
}
