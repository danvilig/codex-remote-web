import { describe, expect, test } from "bun:test";
import { collaborationMode, isForeignConversationEvent, notificationApi } from "../../public/conversation-policy.js";

describe("conversation protocol boundaries", () => {
  test("keeps other-thread item and turn events out of the current conversation", () => {
    for (const method of ["item/started", "item/agentMessage/delta", "turn/completed"]) {
      expect(isForeignConversationEvent(method, { threadId: "B" }, "A")).toBe(true);
      expect(isForeignConversationEvent(method, { threadId: "A" }, "A")).toBe(false);
      expect(isForeignConversationEvent(method, { threadId: "B" }, null)).toBe(true);
    }
    expect(isForeignConversationEvent("thread/status/changed", { threadId: "B" }, "A")).toBe(false);
  });

  test("sends native plan mode settings and explicitly resets to default mode", () => {
    expect(collaborationMode(true, "test-model", "high")).toEqual({ mode: "plan", settings: { model: "test-model", reasoning_effort: "high", developer_instructions: null } });
    expect(collaborationMode(false, "test-model", "low").mode).toBe("default");
  });

  test("allows the app to work without optional browser notifications", () => {
    expect(notificationApi({})).toBeNull();
    expect(notificationApi({ Notification: undefined })).toBeNull();
    const Notification = function () {};
    expect(notificationApi({ Notification })).toBe(Notification);
  });
});
