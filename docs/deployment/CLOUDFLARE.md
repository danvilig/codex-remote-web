# Cloudflare Access 部署准备

主线是原生 Bun 服务 + 现有 cloudflared，面向单个受信任个人。此版本已完成隔离测试、真实域名 Access 登录与公网工作区连通验证，也已验证受保护 Quick Tunnel。服务随主机重启恢复和实际撤销时效应在目标部署中单独检查。本文不包含实际部署的域名或凭据，执行步骤会修改所选部署。以下大写值都是占位符，不能直接用于上线。

## 网页向导

已有健康的远程 Tunnel 时，可通过本地页面的 **设置 → 远程访问** 或 `bun run setup:cloudflare` 使用内置网页配置，无需逐个复制 AUD 和 Team Domain。见 [网页向导说明](SETUP.md)。以下手动步骤仍可使用，向导不会自动迁移手工部署。

## 先准备应用，再增加路由

1. 确定实际访问域名、Team Domain 和允许登录的个人邮箱。在 Cloudflare 创建该域名的 self-hosted Access 应用，只允许指定身份，启用身份提供商的 MFA，建议应用/策略会话有效期先设为一小时。
2. 记录此应用准确的 Audience Tag（AUD）。不要把 Tunnel connector token 当成用户 JWT，也不要把示例域名当成正式域名。
3. 将发布目录放入用户可访问的固定位置，执行 `bun install --production --frozen-lockfile`；确认 Codex、Bun、Node、Git 和 bubblewrap 可在服务 PATH 中找到。沿用实际 Codex 状态和项目目录。
4. 复制 `ops/systemd/codex-remote-web.service.example` 为用户级 unit，按安装位置修改。复制环境示例至用户私有配置目录，权限设为 `600`，填写 Access 五个必填参数。只监听 `127.0.0.1:8899`。
5. 在现有 Tunnel 的 ingress 中、catch-all 之前加入 `ops/cloudflare/ingress.yml.example` 中这一条应用路由；不要替换其他应用或重复安装 cloudflared 服务。远程管理的 Tunnel 在控制台填写同样的 hostname、service 和 Protect with Access 参数。
6. 校验 Tunnel 配置后再使新路由生效。Protect with Access 要求 `required: true`、正确的 `teamName` 和当前应用 `audTag`；网关仍自行验证 JWT。

## 原生服务

用户级 systemd 模板默认安装在 `%h/opt/codex-remote-web`，配置在 `%h/.config/codex-remote-web.env`；维护者按实际路径调整。确认后使用 `systemctl --user daemon-reload` 和 `systemctl --user enable --now codex-remote-web`。是否启用 linger 由实际主机的服务管理方式决定。

不要在服务配置中覆盖 Codex 的模型、provider、权限或认证文件。不要增加 `ProtectHome` 等会阻止 Codex 访问其工作目录的限制。服务重启会终止其管理的 App Server；页面断线与服务重启的影响不同。

## 更新正在运行的版本

前端和后端必须作为同一版本部署。当前服务从安装目录读取静态资源；在仍运行旧进程的目录内构建前端，会使页面先变新而后端接口仍旧，新增 Files、附件或会话工具可能返回 404。推荐将新版本安装到独立版本目录，完成冻结依赖安装和构建后，在没有运行中任务时切换本应用服务，再刷新页面。保留上一版本目录用于回退。不要仅覆盖 `public/` 或把重新加载页面当成后端升级，也无需为代码升级修改现有 Tunnel。

服务重启会终止其管理的 App Server 和 PTY；先处理运行中的任务与审批，重启后重新读取会话，不自动重放请求。

## 到期、重新登录和撤销

网关在每个 HTTP 请求和 WS 握手验证身份。WS 消息继续检查连接租约；WS/SSE 最迟在 JWT 到期时关闭，或者五分钟后通过新握手重新授权。正常刷新使用 `AUTH_REFRESH`，到期使用 `AUTH_EXPIRED`。终端连接同样受约束，关闭时其独立 PTY 会结束。

浏览器认证失效后停止连接循环，提示重新登录；草稿只暂存在当前标签页的 sessionStorage。重新登录后读取会话与待审批请求，不自动重发 `turn/start` / `turn/steer`。Access 自动续签成功时可直接恢复传输。网络故障不等同于认证失效。

本地 JWT 校验不能获知所有服务端撤销状态。Cloudflare 文档未保证撤销会终止已建立的 WS；五分钟重新握手只是限制长连接持续时间，不能作为即时撤销保证。真实域名联调必须测量撤销、登出及重新连接行为。[会话管理](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)。

## 实际上线前验收

- 未登录和错误身份无法访问 HTML、API、SSE 或 WS；直连源站不能靠伪造邮箱、代理头或本地密码绕过。
- 正确身份可打开页面、发送一次测试消息、审批并恢复会话；检查 WS 与 SSE 两条链路。
- 到期、撤销、切换网络和 Safari 后台恢复后重新验证，确认没有重复执行或无限重连。
- 验证 WebUI 与 App Server 没有新增公网监听，现有 Tunnel 其他应用正常；代理不缓存 API、SSE 或带身份的 HTML。
- Access 身份与 Codex 模型账户分别展示；认证日志不包含原始 JWT、Cookie 或凭据。

## 回退与备用 Docker

发布准备脚本不修改实际服务。手动执行部署或向导应用会修改所选服务。上线后需要回退时，先撤下该应用的 Tunnel 路由或停止本应用服务，保留其他 ingress；恢复上一版本目录和环境文件。不要在仍有公网路由时把认证模式切回 `local`。

Docker 作为备用方案，隔离验证使用 `/workspace`、模拟 App Server 和独立终端，不调用模型或挂载真实凭据。生产 Compose 不挂载源码；需要显式挂载 Codex 状态、项目与兼容架构的 Codex 可执行文件。当前 Access 配置强制 loopback，模板面向原生部署；Docker 的 Tunnel 网络拓扑尚未作为 Access 部署主线验收，容器不能配置宿主机 systemd；默认镜像不包含 Codex 或 cloudflared。

## 官方依据

- [校验 Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)：验证签名、issuer 和 AUD，处理密钥轮换。
- [Tunnel Origin parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)：Protect with Access 和来源参数。
- 布局与工作区行为以项目自身测试为准，以上链接只作为认证和部署依据。
