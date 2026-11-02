# 本地 Alpha 发布流程

目标版本为 `0.2.0-alpha.2`。本地脚本只准备候选或 CI Artifact，不自动推送、打标签、上传 GitHub Release 或重启服务。公开仓库为 `danvilig/codex-remote-web`，首次公开从独立快照开始，后续在其 `main` 分支正常追加提交。

## 公开源码快照

本地开发仓库保留完整历史；对外源码采用当前代码的独立快照，不发布原开发历史。请使用当前 Git 身份确认过的干净提交：

```sh
bun run source:prepare
```

脚本从 Git 提交读取白名单文件，导出到忽略的 `.artifacts/public-source/`，拒绝脏工作区和覆盖已有输出。输出是独立 Git 仓库：只有一个初始提交，无远程地址，使用本地 `git var GIT_AUTHOR_IDENT` 身份。不会迁移运行目录或重写原仓库。快照不含历史机器记录、旧 `.git`、个人截图、提取资源、凭据、缓存或构建结果。`SOURCE_PROVENANCE.json` 记录历史参考项目的 MIT 来源和开发提交；原始 MIT 和有许可的 Lucide ISC 声明保留。发布说明应把 Codex Remote Web 视为独立项目，突出 Cloudflare Tunnel + Access 公网接入，不把参考项目写成当前产品的基础或运行依赖。

在导出的仓库中检查 `git rev-list --count --all` 为 1、`git remote -v` 为空、`git status --porcelain` 为空。运行 `bun run source:scan`：检查干净独立提交、无远程和不可达对象，扫描全部可达 Git 历史及文件路径，报告疑似凭据、本机路径与提取资源签名。输出只包含路径和规则名，不显示疑似秘密值。模式扫描不能证明一切敏感数据都不存在，仍须人工审阅文件与公开提交身份。审阅文件清单与提交身份；白名单不是人工检查的替代品。

### GitHub 初始提交与后续历史

首次公开以本次确认的当前版本为起点：只使用上述导出目录中的独立 `main` 分支作为 GitHub 初始提交。原开发目录的分支、标签和 `.git` 均不上传；不在原开发仓库添加公开远程后直接推送，也不使用镜像推送或全部分支/标签推送。

公开前在导出目录核对：

```sh
git log --oneline --all
git rev-list --count --all
git rev-list --parents HEAD
git remote -v
git fsck --full --no-reflogs --unreachable
git show --format=fuller --no-patch HEAD
bun run source:scan
```

预期只有一个提交、无父提交、无远程、无不可达对象；同时确认作者与提交者身份可以公开。`SOURCE_PROVENANCE.json` 中保留的开发提交哈希只是来源文字记录，不会携带对应的 Git 对象或早期历史。许可与必要署名仍然保留。

本地确认后，后续公开操作只在选定的独立仓库中添加目标 GitHub 远程并推送 `main`，不是推送原开发分支。首次推送完成后，以这个初始提交延续正常开发历史，不为每次版本发布替换根提交或强制推送。候选脚本每次生成的独立快照用于产物验证，不自动替换已经公开的仓库历史。首次公开仍须完成本文末尾的 GitHub 公开前门槛。

已公开仓库的完整检出使用 `bun run source:scan -- --published`。`SOURCE_PROVENANCE.json` 的 `publicRepository` 记录唯一允许的 GitHub origin URL 和公开初始提交；扫描要求非浅检出、只有该 origin、所有历史从该初始提交开始，仍扫描全部可达历史并拒绝不可达对象。Actions 使用 `fetch-depth: 0`；`verify:release` 根据来源记录与远程状态选择该模式。独立导出的快照继续使用默认的单提交、无远程规则，不因公开仓库已有合法后续提交而放宽快照校验。

`README.md` 为英文首页，`README-zh.md` 为中文全文，两者互相链接并共用展示图；源码快照与生产包必须同时包含两版。

## 验证与打包

从快照建立 HOME 外的全新检出，使用 `.bun-version` 和 `.node-version`：

```sh
bun install --frozen-lockfile
# 原生 PTY 如需重新构建，使用已安装 Node 的头文件。
npm rebuild node-pty
bunx playwright install --with-deps chromium webkit
bun run verify:release
docker build -t codex-remote-web:verify .
bun run test:docker
bun run source:scan
```

`verify:release` 统一运行依赖审计、构建、单元、协议基础/执行保护、工作区/手机/设置/终端、WebKit 预检、合成长会话性能基线、Access、配置向导、临时访问、HOME 外项目和生产归档回归。检测到 cloudflared 时必须执行真实二进制离线校验；未安装时输出明确 SKIP。离线校验不注册 Tunnel、不发送邮件。默认测试均使用隔离目录、模拟 App Server/Cloudflare、本地 JWKS，不需要真实凭据或模型调用。

Docker 回归只挂载临时项目与协议替身，校验 `/workspace`、权限边界、静态资源和真实 PTY。Linux 原生为主，Docker 为备用；容器内不能自动配置宿主机 systemd，默认镜像不包含 Codex 或 cloudflared。需要 Docker sudo 的开发主机可仅对该检查设置 `CODEX_WEBUI_DOCKER_SUDO=1`。

最终交付在**干净开发仓库**运行一次：

```sh
bun run candidate:prepare
```

此命令先导出独立快照、运行完整历史模式扫描、冻结安装快照依赖，再在快照内构建生产包。输出为 `.artifacts/candidates/<version>-<inputShort>/`，包含生产包、无 `.git` 的源码 tar.gz、依赖清单、发布说明、来源清单 `candidate.json`、扫描报告及 `SHA256SUMS`。`inputCommit` 记录执行命令时的检出提交，`snapshotCommit` 指向新独立快照，`developmentCommit` 保留原开发来源；在公开快照中运行 Actions 时，三者可以不同。源码仓库本身保留在 `.artifacts/public-source/` 以便审阅。命令不会运行完整验收或修改真实服务；须先完成上面的全套验证。

已有候选目录和源码导出均拒绝覆盖；失败时保留证据，检查后从新的干净提交重试。请不要在同一提交先运行 `source:prepare` 再运行候选命令。旧 Alpha 归档保持原样，不冒充本次代码。`release:prepare --output-dir <new-directory>` 仍可用于单独打包，但来自开发检出的产物不能当作最终公开候选。

生产 tar.gz 及 SHA-256 文件来自独立快照。白名单仅包括运行所需 bundle、静态资源、安装/安全文档、部署模板、冻结锁文件与生产依赖许可证清单 `third-party/dependencies.json` 和许可证/NOTICE 文本（包含 DOMPurify Apache-2.0）。README 展示图仅限 `scripts/documentation-assets.ts` 列出的六张模拟数据截图，并包含在源码和生产归档中以保持图片链接有效；图片目录说明、截图生成脚本、演示 fixture 和旧截图测试属于开发内部文件，不进入公开快照或生产归档。个人截图及其他图片仍被排除。扫描不能识别图片中的文字，展示图必须目视审阅。Docker 构建仍不包含文档图片。不包含 node_modules，原生依赖须在目标平台安装。`release.json.commit` 指向快照提交，`developmentCommit` 和 `SOURCE_PROVENANCE.json` 追溯本地开发来源。包不是独立可执行程序。

`test:release` 使用单独临时输出目录和 `--allow-dirty` 验证开发构建，禁止把这种测试产物当作候选；最终候选必须 `dirty: false`、`source: public-snapshot`。在独立 HOME 外目录校验 SHA-256 并解压，执行 `bun install --production --frozen-lockfile`，从其他 cwd 启动 `dist/server.js`，检查文件、PTY、静态资源和临时连接器 worker。安装、升级与回退见 [发布说明](releases/0.2.0-alpha.2.md)。

## 正式升级前的互斥协议切换

新版私有锁依赖 Bun 的 `bun:sqlite` 与本机本地文件系统；旧 JSON/PID 文件锁与新版 SQLite 事务锁不能同时协调同一状态。部署切换前必须停止共享同一 `CODEX_HOME` 的所有旧 WebUI 网关，确认任务、终端和待审批状态，再统一启动新版。只停止浏览器或开发入口不能代替停止其他旧网关。本轮生成候选不执行这一操作，不重启公网 WebUI 或 Tunnel。

网关均停止后备份并保留提交回执、持久队列、稳定 SQLite 锁数据库及相关 journal/WAL/SHM sidecar、旧锁标记；不要通过手工删除、改名或替换锁文件清除占用。进程退出后 OS 释放锁，未知提交仍须核对；升级或回退都不应清空去重身份。跨主机/网络共享存储不属于本版支持范围。

## GitHub 公开前门槛

1. 确定实际仓库归属、维护者及公开提交身份；文档不预设仓库地址。仅公开确认过的快照，不推送原开发仓库历史。
2. 在新公开仓库 **Settings → Security and quality → Advanced Security → Private vulnerability reporting → Enable** 启用私密报告。
3. 在 **Security → Advisories** 确认 **Report a vulnerability** 按钮，检查进入的是该仓库的私密报告表单；无需发送虚构漏洞。更新 SECURITY 的状态后再宣称渠道已启用。[GitHub 官方步骤](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)。
4. 在目标仓库实际运行 Verify 与手动 prerelease 工作流，确认 Actions 权限、浏览器和镜像构建都通过，再决定标签和正式上传。

两个工作流共享 `verify:release`，均执行依赖审计、临时访问、WebKit 预检和合成性能回归；有 cloudflared 时执行离线验证。验证后调用 `candidate:prepare`，导出并扫描干净独立快照后构建。手动流程只上传候选 CI Artifact，未调用公开发布 API。Artifact 的可见性由目标仓库设置决定。

## Linux GitHub Release

`.github/workflows/release.yml` 独立于候选脚本。经维护者确认发布后，将版本标签（例如 `v0.2.0-alpha.2`）指向已经通过 Verify 的公开提交，再推送该标签；也可以针对已有标签手动触发工作流。工作流检查标签与 `package.json` 版本一致，并固定检出的提交，不能将未通过 Verify 的提交发布。

构建矩阵使用原生 `ubuntu-24.04`（x64）和 `ubuntu-24.04-arm`（arm64）runner，各自完成冻结安装、PTY 重建、构建、单元测试，并验证两种实际归档。`deployment-linux-*` 是需安装依赖的 JS/静态资源部署包；`linux-*` 是包含编译程序、Bun/Node 运行时、静态资源和预编译终端模块的可执行包。`bun run release:portable -- --output-dir <new-directory>` 生成本机架构包；`bun run test:portable` 验证没有宿主机运行时/安装器/编译器时的完整运行。可用 `CODEX_WEBUI_PORTABLE_ARCHIVE` 指定待验收的实际归档。可执行包保留 `dist/portable.js` 和重链接说明、运行时许可证及版本来源。当前不声明支持 32 位 ARM 或 musl/Alpine 原生部署。

两端均通过后才创建 GitHub 预发布版本，上传四个归档（两种架构各有可执行包和 `deployment` 包）、各自使用纯文件名的 `.sha256` 和汇总 `SHA256SUMS`。仅下载一种架构时校验对应 `.sha256`；下载全部归档时可运行 `sha256sum -c SHA256SUMS`。GitHub 自动提供标签源码下载，无需再上传重复源码包。本流程不部署到现有服务，也不修改 Tunnel。
