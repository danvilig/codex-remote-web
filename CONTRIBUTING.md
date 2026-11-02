# Contributing to Codex Remote Web

Changes should reflect real Codex App Server state. Do not simulate completed operations, installed resources, or permissions in the browser. See [development](DEVELOPMENT.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

Use Bun 1.4.4 and Node.js 24.22.2, install with `bun install --frozen-lockfile`, and run `bun run dev` in your checkout. This project has not configured its own public remote yet; use the actual repository address once published. The reference project named in README is historical source attribution, not this project's contribution destination or product dependency.

Keep changes focused and preserve existing HTTP interfaces and browser preferences unless a migration is documented. Confirm native methods against the supported App Server protocol. Keep shared code independent of DOM, and keep server authentication and capability checks authoritative.

For each change run `bun run check`, `bun run test:unit`, and `git diff --check`. Browser changes require the relevant isolated browser suite; authentication changes also require `bun run test:access`. Release/build changes require `bun run test:release`. CI must not call paid models or use personal Codex credentials.

Use screenshots and observable interactions as UI references. Do not extract or redistribute proprietary application resources. README captures must use isolated synthetic data; regenerate them with `bun scripts/capture-docs.ts` and review every image before committing. Only the six documented image paths may enter public artifacts. New third-party code or assets require provenance, compatible licensing, and an update to `THIRD_PARTY_NOTICES.md`. Respect reduced motion, keyboard navigation, and phone layouts.

Never include credentials, private prompts, account data, screenshots of personal sessions, or unredacted logs in a commit or issue. Security reports follow [SECURITY.md](SECURITY.md). Do not send reports to the reference project's maintainer for changes made by this independent project.
