# Git workflow / Git 开发流程

The public repository is [danvilig/codex-remote-web](https://github.com/danvilig/codex-remote-web). `main` remains the default branch. The original private development history must never be merged or pushed into it.

## Branches

| Branch | Purpose and lifetime | PR target |
| --- | --- | --- |
| `main` | Protected, releasable history; tags are created here after verification | — |
| `develop` | Protected integration branch for the next version | `release/<version>` when preparing a release; `main` for a reviewed workflow/docs promotion |
| `codex/<topic>`, `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>` | Short-lived work from `develop`; agents normally use `codex/` | `develop` |
| `release/<version>` | Created from `develop` only when a real release candidate exists; stabilization, version and documentation changes only | `main`, then back-merge to `develop` |
| `hotfix/<topic>` | Urgent production fix from `main` | `main`, then back-merge to `develop` and any active release branch |

There is no permanent `release` branch and no empty release branch at setup time. Rules already cover `release/*`; create one when freezing a version. Never move or replace an existing public release tag. Publishing is a separate human-authorized operation, not a consequence of merging a feature PR.

## Daily work

```sh
git clone https://github.com/danvilig/codex-remote-web.git
cd codex-remote-web
git switch develop
git pull --ff-only origin develop
git switch -c codex/short-topic
# Make a focused change and run the relevant checks.
git add <reviewed-files>
git commit -m "fix(scope): describe the behavior corrected"
git push -u origin codex/short-topic
gh pr create --base develop
```

External contributors use a fork and open a PR into upstream `develop`. Rebase a private, unshared branch only when appropriate; prefer merging the target branch when updating an already-reviewed PR. Never force-push protected branches. Resolve review threads only after addressing them or explaining the resolution.

PR titles use `type(scope): description` or `type: description`, at most 100 characters. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `revert`, `release`. English titles are preferred; descriptions may be English or Chinese. Explain breaking changes. Commits should be focused and use the same convention; the PR title becomes the squash commit title.

## Protection and merging

Active repository rules cover `main`, `develop` and `release/*`: PR required, `verify` and `pr-policy` checks from GitHub Actions required, target branch up to date, review conversations resolved, no force pushes and no deletion. The setup has no bypass actors. Administrator access to change settings is not an approved way around failed checks.

This is a **single-maintainer** project: required approvals are zero because GitHub does not let authors approve their own PRs. The maintainer still reads the actual diff and evidence and merges manually; an agent review or a passing policy check is not approval. When another maintainer joins, increase required approvals and enable the corresponding stale-review protections. CODEOWNERS identifies the maintainer but does not override the zero-approval policy.

Use **squash merge** for short-lived feature/fix branches. Use a **merge commit** for `develop`/`release/*` promotion into `main` and back-merges, preserving shared ancestry; do not squash integration/release promotions. Rebase merging is disabled. Branch deletion after merge is manual: remove finished short-lived branches, retain `main`/`develop` and active release branches. Linear history is not required because promotion uses merge commits.

Required workflows must run for all PRs targeting these branches, without path filters or commit-message CI skips. First-time fork contributions may need maintainer authorization for their Actions run. Workflow tokens remain read-only by default; do not use `pull_request_target` to execute contributor code with secrets. Tests use disposable fixtures, never personal model credentials.

## AI-assisted PR evidence

Complete every PR-template section and its three declarations. Replace placeholders. `pr-policy` validates title, branch routing, nonempty sections and declarations; it cannot prove a claim is true. The maintainer must inspect evidence and changes to the checker or its workflow.

- State the concrete problem, scope, affected protocol/configuration and why the approach works.
- List actual commands, results and CI links; explain skipped checks. Reliability fixes need a reproducer and before/after evidence. No speculative “all tests pass.”
- Disclose AI tools and contribution scope, contributor review and remaining uncertainty. If no AI was used, say so. Do not fabricate a human sign-off.
- UI changes need synthetic before/after screenshots for relevant desktop/tablet/mobile states. Security, queue, file and protocol changes need boundary and regression evidence.
- Explain risks, compatibility, migrations and rollback. Flag dependency, workflow, native executable and release changes explicitly. Keep secrets, private prompts, personal paths and proprietary assets out of diffs and attachments.

## Release sequence

1. From reviewed `develop`, create `release/<version>`; stabilization changes enter it through PRs.
2. Run full gates and prepare release notes. Open `release/<version>` → `main`, inspect and manually merge after checks pass.
3. After the merged `main` commit passes Verify, a maintainer explicitly authorizes the version tag and publication. The Linux workflow validates x64/arm64 packages; merging alone does not publish.
4. Back-merge `main` → `develop` through a PR. Retain a protected release branch until a deliberate retirement decision; do not weaken protection merely for housekeeping.

See [release operations](RELEASING.md) for candidate generation and package validation. Existing `v0.2.0-alpha.2` is unchanged by adopting this workflow.

## 中文速览

日常从 `develop` 创建 `codex/<主题>` 等短分支，经 PR 合入 `develop`。准备发版时才创建 `release/<版本>`，只做稳定性、版本和文档收尾；通过 PR 合入 `main` 后，由维护者单独授权打标签与发布，再把 `main` 回合到 `develop`。紧急修复从 `main` 创建 `hotfix/*`，修复后同步回开发线。

三个受保护分支范围均禁止直推、强推和删除，要求完整 Verify、PR 规范检查、目标分支最新和讨论解决。单维护者模式不强制他人审批，但由维护者人工阅读 diff、核对证据并合并。短分支采用 squash，集成/发版与回合采用 merge commit，避免历史脱节。AI agent 必须先读根目录 AGENTS.md，如实记录参与范围、实际测试、未验证项和风险；不得将自己的判断当作人工批准，也不得擅自合并或绕过规则。
