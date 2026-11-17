# Desktop gateway / 桌面网关

The macOS DMG, Windows per-user MSI and Linux desktop DEB open a shared Electron settings window. The standalone archives remain command-line distributions for headless use. Desktop packages include the existing Bun/Node gateway and native terminal; Codex CLI, Git and cloudflared are external prerequisites. Electron is pinned in the lockfile, and its MIT/Chromium notices accompany each desktop package.

## 初始化与日常使用

双击应用后，在“网关设置”选择项目目录、端口及可选的 Codex/cloudflared 程序路径，检测依赖并保存，再启动网关。沿用当前用户的 Codex 账户和配置；桌面窗口不管理模型提供商/API 密钥。Codex 和 Git 必需，cloudflared 仅公网访问需要。网页终端默认关闭，开启后以当前用户权限运行。

macOS 15+ 仅支持 Apple Silicon；Windows 11 仅支持 x64、NTFS 和 Windows PowerShell；Linux 桌面首轮基线为 Ubuntu 24.04 GNOME，提供 x64/arm64 DEB。Linux 原有服务器部署归档与便携 CLI 不变。桌面包尚无 Apple Developer ID 签名/公证或 Windows 发布者签名；不要全局禁用 Gatekeeper、SmartScreen 或 Chromium 沙箱。Linux DEB 安装正确归属的 Chromium sandbox helper，无需修改主机 user namespace 策略。

### macOS 安装与首次打开

最低系统版本保持 macOS 15.0。原生流水线在 macOS 15 构建并测试 DMG，再在 macOS 27（GitHub `xcode-27` 预览 runner）下载、核对 SHA-256 并测试**同一份** DMG，不在新系统另造替代包。两端均记录真实 `sw_vers` 与系统 build，检查挂载、Finder 布局、安装后启动、浅色/深色设置界面、沙箱和后台生命周期；`macos-installation-check.json` 关联精确安装包 SHA-256。预览 runner 的镜像可能更新，实际测试系统以每次报告为准，不将 runner 名称本身当成覆盖证据。

打开 DMG，将左侧应用拖入右侧 Applications；等待复制完成，推出磁盘，再从“应用程序”启动。Finder 安装窗口使用静态背景，随包的 `Install Guide.html` 提供带轻量动画的中英指南，支持键盘和系统“减少动态效果”。Codex CLI、Git 须另行安装配置。

新的 Mac 测试包在最终资源和权限确定后，对 Electron、网关/Bun、Node、PTY 及完整 `.app` 由内向外进行 ad-hoc 完整性签名，并强制校验。这不是 Apple Developer ID 签名或公证，首次仍可能被 Gatekeeper 阻止。先尝试打开，再按 [Apple 指引](https://support.apple.com/102445)进入“系统设置 → 隐私与安全性 → 仍要打开”并确认；只允许来源可信的构建。

若仍提示“已损坏”，请保留安装包和 SHA-256，反馈原始提示、macOS 版本及芯片型号。不要通过全局禁用 Gatekeeper 或清除 quarantine 属性绕过错误。旧版本包不因本次修复而获得有效签名。原生 CI 验证签名、篡改拒绝、DMG 挂载后的 Finder 布局、复制后的签名及真实桌面运行；Safari 下载隔离与人工信任流程需在真实 Mac 上另行验收。

“概览”提供启动、停止、重启和打开浏览器工作区。关闭设置窗口后隐藏到托盘；退出托盘只退出界面，网关继续运行。Linux 桌面若不支持托盘，关闭按钮会最小化到任务栏，也可从应用菜单重新打开设置。设置在网关停止时仍可打开；变更运行参数前先停止网关。

后台代理与界面分离，登录期间以当前用户运行：macOS 使用 LaunchAgent，Windows 使用交互用户登录任务，Linux 使用绑定 graphical-session.target 的 systemd 用户服务。登录自启默认勾选，在首次保存时注册；注销后停止，不是注销后仍在线的系统服务。禁用登录自启不停止当前运行的网关。Windows 任务不设运行时限，不因切换电池而停止。

## 公网访问

先初始化并启动本地网关，再进入统一的“远程访问”页面：

- 临时访问：填写唯一允许邮箱，显式启动受保护的临时 HTTPS 地址；停止或重新登录后需重新生成，不自动公开新地址。
- 固定域名：复用现有 Cloudflare Tunnel + Access 向导，支持新建专用 Tunnel、已有 Tunnel、预览、应用、调整、诊断和移除。桌面代理管理独立的 Access 网关与自有连接器；就绪检查通过后才添加公网路由。
- 本地网关和固定域名网关使用不同端口。公网管理 API 不进入 Tunnel，Access、Origin、文件范围和审批边界继续由服务端校验。
- Windows 临时访问使用专用 loopback 端口及每次运行重新生成的随机 Host 凭据，只有受邮箱保护的 cloudflared 连接器掌握该凭据；HTTP 和 WebSocket 均校验。不会退化为可直接访问的无认证源站。

仅恢复已完成的固定域名部署；未完成/需恢复的事务显示错误并由用户处理。停止网关会关闭自有公网连接和终端；共享 Codex daemon 不属于本应用，停止网关不会停止它。不要同时运行争用相同端口和 Codex 状态的旧版网关；桌面应用不自动接管现有 headless/systemd 部署。

## 数据、升级与卸载

桌面私有状态位于用户主目录的 `.config/codex-remote-web/desktop/`，包含配置、部署回执、管理令牌及稳定 SQLite 实例锁。Unix 检查 uid/mode，Windows 检查 NTFS owner/DACL；链接、共享或无法确认的权限会被拒绝。控制凭证不进入网页、URL、日志或发布包；诊断只显示有限的进程生命周期记录，不含会话内容。

升级前停止网关。Windows MSI 卸载和 Linux DEB 移除调用归属检查后的后台清理，保留项目、Codex 配置/凭据、队列与回执。macOS 移到废纸篓前，在“诊断”点击“停止并移除后台组件”。三端均可先用该按钮显式清理登录项。维护时也可运行随包网关的 `uninstall-desktop`；它不删除用户数据或云端资源。移除 Cloudflare 资源须先在远程向导执行“移除托管部署”。

Windows 突然断电时仍不承诺目录项 fsync；保留未知提交的回执并核对，不自动重放。安装包中网关资源位置变为 macOS `.app/Contents/Resources/gateway`、Windows/Linux `resources/gateway`；CLI 便携包目录结构不变。

Windows 登录任务在每次保存时核对实际任务，缺失或被禁用的自有任务会重新注册；名称相同但启动命令已改变的任务会被保留并报错。注册变更前会在私有状态目录保存 `session-windows-pending.json`，本地记录持久化失败时按完整任务 XML 和启用状态核对并回滚，回滚失败也会明确报告。

若出现 `SESSION_RECOVERY_REQUIRED`，辅助进程可能在修改任务后失去响应，或任务已被其他程序修改。保留该文件、`session.json` 及任务计划程序导出的 XML，不要删除状态文件来强行重试。恢复请求只会自动接受与记录中原始状态完全一致的任务，或与已确认提交的任务和本地记录完全一致的状态；其余情况须由维护者核对启动命令、XML、启用状态和归属后处理。此时保存和移除都会报错，避免把未确认的任务当成已成功移除；不会自动覆盖外来任务。

Windows 独立 App Server 模式使用隐藏的 Windows PowerShell Job 辅助进程，须允许 `Add-Type` 编译随包代码。它先建立系统进程归属，再启动 Codex；若系统策略不允许建立该边界，会拒绝启动并记录错误，不会回退为无监督运行。共享 daemon 不属于网关的 Job，停止网关不会停止共享任务。

首次启动时 PowerShell 编译可能较慢。辅助进程有单独的 90 秒启动上限，确认原生进程已启动后才开始计算原有的初始化 RPC 超时；业务请求在辅助进程启动期间返回未发送，不会排队执行。此阶段“网关运行中”仅表示 HTTP 服务已就绪，Codex 连接仍需完成初始化。

辅助进程的待写入输入最多积压 64 MiB 或 2,048 个数据块，先达到任一上限时关闭自有 Job；这也防止 Codex 停止读取输入后无限缓存。由此中断的未知执行仍须核对回执，不自动重试。

## 开发和验收

`bun run desktop:dev` 构建并打开桌面界面；首次需要执行 `node node_modules/electron/install.js` 下载锁定的 Electron 运行时。`bun run test:desktop` 使用隔离项目、协议/Cloudflare fixture 验证设置交互和后台生命周期，不访问个人账户或模型。`tests/browser/desktop-native.e2e.mjs` 在各原生安装包上检查真实窗口沙箱、preload 隔离、退出界面后网关继续运行、重新连接和停止。

原生 CI 构建并测试 DMG/MSI/DEB；GUI 人工操作、系统信任提示、注销/登录真实桌面会话与真实公网邮箱验证需要单独报告，不能由 fixture 测试代替。保留源码、锁文件、第三方许可证与 Electron 的 Chromium 通知，签名、公证和正式发布单独进行。
