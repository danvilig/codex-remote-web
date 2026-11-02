export function runtimeCapabilities(env = process.env) {
  return {
    terminal: env.CODEX_WEBUI_ENABLE_TERMINAL === "true",
    reviewWrite: env.CODEX_WEBUI_ENABLE_REVIEW_WRITE === "true",
  };
}
