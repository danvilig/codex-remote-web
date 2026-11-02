# Contributing to Codex Remote Web

Use [this project's repository](https://github.com/danvilig/codex-remote-web), not the historical reference project. Read the [Git workflow](docs/GIT_WORKFLOW.md), [development guide](DEVELOPMENT.md), [agent rules](AGENTS.md) and [Code of Conduct](CODE_OF_CONDUCT.md).

## Branch and PR workflow

Start a short-lived branch from `develop`, normally `codex/<topic>` for AI-assisted work. Submit a focused PR into `develop`; never push directly to protected `main`, `develop` or `release/*`. Release branches exist only when preparing a version. Use a conventional title such as `fix(files): preserve source encoding` and complete every section of the [PR template](.github/pull_request_template.md).

All PRs require `verify` and `pr-policy`, an up-to-date target and resolved conversations. The project has one maintainer, so another person's approval is not mandatory; the maintainer still reviews and merges manually. Agents do not merge, publish or bypass rules without explicit human authorization. See the workflow for squash vs integration merge and back-merges.

The public history started with a clean independent snapshot and now continues normally. Do not attach private early history, mirror private refs or regenerate the public initial commit. In the historical private checkout, transfer reviewed file changes to a branch descending from public `develop`; never push that checkout's history.

## Scope and evidence

Keep changes focused and preserve HTTP interfaces, browser storage keys and data unless a migration is documented. Describe the concrete problem, resulting behavior, App Server methods/notifications, compatibility and rollback. Do not simulate completed operations or capabilities; confirm methods against the supported native protocol. Shared code stays independent of DOM; authentication, capabilities, Origin, filesystem and execution checks remain authoritative on the server.

Disclose AI tools (or explicitly none), contribution scope, contributor review and remaining uncertainty. Do not invent human review or test results. Authors are responsible for all submitted code, including generated code. Machine checks establish structure, not truth or correctness. Flag CI/policy, authentication, filesystem writes, execution, dependency and release changes for maintainer attention.

## Verification

Use the pinned Bun/Node versions and `bun install --frozen-lockfile`. Run `bun run check`, `bun run test:unit` and `git diff --check`. Report exact commands/results, plus skipped checks and reasons. UI changes need relevant browser tests; authentication changes need `bun run test:access`; packaging changes need `bun run test:release` and `bun run test:portable`. Reliability fixes need a reproducer and a regression. The full offline gate is `bun run verify:release` on a clean checkout; wait for the final CI conclusion.

Default tests use disposable directories, simulated App Server/Cloudflare and local test keys. Do not invoke paid models, use personal credentials or mutate real services/Cloudflare resources in CI. Live tests need separate task authorization and an explicit description of effects. Never weaken checks or add broad ignores just to pass CI.

## UI, licensing and privacy

UI changes need synthetic before/after screenshots for relevant desktop/tablet/mobile layouts. Respect keyboard access, localization, themes and reduced motion. Do not extract proprietary assets. README captures use isolated synthetic data; only the reviewed image allowlist enters artifacts. Add provenance and compatible licensing for third-party code/assets and update THIRD_PARTY_NOTICES.md.

Never commit credentials, private prompts, account data, personal paths, unredacted logs or screenshots of personal sessions. Report vulnerabilities privately using [SECURITY.md](SECURITY.md), not public PRs or the reference project's tracker.

## 中文

先阅读 [Git 开发流程](docs/GIT_WORKFLOW.md) 和根目录 [AGENTS.md](AGENTS.md)。从 `develop` 创建短分支，通过完整模板的 PR 提交；禁止直推受保护分支。AI 辅助开发必须如实说明工具、参与范围、实际检查、未验证项及风险，不得伪造人工审核或“测试已通过”。所有 PR 通过 Verify、PR 规范检查并解决讨论后，由维护者人工审核、选择合并方式；agent 不得擅自合并、发布或绕过保护。早期私有开发历史不得上传公开仓库。
