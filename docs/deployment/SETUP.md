# Cloudflare 网页接入向导

向导复用 Codex Remote Web 的主题、表单、按钮和设置导航。首版支持 **Linux + 用户级 systemd + 已有 Cloudflare 账户、域名和登录方式**。配置流程已有隔离回归，并完成真实域名 Access 登录与公网工作区连通验证；支持复用远程 Tunnel，或创建专用 Tunnel 并使用已安装的 cloudflared 启动独立连接器；不自动下载或安装 cloudflared 软件。Docker 容器不具备宿主机用户 systemd，首版自动部署向导仅用于原生安装。

## 打开页面

本地工作区：**设置 → 远程访问 → 开始配置**。

配置完成后再次打开 **设置 → 远程访问**，会直接显示公网地址、Cloudflare Access 认证方式、允许登录的邮箱、团队域名，以及公网会话的当前身份和到期时间。查看这些信息无需重新输入管理 API Token。公网已登录用户通过只读状态接口查看当前网关配置；本地工作区从已完成的部署记录恢复摘要。该摘要不代表重新检查了 Cloudflare DNS 或 Tunnel 健康状态。

修改或删除仍需本机配置会话：本地摘要中选择 **在本机管理**，或使用下面的独立向导。公网摘要不会提供配置、删除或管理令牌输入入口；状态接口也不会返回 AUD、JWT、连接器令牌、服务环境或完整部署记录。

独立配置或公网 Access 启用后的维护：在安装目录运行 `bun run setup:cloudflare`，打开终端输出的单次本地链接。这个进程不启动 Codex，不需要模型凭据。页面刷新使用临时 HttpOnly 会话恢复；锁定后或会话失效后重新开始即可。API Token、启动凭证均不写入 localStorage/sessionStorage。

服务器没有桌面浏览器时，通过 SSH 将终端打印的 loopback 端口转发到自己的电脑：`ssh -L 本地端口:127.0.0.1:服务器向导端口 你的服务器`。在本地打开相应 URL，并保留链接中的 `#setup=...`。不要把配置入口通过 Tunnel 暴露到公网，不要把一次性链接放到公开日志或聊天。

## Cloudflare 授权

在 Cloudflare Dashboard 的 **My Profile → API Tokens → Create Token → Custom token** 中添加权限。向导需要同时读取账户、域名、现有 Tunnel 和 Access 组织，并创建 Access 应用、Tunnel 路由和 DNS 记录。权限选择器每一行都是三段：**资源范围 → 权限组 → 访问级别**。请按下面的官方字段逐行添加：

| 三段式（按控制台字段填写） | 用途 | 资源范围限制 |
| --- | --- | --- |
| `Account → Account Settings → Read` | 列出可选账户 | **Account Resources** 选择拥有 Tunnel 的具体账户 |
| `Account → Cloudflare Tunnel → Edit` | 读取、合并和更新现有 Tunnel 配置 | 同一个具体账户 |
| `Account → Access: Apps and Policies → Edit` | 创建、读取和移除 Access 应用及策略 | 同一个具体账户 |
| `Account → Access: Organizations, Identity Providers, and Groups → Read` | 读取 Team Domain | 同一个具体账户 |
| `Zone → Zone → Read` | 读取域名并确认归属 | **Zone Resources** 选择承载 WebUI 的具体域名 |
| `Zone → DNS → Edit` | 创建和移除 WebUI 的 CNAME 记录 | 同一个具体域名 |

常见疑问：`Zone → Zone → Read` 只读域名信息，还必须再添加 `Zone → DNS → Edit`。Tunnel 权限请选择第一段 `Account`，再在第二段搜索 `Cloudflare Tunnel`。Access 的同名权限可出现在 **Account 和 Zone 两种范围**；本项目使用 `/accounts/.../access/...` 接口，必须选择 **Account**，不能用 Zone 级 Access 权限替代。

读取 Team Domain 的接口明确列出的是 `Account → Access: Organizations, Identity Providers, and Groups → Read`。`Account → Access: Organizations → Read` 是独立的权限项，不能仅凭简称断言它们等价；当前向导清单采用端点明确列出的组合权限。[组织查询接口](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/list/)。

权限清单保留英文名称，与控制台对照；写权限可能显示为 `Edit` 或 `Write`。官方 Tunnel 列表和配置更新接口还接受以下替代项，**Tunnel 权限选一项即可**：

- `Account → Cloudflare One Connector: cloudflared → Write`
- `Account → Cloudflare One Connectors → Write`

这些是官方 API 接受的权限名称；不同版本的控制台可能使用不同名称。[Tunnel 权限依据](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update/)。

资源范围也要收紧：Account 不要选 `All accounts`，Zone 不要选 `All zones`，分别指定实际账户和实际域名。不要把 `Zone → Zone → Edit` 当作 DNS 权限；向导只需要 Zone Read 加 DNS Edit。完成后点击 **Continue to summary → Create Token**，令牌只显示一次，复制到向导表单。

API Token 验证通过后保存到服务器私有的 `~/.config/codex-remote-web/management-token.json`，目录权限 `700`、文件权限 `600`。这是文件权限保护的明文凭据，不是加密保险库；请勿公开或打包。浏览器表单连接时立即清空令牌，浏览器存储、部署记录与运行环境不保存该 Token。锁定或会话到期只释放内存中的客户端；再次打开管理会自动复用已保存的 Token，进程重启后同样可恢复。可用“更换 API 令牌”替换或“删除已保存的令牌”移除；后者不撤销 Cloudflare 侧的令牌，也不删除现有公网部署。首次 Cloudflare 账户、域名托管、Zero Trust 注册与登录方式仍需先在控制台完成。

## 操作顺序

1. 连接账户，选择域名和 Tunnel 配置方式（复用或新建），填写子域名或 `@`、唯一允许的邮箱和空闲本地端口。默认端口为 `8900`，保留已有 `8899` 开发服务。
2. 预览只读取信息，不创建资源；已有同名 DNS、Access 应用、精确或通配 Tunnel 路由会阻止部署，以保护现有服务；`@` 表示所选域名本身，已有根域名记录也不会覆盖。既有手工部署不会自动接管。
3. 选择新建时先创建专用 Tunnel，并以用户服务启动独立本机连接器；确认在线且连接器身份属于本机后，继续创建仅允许该邮箱的 Access 应用，读取 AUD 和 Team Domain，并验证返回的策略。创建原生服务前检查用户 systemd 和端口。
4. 沿用当前进程的 Codex 状态与工作目录，构建生产 bundle，生成私有环境文件和用户 unit；不会覆盖 `.env`、Codex 配置、凭据或项目文件。原生服务独立于当前开发进程。
5. 确认新服务的认证方式、域名、AUD 和邮箱正确后，合并一条带 Protect with Access 的路由，并创建代理 CNAME。保留其余 Tunnel 配置和 catch-all。
6. 公网探测只检查登录跳转，DNS 生效或网络波动时显示待验证。点击公网地址自行登录，验证页面、消息、审批和手机使用。探测不会提交模型回合。

源站参数显式保留该域名的 HTTP Host，避免现有 Tunnel 全局 Host 改写造成身份检查失败。首版管理一套个人部署；已有托管部署可在本机管理中修改域名、DNS 区域、已有 Tunnel、端口和邮箱，无需先移除旧部署。

## 哪个 Tunnel 连接着本机

名称和 `Healthy` 状态不能证明连接器运行在本机。向导读取当前 `cloudflared.service` 或 `codex-remote-web-tunnel.service` 的 systemd Invocation ID，从本次运行的可读日志中提取 `Generated Connector ID`，再与 Cloudflare 连接器 API 返回的 ID 匹配；不读取现有 Tunnel Token，不通过公网 IP 猜测。

匹配的条目标为“连接本机”并优先选择，同时显示 Tunnel ID 和状态；日志权限不足、非标准服务名或非 systemd 部署可能无法自动识别，此时显示“未确认所在机器”，需用户在 Cloudflare 的连接器详情和本机日志核对后确认。如果已匹配本机且还存在其他未匹配的在线连接器，则阻止复用并建议新建专用 Tunnel，因为同一 ingress 中的 loopback 服务会在每个连接器所在主机独立解析。

没有 Tunnel 时选择“在本机新建 Tunnel”，填写名称。预览不创建任何资源；点击配置后才创建云端资源。新建名称附带随机标识用于超时后的安全识别和清理。若本机未安装 cloudflared，页面提供官方安装链接，安装后重新预览即可。新连接器使用 `codex-remote-web-tunnel.service`，不替换系统级或其他用户的 cloudflared。

## 域名输入

选中 `example.com` 后，仅填写 `codex` 即得到 `codex.example.com`，填写 `dev.codex` 即得到 `dev.codex.example.com`，填写 `@` 即得到 `example.com`。切换所选域名时后缀和完整 URL 自动更新。服务端使用 Cloudflare 返回的 Zone 名称重新拼接并校验，不信任客户端提供的后缀。

## 服务与生命周期

生成的文件位于：

- `~/.config/codex-remote-web/remote.env`：运行环境，权限 `600`。
- `~/.config/codex-remote-web/setup-state.json`：资源 ID、私有清理记录及就绪探测凭证，权限 `600`。
- `~/.config/systemd/user/codex-remote-web.service`：本向导管理的用户服务。
- 新建 Tunnel 时还有 `~/.config/systemd/user/codex-remote-web-tunnel.service` 和权限 `600` 的 `~/.config/codex-remote-web/tunnel-token`。后者是运行连接器所需的 Tunnel Token，区别于配置阶段的管理 API Token；不会返回浏览器或写入清理记录。

服务使用当前安装目录的生产构建。移动安装目录前先移除或手工迁移服务。该服务由 `systemctl --user enable --now` 启动；用户服务能否在退出会话后和重启后持续运行还取决于主机的 linger 策略，部署验收应检查 `loginctl show-user "$USER" -p Linger`，并按主机管理策略启用。向导不会修改系统范围的登录策略。

## 诊断、失败与移除

页面的“运行诊断”检查本机认证配置、云端资源与单邮箱策略、公网登录边界。它不是模型调用或已登录端到端验收。

配置过程写入私有记录，重复提交会被拒绝；页面断线后只查询进度。正常失败会清理本次已创建资源。进程被杀死或清理不完整时，重新打开本地完整 WebUI 的管理页（也可运行独立向导），自动恢复已保存的管理 Token，然后诊断或选择“移除本向导创建的部署”。不自动重放中断的发布请求。

移除操作先撤下本条 Tunnel 路由，再删除其 DNS、Access 应用并停用原生服务；如果 Tunnel 是本向导新建的，还会停用独立连接器、删除其令牌文件并尝试删除专用 Tunnel。保留其他 Tunnel、路由和资源。Cloudflare 尚未确认连接器断开或网络暂时不可用时，清理可能需要稍后重试。发现本向导资源被修改时停止自动清理，避免覆盖用户改动，按私有记录进行人工处理。云端多资源操作无法保证原子性；配置合并前有二次检查，但控制台的并发修改仍可能需要协调。

## 官方接口依据

- [API 创建与配置 Tunnel、发布 DNS](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)
- [Tunnel 配置更新会替换整个远程配置](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update/)
- [Access 应用 API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/)
- [受限 API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)

- [连接器身份 API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/get/)


## 已配置后的日常管理

打开完整本地 WebUI → 设置 → 远程访问 → 在本机管理。已配置状态显示域名、邮箱、端口及操作入口，不再展示首次配置步骤。页面刷新、锁定后重新进入以及控制面进程重启，都不要求重复输入已保存且仍有效的管理 Token；旧版本只在内存中保存，无法从历史部署记录恢复，升级后需输入一次。遇到网络错误可重试已保存的 Token；过期、权限不足或手工删除后才需要重新连接。

选择“修改配置”后显示预填的地址表单，可修改当前账户中的 DNS 区域、子域名或 `@`、已有 Tunnel、端口和唯一允许登录的邮箱。账户保持不变；修改时仅支持选择已连接本机的现有 Tunnel，新建连接器仍在首次配置流程中提供。预览逐项显示原值与新值，返回保留填写内容，取消不写入任何云端配置。

保存会重启受保护的 WebUI，聊天连接和网页终端断开，公网访问可能短暂中断，本机开发入口保留。更换主机名时先创建独立的新 Access 应用及单邮箱策略，验证新服务的域名、AUD、邮箱，再发布受保护路由和 DNS；确认完成后才移除旧地址的托管资源。同地址更换 Tunnel 时通过 [DNS PATCH 接口](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/edit/) 更新 CNAME 目标，保留其他记录属性。单独修改邮箱复用原 Access 应用，通过 [策略更新接口](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/subresources/policies/methods/update/) 修改。原生服务其他环境项、unit、探测凭证和其他 Tunnel 规则保留。

迁移在提交前失败时尝试恢复旧配置；提交后若旧资源清理中断，则恢复时继续完成新配置的清理，不回退到已开始移除的旧地址。私有部署记录保留迁移日志，网络恢复或进程重启后可显式选择“恢复配置”。页面重连仅检查状态，不自动重放写入请求。遇到托管 DNS、路由、应用、策略或服务文件被手动修改时停止自动覆盖，先人工核对差异。

从向导创建的专用 Tunnel 切换出去时，保留原连接器及其归属记录，便于切回；最终移除部署时仅清理仍符合原始配置的自有 Tunnel 和连接器，不删除后来选择的用户已有 Tunnel。


## 没有域名：临时访问

完整本地 WebUI → 设置 → 远程访问 → **无域名临时访问**。已有固定域名时，摘要页和本机管理页也提供此入口。填写唯一允许的邮箱，点击启动；成功后显示 `https://随机名称.trycloudflare.com`、连接状态、复制按钮和本地生成的手机二维码。无需 API Token 或 Cloudflare 账户，不改动原有命名 Tunnel、DNS、Access 应用、systemd 服务或部署记录。页面刷新、返回设置和关闭浏览器标签页不会重复启动连接；显式停止会关闭这个临时入口的 WebSocket 和终端。WebUI 进程退出时也会结束连接，重启不自动发布新地址。

依赖 Linux/macOS、Node.js 和支持 `--allowed-mail`、`--unix-socket` 的 cloudflared。缺少依赖或旧版本会显示安装/更新提示；独立向导仅提示打开完整 WebUI，因为临时访问共享正在运行的 App Server。Quick Tunnel 是 Cloudflare 的测试服务，没有可用性保证，每次创建可能分配不同地址，最多 200 个并发中的请求，且不支持 SSE。此模式使用 WebSocket，断线后重新握手，不切换到 SSE，也不自动重发执行请求。邮件验证过期时保留本标签页草稿并提供重新登录入口。固定域名仍是长期使用方案。

启动前会使用实际 cloudflared 二进制离线执行 `ingress validate`，检查完整参数与配置，而非仅检查 `--help`。启动使用 `--output json`；`--hello-world` 只用于选择 Quick Tunnel 模式，显式 Unix ingress 优先，实际源站仍为私有 socket。页面会区分参数/配置错误、证书验证失败、网络故障和启动超时，不返回原始连接器日志或凭据。

cloudflared 的受保护 Quick Tunnel 功能负责邮件验证码和允许邮箱校验；它不等同于固定域名模式的应用 JWT。临时源站只监听随机 `700` 目录内的 Unix socket，尚未确认受保护启动与连接就绪前拒绝请求。应用不信任邮箱头，只信任自己启动、通过私有 socket 接入的受保护连接器，并再次校验分配地址的 Host/Origin。连接器使用独立的私有 Unix ingress 配置和过滤后的环境变量，避免加载用户现有的 Tunnel、Token 或 Host 改写。不会因邮箱认证失败降级为公开 Tunnel。

自动测试使用本地模拟的邮件认证边界、真实 WebSocket 和 PTY，不向 Cloudflare 注册连接或发送验证码，也不调用模型。受保护临时地址已完成实际连通验证。邮件登录会话的长期稳定性取决于外部服务和连接器；Cloudflare 或 cloudflared 的外部问题可能造成临时登录失效，不应取消邮箱保护来绕过。

参考：[Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)、[受保护临时访问](https://developers.cloudflare.com/changelog/post/2026-10-02-protected-quick-tunnels/)。
