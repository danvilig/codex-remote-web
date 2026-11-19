# 预发布候选与发布流程

目标版本为 `0.2.0-beta.2`（计划标签 `v0.2.0-beta.2`，仍为预发布）。本地脚本只准备候选或 CI Artifact，不自动推送、打标签、上传 GitHub Release 或重启服务。公开仓库为 `danvilig/codex-remote-web`，首次公开从独立快照开始，后续遵循 [Git 开发流程](GIT_WORKFLOW.md)：日常 PR 进入 `develop`，准备发版才创建 `release/<version>`，稳定后通过 PR 合入 `main`。标签指向已通过 Verify 的 `main` 提交，由维护者单独授权发布。

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

标签触发的 Verify 按事件提交 SHA 检出，保留完整拉取的附注标签。避免 checkout v4 将标签对象与提交比较后用轻量标签覆盖本地引用，制造不可达标签对象。扫描在安装依赖前执行一次，并在完整验证末尾再次执行，不以删除对象或忽略检查解决问题。维护者可从默认分支手动运行 Verify，在可选 `ref` 中指定已有发布标签；这使用当前工作流验证旧标签，不移动已发布标签或替换附件。

`README.md` 为英文首页，`README-zh.md` 为中文全文，两者互相链接并共用展示图；源码快照与生产包必须同时包含两版。

## 验证与打包

从快照建立 HOME 外的全新检出，使用 `.bun-version`、`.node-version` 和 `native-gateway/go.mod` 指定的工具链：

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

`verify:release` 统一运行依赖审计、构建、单元、协议基础/执行保护、工作区/手机/设置/终端、WebKit 预检、合成长会话性能基线、Access、配置向导、临时访问、HOME 外项目和生产归档回归。Verify 与候选 CI 下载固定版本、经 SHA-256 校验的 cloudflared，并设置 `CODEX_WEBUI_REQUIRE_CLOUDFLARED=1`，缺少二进制时直接失败。普通本地运行检测到 cloudflared 时执行真实二进制离线校验，未安装且未要求该检查时输出明确 SKIP。离线校验不注册 Tunnel、不发送邮件。默认测试均使用隔离目录、模拟 App Server/Cloudflare、本地 JWKS，不需要真实凭据或模型调用。

Docker 回归只挂载临时项目与协议替身，校验 `/workspace`、权限边界、静态资源和真实 PTY。Linux 原生为主，Docker 为备用；容器内不能自动配置宿主机 systemd，默认镜像不包含 Codex 或 cloudflared。需要 Docker sudo 的开发主机可仅对该检查设置 `CODEX_WEBUI_DOCKER_SUDO=1`。

最终交付在**干净开发仓库**运行一次：

```sh
bun run candidate:prepare
```

此命令先导出独立快照、运行完整历史模式扫描、冻结安装快照依赖，再在快照内构建生产包。输出为 `.artifacts/candidates/<version>-<inputShort>/`，包含生产包、无 `.git` 的源码 tar.gz、依赖清单、发布说明、来源清单 `candidate.json`、扫描报告及 `SHA256SUMS`。`inputCommit` 记录执行命令时的检出提交，`snapshotCommit` 指向新独立快照，`developmentCommit` 保留原开发来源；在公开快照中运行 Actions 时，三者可以不同。源码仓库本身保留在 `.artifacts/public-source/` 以便审阅。命令不会运行完整验收或修改真实服务；须先完成上面的全套验证。

已有候选目录和源码导出均拒绝覆盖；失败时保留证据，检查后从新的干净提交重试。请不要在同一提交先运行 `source:prepare` 再运行候选命令。旧 Alpha 归档保持原样，不冒充本次代码。`release:prepare --output-dir <new-directory>` 仍可用于单独打包，但来自开发检出的产物不能当作最终公开候选。

生产 tar.gz 及 SHA-256 文件来自独立快照。Linux 原生部署包包含网络服务、PTY、网页 bundle、静态资源、文档、部署模板、许可证清单 `third-party/dependencies.json` 和相应许可证。`node_modules` 目录仅保留浏览器需要的 KaTeX 字体和样式及 xterm 样式；不包含 Bun、Node、原生 Node 插件或运行时安装步骤。README 展示图仅限 `scripts/documentation-assets.ts` 列出的模拟数据截图，源码和生产归档都保留这些截图；图片目录说明、截图生成脚本和展示 fixture 属于开发内部文件。Docker 构建不含文档图片。`release.json.commit` 指向快照提交，`developmentCommit` 和 `SOURCE_PROVENANCE.json` 追溯开发来源。

`test:release` 使用独立临时输出目录和 `--allow-dirty` 验证开发构建；最终候选必须 `dirty: false`、`source: public-snapshot`。测试校验 SHA-256，在独立 HOME 外解压，从不同 cwd 启动包内 `codex-remote-web`，检查文件、真实 PTY、静态资源和临时连接器，并确认网关不调用宿主机运行时、安装器或编译器。原生包需要 `native-gateway/go.mod` 指定的 Go 版本、`.bun-version` 指定的 Bun，以及目标架构的构建环境。服务模板直接启动包内可执行文件。

## 正式升级前的互斥协议切换

新版私有锁依赖 Bun 的 `bun:sqlite` 与本机本地文件系统；旧 JSON/PID 文件锁与新版 SQLite 事务锁不能同时协调同一状态。部署切换前必须停止共享同一 `CODEX_HOME` 的所有旧 WebUI 网关，确认任务、终端和待审批状态，再统一启动新版。只停止浏览器或开发入口不能代替停止其他旧网关。本轮生成候选不执行这一操作，不重启公网 WebUI 或 Tunnel。

网关均停止后备份并保留提交回执、持久队列、稳定 SQLite 锁数据库及相关 journal/WAL/SHM sidecar、旧锁标记；不要通过手工删除、改名或替换锁文件清除占用。进程退出后 OS 释放锁，未知提交仍须核对；升级或回退都不应清空去重身份。跨主机/网络共享存储不属于本版支持范围。

## GitHub 公开前门槛

1. 确定实际仓库归属、维护者及公开提交身份；文档不预设仓库地址。仅公开确认过的快照，不推送原开发仓库历史。
2. 在新公开仓库 **Settings → Security and quality → Advanced Security → Private vulnerability reporting → Enable** 启用私密报告。
3. 在 **Security → Advisories** 确认 **Report a vulnerability** 按钮，检查进入的是该仓库的私密报告表单；无需发送虚构漏洞。更新 SECURITY 的状态后再宣称渠道已启用。[GitHub 官方步骤](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)。
4. 在目标仓库实际运行 Verify 与手动 prerelease 工作流，确认 Actions 权限、浏览器和镜像构建都通过，再决定标签和正式上传。

两个工作流共享 `verify:release`，均执行依赖审计、临时访问、WebKit 预检和合成性能回归，并强制执行真实 cloudflared 离线验证。cloudflared 仅作为 CI 工具下载，不加入产品包。验证后调用 `candidate:prepare`，导出并扫描干净独立快照后构建。手动流程只上传候选 CI Artifact，未调用公开发布 API。Artifact 的可见性由目标仓库设置决定。

## 跨平台 GitHub Release

Beta.2 目标为 Linux x64/arm64、macOS Apple Silicon（macOS 15+）和 Windows x64（Windows 11）。不构建 Intel Mac、Windows ARM64 或 musl 包；既有发布标签和附件保持不变。版本变更、发布说明与候选验证先通过稳定化 PR；发布准备不等于授权打标签或公开上传。

`.github/workflows/platform-packages.yml` 使用原生 `ubuntu-24.04`、`ubuntu-24.04-arm`、`macos-15` 和 `windows-2025` runner 生成候选包。发布使用受保护 `main` 上同一提交的成功 push Verify、已有版本标签，以及同仓库同提交、`run_attempt=1` 的 **Native platform packages** 完成记录；失败需新启动一次工作流，不能使用重跑产物。仓库所有者在 `main` 手动运行 **Publish platform release**，输入 `tag` 与 `candidate_run`。推送标签不会自动发布；发布流程校验并原样上传该候选包。

macOS 在 `macos-15` 构建，`LSMinimumSystemVersion` 必须保持 `15.0`。macOS 27 标准运行器核对 SHA-256 后复用原始 DMG，验证挂载、复制安装、签名、启动、界面与生命周期。两端通过 `sw_vers` 断言系统版本并输出安装报告与截图。`validation-macos-27-arm64` 只存验收证据。仅当 CI 的安装、网关、PTY 与桌面生命周期通过，唯一失败为可见 WebKit 合成时，可以由维护者在物理 macOS 27 实机安装、启动、检查可见 UI 后，输入相同 DMG 的 `macos27_manual_sha256` 和 `macos27_manual_version`（如 `27.0.1 (26A434)`）。发布说明明确区分自动化失败与人工结果。Safari 隔离与人工 Gatekeeper 允许仍需实机验收。

每个平台校验冻结安装、构建、目标架构和实际便携归档。回归覆盖异目录启动、完整页面及静态资源、受限文件读取/编辑、私有回执及 UUID 去重、持久队列访问、真实终端。Linux/macOS 验证受保护的临时连接器；Windows 的 CLI/便携包和桌面入口均使用独立 loopback 端口及每次运行的随机 Host 凭据，并校验 HTTP/WebSocket 边界，不降级为可公开访问的无认证源站。Linux 完整 Verify、依赖审计、浏览器和 Docker 验证继续运行。

桌面安装包使用已通过测试的便携网关资源和锁定 Electron 构建。macOS runner 挂载 DMG、复制 `.app` 到含空格路径并运行真实桌面窗口/后台生命周期回归。Windows 使用固定 WiX 5.0.2 构建 per-user MSI，实际静默安装、检查开始菜单、运行回归、卸载并确认自有程序和快捷方式清理；另验证 NTFS 宽泛 ACL 和 junction 拒绝。Linux 两种架构安装实际 DEB，在 Xvfb 中验证沙箱窗口、退出托盘后网关继续运行、重新连接及停止，再移除 DEB。GUI 人工操作、TCC/Gatekeeper/SmartScreen 提示、真实注销/登录与公网邮箱验证仍需单独验收，自动化不冒充人工验收。

Beta.2 共十个安装/归档文件：macOS DMG、Windows MSI、两种 Linux 架构的桌面 DEB、四个系统/架构的 CLI 便携包，以及两种 Linux 架构的原生部署包。Windows 便携包为 zip，其他归档为 tar.gz；每个文件附带同名 `.sha256`，汇总 `SHA256SUMS` 共十项。下载一个包时只核对它的校验文件，下载全部包时可用 `sha256sum -c SHA256SUMS`。GitHub 自动提供源码下载，无需重复上传源码包。

本机便携构建使用 `bun run release:portable -- --output-dir <new-directory>`，必须与目标系统及架构一致。`CODEX_WEBUI_PORTABLE_ARCHIVE` 指定待验收的实际归档，`bun run test:portable` 验证网关不依赖宿主机 Bun/Node、安装器或编译器。归档包含原生网关及 Go 许可证，不包含 Codex、cloudflared 或凭据。

Mac 测试包在最终应用组装和权限归一化后，对全部 Mach-O、嵌套 bundle 与外层应用由内向外进行 ad-hoc 签名，再验证最终 DMG 内及复制后的签名；它仍无 Apple Developer ID 签名或公证，Windows 包也尚无发布者签名。不可将 ad-hoc 校验通过描述成 Gatekeeper 信任通过。安装窗口采用原生 Finder 固定布局，详细说明在带动效的 `Install Guide.html` 中。原生 CI 读取压缩成品的背景与图标位置并保留截图；Safari 下载与手动允许须在真实 Mac 验收。原始图标和背景由 `bun scripts/macos-artwork.ts` 使用锁定 Playwright Chromium 生成，构建仅取四个指定 PNG，不引入第三方品牌素材。桌面应用在 macOS/Windows/Linux 管理固定域名网关与受保护临时访问；无桌面的自动部署仍使用 Linux 用户级 systemd。登录自启默认勾选，在首次保存时注册，注销后停止；应用不自动接管已有 headless/systemd 部署。升级前停止冲突网关并保留数据；macOS 删除应用前显式移除后台组件，Windows/Linux 卸载清理自有后台组件。安装、权限边界及限制见 [跨平台配置](deployment/PLATFORMS.md)。

### macOS 清晰度、语言与磁盘占用

安装背景使用 `tiffutil -cathidpicheck` 合并 680×480 和 1360×960 两个表示，维持 680×480 点的 Finder 布局。指南图标通过 AppKit 写入挂载卷的资源叉，压缩后重新挂载验证 Finder 标志和图标数据。静态安装背景保留一行英文拖拽指引；独立指南按系统语言显示，并提供中英文切换。桌面语言选择即时持久化，同步界面、状态栏菜单、应用菜单及确认框，无需停止网关。

macOS DMG 使用系统 AppKit/WKWebView，并以 Go 可执行文件提供网关、原生 PTY 和隔离工作进程。签名完成后用 `ditto --hfsCompression` 将应用复制进 HFS+ DMG。`macos-package-size.json` 记录打包前后的逻辑大小与卷内分配；`macos-installation-check.json` 记录 Finder 复制安装后的实际大小。不支持透明压缩的目标文件系统可能恢复逻辑大小。

macOS 的后台助手拥有独立的 Launch Services 身份，不显示在 Dock。退出应用会关闭主界面和菜单栏图标，网关继续运行；通过 Dock、Finder 或状态菜单可重新打开主窗口。重新安装时，仍在运行的同路径旧版后台代理会在首次打开时正常停止，并由新版本按原有设置恢复。

诊断页保留“停止并移除后台组件”，另提供“清理并卸载”。确认后停止自有进程、移除登录项、清除应用设置、缓存和已保存的管理令牌；Mac 应用移入废纸篓。项目、`~/.codex` 与独立 headless 部署不在删除列表内。存在远程部署或未完成的恢复时拒绝清理，用户须先在远程访问页处理，防止删除云端资源的恢复记录。后台目录仅保留无个人信息的稳定锁与代际标记，以维护并发/旧回滚令牌边界；未知文件保留。
