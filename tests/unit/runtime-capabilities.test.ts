import { expect, test } from "bun:test";
import { runtimeCapabilities } from "../../src/server/config/capabilities.js";

test("direct terminal and review writes require explicit server opt-in", () => {
  expect(runtimeCapabilities({})).toEqual({ terminal: false, reviewWrite: false });
  expect(runtimeCapabilities({ CODEX_WEBUI_ENABLE_TERMINAL: "1", CODEX_WEBUI_ENABLE_REVIEW_WRITE: "false" })).toEqual({ terminal: false, reviewWrite: false });
  expect(runtimeCapabilities({ CODEX_WEBUI_ENABLE_TERMINAL: "true", CODEX_WEBUI_ENABLE_REVIEW_WRITE: "true" })).toEqual({ terminal: true, reviewWrite: true });
});
