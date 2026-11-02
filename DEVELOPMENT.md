# 开发指南

以根目录 `.bun-version`、`.node-version` 和冻结锁文件为运行时与依赖基准。本机安装记录仅保留于私有开发仓库，不进入公开源码快照或发布包。

```sh
bun install --frozen-lockfile
cp .env.example .env
bun run dev
```

Linux ARM64 上 `node-pty` 可能需要 `build-essential`、Python 3 和 Node 头文件。需要重新编译时，在已安装 Node 的环境执行 `npm rebuild node-pty`；不要全局安装另一套 Codex 或覆盖现有认证配置。

## 目录

| 目录 | 职责 |
| --- | --- |
| `src/server/` | 配置、认证、App Server 桥接、文件、审查、终端和 HTTP 服务 |
| `src/shared/` | 不依赖 DOM 的协议、审批和差异处理 |
| `public/` | 浏览器源码、HTML、CSS 和自有 SVG 资源 |
| `scripts/` | 开发、构建、发布包与环境验证 |
| `tests/unit/` | 默认单元测试 |
| `tests/browser/` | 浏览器与隔离协议回归 |
| `tests/live/` | 需要显式选择的实际环境/模型测试 |
| `tests/helpers/`、`tests/fixtures/` | 公共测试工具和模拟 Codex |
| `ops/` | 可复制的部署模板，不包含实际凭据 |

`dist/`、`public/app.bundle.js`、`.artifacts/` 和 `node_modules/` 是生成目录，不手工编辑或提交。

## 检查

```sh
bunx playwright install chromium
# 干净提交中运行完整离线发布门槛（含依赖审计）
bun run verify:release
# 修改尚未提交时，按改动范围单独运行 check/test:unit 等套件
```

默认单元、基础、工作区及 Access 测试使用临时目录和协议替身，不提交真实模型回合。`bun run test:workspace-features` 覆盖本机资源、插件/技能管理、后台调度持久化、Dock 和平板分栏；模拟执行不会调用模型。`test:browser:live` 对已运行服务进行页面、移动布局和传输降级检查。`test:browser:upstream` 是为历史参考项目保留的兼容性脚本名称，实际用例服务于本项目的回归；部分用例依赖旧布局或额外能力，不能用其名称推断它是无副作用测试。

`verify:release` 在检测到 cloudflared 时必须执行以下离线验证，未安装时明确输出 SKIP。安装 cloudflared 后也可单独运行 `bun run test:quick:cli`，使用真实二进制离线校验生产启动参数、私有 Unix ingress 和错误参数回归；此项不注册 Tunnel、不发送邮件、不调用模型。启动临时访问时也会先执行相同的离线配置校验，兼容部分命令行错误仍返回退出码 0 的版本。

`test:integration`、`test:e2e` 和 `tests/live/` 中的脚本可能调用真实模型、创建文件或执行操作，默认 CI 不运行。阅读对应测试并确认环境后，以 `CODEX_WEBUI_RUN_LIVE=1` 显式开启这些真实操作测试。

## Git

公开仓库为 `danvilig/codex-remote-web`，首次独立快照之后正常延续公开历史。日常从 `develop` 创建 `codex/<主题>` 等短分支，PR 合入 `develop`；发版时再创建 `release/<版本>`，验收后通过 PR 合入 `main`。受保护分支禁止直推/强推，PR 需 Verify 与规范检查通过、目标分支最新及讨论解决，由维护者人工合并。详细流程、合并方式和回合要求见 [Git 开发流程](docs/GIT_WORKFLOW.md)；AI agent 先读根目录 [AGENTS.md](AGENTS.md)。

本地历史开发仓库保留早期历史，不能向公开远程直接推送其分支。应把审阅过的文件改动转移到以公开 `develop` 为祖先的工作分支，通过 PR 提交；参考项目远程只用于来源追踪。`source:prepare` 仅用于独立源码/候选产物验证，不替换公开根提交。当前访问入口与本地 `.env` 不属于发布配置。


## Alpha 2 development tools and browser acceptance

`bun run test:developer-tools` verifies previewed AGENTS.md edits, managed worktree removal, storage cleanup and MCP inventory using a temporary HOME/project. `bun run test:webkit` requires an installed Playwright WebKit binary and runtime libraries; it fails rather than silently falling back to Chromium. Install browsers with `bunx playwright install --with-deps chromium webkit`. `bun run test:performance` writes a synthetic history baseline under `.artifacts/`; it is not a claim about physical iPhone performance.

`bun run source:scan` is for the independent public snapshot. `bun run candidate:prepare` is for a clean development checkout and creates a new immutable snapshot plus local source/production artifacts. Neither command publishes or restarts a service. See [release gates](docs/RELEASING.md).
