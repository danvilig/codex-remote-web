# 配置参考

Bun 从当前工作目录读取 `.env`；生产服务用 systemd 的 `EnvironmentFile` 显式传入环境，不依赖开发目录的 `.env`。路径建议使用绝对路径。当前 `.env` 和 Codex 的配置、凭据不属于版本发布文件。

| 配置 | 默认值 / 含义 |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8899` |
| `CODEX_WEBUI_CWD` | 初始项目，默认应用安装目录 |
| `CODEX_HOME` / `CODEX_AUTH_PATH` | 沿用用户的 Codex 状态/认证来源 |
| `CODEX_WEBUI_APP_SERVER_MODE` | 默认 `auto`：已有本机 daemon socket 时共享，否则使用独立 stdio；`shared` 强制共享、`isolated` 强制独立 |
| `CODEX_WEBUI_APP_SERVER_SOCKET` | 可选的本机 Unix socket 绝对路径；默认 `$CODEX_HOME/app-server-control/app-server-control.sock` |
| `CODEX_WEBUI_PROJECTLESS` | 默认关闭；开启时须明确 Review 根目录 |
| `CODEX_WEBUI_REVIEW_ROOT` | 允许 Review 操作的准确 Git 根目录 |
| `CODEX_WEBUI_DOWNLOAD_ROOTS` | 默认初始项目；Linux 用 `:` 增加目录，不能取消敏感文件限制 |
| `CODEX_WEBUI_ENABLE_TERMINAL` | 默认 `false`，独立 PTY 开关 |
| `CODEX_WEBUI_ENABLE_REVIEW_WRITE` | 默认 `false`，Undo/Reapply 开关 |
| `CODEX_WEBUI_NODE` | 可选的 Node 可执行文件，独立 PTY worker 使用 |
| `CODEX_WEBUI_AUTH_MODE` | `local` 或 `cloudflare-access`，默认 `local` |
| `CODEX_WEBUI_ALLOW_LOCAL_LOOPBACK` | Cloudflare Access 模式下显式允许本机 `localhost`/`127.0.0.1`/`[::1]` 验收；同时检查 loopback socket、Host 和同源 Origin，拒绝代理头与跨站请求。公网域名仍需 Access，默认关闭 |
| `CODEX_WEBUI_PASSWORD` / `CODEX_WEBUI_ACCESS_TOKEN` | 仅本地模式的 LAN 密码 / Basic、Bearer 兼容令牌 |
| `CODEX_WEBUI_AUTH_STORE` | 本地模式管理的密码存储位置 |
| `CODEX_WEBUI_PUBLIC_ORIGIN` | Access 模式必填，准确 HTTPS Origin，无路径和结尾 `/` |
| `CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN` | Access 模式必填，`TEAM.cloudflareaccess.com` 主机名 |
| `CODEX_WEBUI_CF_ACCESS_AUD` | Access 模式必填，当前自托管应用的 Audience Tag |
| `CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL` | Access 模式必填，唯一允许访问此工作区的邮箱 |
| `PLAYWRIGHT_EXECUTABLE_PATH` | 可选浏览器路径，默认使用 Playwright 安装的 Chromium |
| `CODEX_WEBUI_NTFY_TOPIC` / `CODEX_WEBUI_NTFY_URL` | 可选任务完成通知；仅配置 Topic 后启用 |

Access 模式缺少必填项、Origin 格式不正确、Team Domain 格式不正确或监听非 loopback 时启动失败。该模式不读写本地密码凭据，不允许密码初始化、密码登录或本地免登录。

## 与 Codex Desktop / CLI 共享会话

新版 Codex Desktop/CLI 使用本机共享 App Server。WebUI 默认检测同一 Codex home 的 daemon socket，并通过 Unix WebSocket 加入原生服务，避免再次启动写入同一会话的独立进程。两端使用同一会话 ID、原生 resume/start/steer 与事件流；不会复制会话或移除写入锁。停止 WebUI 只断开自己的连接，不停止共享 daemon 或它的任务。原生传输参考 [App Server 文档](https://developers.openai.com/codex/app-server)。

已有共享服务时推荐显式配置 `CODEX_WEBUI_APP_SERVER_MODE=shared`，必要时设置 `CODEX_WEBUI_APP_SERVER_SOCKET`，使首次启动没有 daemon 或连接异常时也不会另起写入进程。共享服务不可达时显示连接失败并重连，不降级为独立进程；需要先由 Desktop/CLI 启动原生 daemon，WebUI 不代为重启或修改它。原生 Unix 传输仍属实验能力，需要相容版本。独立 stdio 服务启动后不会在运行中自动迁移到后来出现的 daemon；若另一进程已经占用会话，应改为共享模式并重启该 WebUI，再继续使用。

共享服务的 Codex 账户与原生配置由该服务管理；WebUI 的 HTTP/Access 认证仍独立生效。容器默认使用独立模式时不能同时写宿主机 Desktop 正在持有的同一会话；本轮不自动挂载宿主机 socket，也不支持跨主机绕过原生写入锁。

项目浏览范围为用户主目录和 `CODEX_WEBUI_CWD` 指定的初始项目，支持 `/tmp`、`/srv` 或容器 `/workspace` 等主目录之外的位置。额外项目根目录不授权其父目录或相邻目录，目录内符号链接仍需满足真实路径范围检查。Customize、文件搜索、工作树、项目上下文与独立终端使用同一范围；下载敏感文件限制及 Review 独立根目录继续生效。

`GET /api/auth/status` 保留原有 `authenticated`、`setupRequired` 和 `passwordRequired`，新增 `mode`、`expiresAt`。Access 模式还返回已验证身份的邮箱和同源 `loginUrl`；未授权返回 401/403 和 `AUTH_REQUIRED`、`AUTH_EXPIRED` 或 `AUTH_FORBIDDEN`，不返回 JWT。密码初始化/登录接口在 Access 模式返回 404。

Access JWT 只从 `Cf-Access-Jwt-Assertion` 读取，校验 RS256 签名、issuer、audience、exp/iat/sub/email 及配置的邮箱。不从浏览器 cookie、邮箱头、Basic/Bearer 或 forwarded 头推断 Access 身份。允许的 Host 和浏览器 Origin 都以 `PUBLIC_ORIGIN` 为准，代理需保留公网 Host。

## 网页配置向导

`bun run setup:cloudflare` 启动独立 loopback 配置页面；已有本地工作区可从设置页进入。该配置页面不经过公网 Access 身份入口，另有严格的本机 Host/Origin/代理头检查、一次性启动凭证、HttpOnly 会话及 CSRF 校验，仅提供部署管理，不提供模型或项目执行接口。

管理 API Token 验证后保存到 `~/.config/codex-remote-web/management-token.json`（目录 `700`、文件 `600`），只供本机控制面使用，不返回浏览器、不写入部署记录或 WebUI 运行时环境。锁定或空闲到期释放进程内客户端，后续解锁管理时从私有文件恢复；可在管理页更换或删除已保存令牌。旧版本未保存的 Token 需在升级后输入一次。自动部署的参数、私有清理记录分别写入 `~/.config/codex-remote-web/remote.env` 和 `setup-state.json`，权限 `600`。`CODEX_WEBUI_SETUP_PROBE` 为自动生成的本机就绪探测凭证，不是 Cloudflare Token，不应手工填写或公开。

详见 [网页接入向导](deployment/SETUP.md)。


## 网页终端

独立 Shell 默认关闭。部署所有者可在运行时环境中显式设置 `CODEX_WEBUI_ENABLE_TERMINAL=true` 后重启网关。网页不会自行开启此权限；终端仍需经过与聊天一致的身份和 Origin 校验，Shell 以网关服务用户身份运行。使用网页向导部署时，环境文件位于 `~/.config/codex-remote-web/remote.env`，重启命令为 `systemctl --user restart codex-remote-web.service`；不需要修改 Tunnel。关闭终端标签会结束 Shell；仅收起面板不会主动终止 Shell，但认证到期、网络中断或网关重启可能结束它。

向导管理的环境文件建议保持原样。也可用 `systemctl --user edit codex-remote-web.service` 添加用户服务覆盖：

```ini
[Service]
Environment=CODEX_WEBUI_ENABLE_TERMINAL=true
```

保存后执行 `systemctl --user daemon-reload` 和上述重启命令。若环境文件已显式设置同名变量，应修改环境文件中的值；systemd 的 EnvironmentFile 优先于 Environment。


## 可编辑的 Codex 设置

“通用 → 语言”提供跟随系统、简体中文和 English，立即生效并保存在当前浏览器；设置搜索同时接受中英文名称和选项关键词。原语言存储键保持不变。

“配置”页可以保存用户级审批策略、沙箱模式、工作区沙箱网络访问、网页搜索、推理摘要和回复详细程度。“个性化”页保存记忆生成/使用开关，以及附加开发者指令（`developer_instructions`，最多 16,000 字符）。已有较长指令不会被截断后覆盖，编辑器会提示直接编辑配置；已有 AGENTS.md 保留。两个页面共享待保存的用户配置更改，点击任一保存按钮会提交所有更改。

保存设置通过 App Server 的 `config/batchWrite` 完成，包含版本校验。保存冲突时保留输入，需确认放弃更改并重新加载。新配置用于后续新建会话，已有会话保持原有权限；项目和托管层可能覆盖用户默认值。网页不直接写入任意配置文件，不显示 provider 或凭据。

输入框原来的“请求审批”等模式继续显式控制执行权限。要使用所保存的原生权限默认值，点击“配置 → 在输入框中使用”，或在权限菜单选择“Codex 配置”，然后新建会话。原生“不请求审批”和“完全访问”保存前需要确认。独立网页终端仍只由服务端开关控制。

记忆生成和使用分别对应 `memories.generate_memories`、`memories.use_memories`；关闭不会删除已有记忆。本轮不实现 Desktop 的工具辅助记忆开关或记忆删除功能。字段含义依据[官方配置参考](https://developers.openai.com/codex/config-reference/)，并用本机 Codex 在临时目录验证保存及新会话权限。

“已归档的对话”支持搜索、按项目/类型筛选和取消归档；分页时筛选仅作用于已加载的对话。恢复后重新读取侧边栏，不自动打开或执行聊天。“存储”统计 Codex 目录中的逻辑文件大小：不等同于磁盘实际占用、不统计目录外项目、不单独拆分数据库里的子代理空间；达到扫描上限或无法访问文件会提示部分统计。“工作树”显示当前项目登记的 Git 工作树，可显式创建本应用托管的新工作树；只有干净、无占用且归属明确的托管工作树才能在预览确认后移除，分支保留，不自动删除。当前项目的 AGENTS.md 在“个性化”中提供预览编辑和修订冲突检查，已知继承指令仅显示只读元数据。


无域名临时访问不需要新增 `.env` 认证参数。在完整本地设置页填写邮箱启动即可；内部 `quick-tunnel` 认证只存在于私有 Unix socket，不能通过 `CODEX_WEBUI_AUTH_MODE` 将普通 TCP 服务切换为此模式。依赖现有 `PATH` 中的 cloudflared、Node.js（可用 `CODEX_WEBUI_NODE` 指定）和 Unix socket。临时源站共享当前 WebUI 的 Codex/终端权限；没有另行启用终端或扩大项目权限。无需 sudo、systemd、Cloudflare API Token 或管理凭据。独立的 `quick-tunnel.lock` 位于用户私有配置目录中；运行地址和邮箱不写入固定域名部署记录。

## 计划任务与本机资源

Scheduled 在网关后台执行：页面关闭不影响调度，但 WebUI 和其 App Server 必须保持在线。任务默认保存为暂停；启用自动执行或立即运行需要确认。支持单次、每小时、每 24 小时、每 7 天的固定间隔（不是日历 cron，夏令时切换不保持本地钟点）。页面按浏览器时区显示，服务器保存 UTC。

任务与最近最多 200 条运行记录保存于 `$CODEX_HOME/remote-web-scheduler/schedules.json`（默认 `~/.codex/remote-web-scheduler/schedules.json`），目录/文件权限为 700/600，其中包含任务指令与项目路径，请纳入私有数据备份。最多 30 个任务，同一存储串行执行；默认只读，也可选择工作区可写，原生审批策略固定为 `on-request`。需要审批时任务等待，可从运行记录打开会话处理。停止运行会发送原生中断，暂停只影响后续执行。进程重启/桥接断开或无法确认提交结果时中断该次运行、暂停对应任务，不自动重放；超过一分钟的错过执行记为 Missed。恢复前请检查会话。

同一个 Codex home 应使用一个主要 WebUI 网关负责调度和审批。新版提交、持久队列、附件绑定/清理及开发工具变更通过 Bun `bun:sqlite` 的操作系统事务锁串行协调；锁数据库使用稳定 inode，不靠删除过期 PID 标记获取占用。该机制依赖指定 Bun 运行时和本机本地文件系统，不支持跨主机、共享网络文件系统或未共享同一锁空间的隔离容器；审批请求仍属于派发它的原生连接。临时公网入口复用原网关与调度器。

**升级不能混跑新旧锁协议。** 正式切换前，停止共享同一 `CODEX_HOME` 的所有旧 WebUI 网关，包括独立本地调试与公网网关，再启动统一新版。应在网关全部停止后备份私有提交回执、队列和 SQLite 锁数据库及相关 sidecar，并保留旧锁标记；不要手工删除、重命名、替换 `.sqlite`、journal/WAL/SHM 或锁文件来解除占用。故障后使用状态核对和显式继续，回退也不能清空去重记录。本轮开发验收不重启正在运行的公网 WebUI 或 Tunnel。

右侧 Files 自动跟随当前会话目录（未选择项目时使用主目录），与 Images 的项目图片使用允许的本机文件范围，跳过隐藏/敏感目录、凭据名、符号链接和常见构建产物；扫描最多 5,000 个条目/1.5 秒，每页 100 项。文本预览上限 256 KiB，下载沿用原有敏感路径与文件根限制。Images 的“最近会话图片”按批次扫描当前加载的会话，每个会话读取最近 20 个回合，仅展示本机、上传和内嵌图片；不提供云端资料库或图片生成。

Library 展示项目上传和近期会话中分享的附件，支持当前会话/项目筛选、搜索、预览、下载及引用；不是服务器目录浏览器。历史附件按当前加载的最多 20 个会话、每个最近 20 个回合扫描，不能视为完整历史索引。

输入框「+」支持上传文件/文件夹、从剪贴板粘贴文件、拖放，以及通过 Files 添加服务器文件。单个文件上限 20 MiB，一次/一条消息最多 20 个附件，存储总量上限 200 MiB/1,000 项；文件夹逐个上传文件，不保留目录结构。上传保存在 `$CODEX_HOME/remote-web-attachments`，目录/文件权限为 700/600，备份时按私有工作区数据处理。移除草稿中的附件只取消本次引用，不删除持久文件。“设置 → 存储 → 预览清理”可检查并确认清理符合条件的旧数据：上传需超过保留期、没有会话绑定且不被队列/待确认提交引用。执行前重新校验，且与上传/绑定共用私有锁；另可清理本服务专属的过期缓存/日志。原生会话、记忆、数据库、凭据、项目文件及其他应用日志不属于清理目标，缺少引用核对能力时拒绝清理。服务通过不透明附件 ID 提供受认证的预览与下载，不放宽普通文件接口的私有目录限制。文本预览上限 256 KiB，SVG/HTML 等主动内容强制下载，不内联执行；仅识别 PNG/JPEG/GIF/WebP 的栅格图片输入。

上传仅保存文件，点击发送才调用模型：普通文件以路径加入上下文，图片同时通过原生 `localImage` 输入；文件读取和模型行为仍受当前 Codex 权限限制。不选择项目时附件属于主目录。附件引用保存在当前标签页草稿；上传中切换会话时归入原草稿，失败/重新登录/刷新不自动重发执行请求。

Customize 使用 Codex 原生插件目录和安装/卸载、版本化启停接口。可安装受信任的本机技能文件夹到 `$CODEX_HOME/skills`，必须包含合法 `name` 的 SKILL.md，最多 500 项/10 MiB，不复制隐藏文件/密钥，不执行安装脚本。启停使用原生 skills 配置；仅可删除直接位于用户/项目技能根目录的独立技能，内置或插件托管技能保留其归属。插件账户连接与 OAuth 仍需 Codex 原生支持。变更影响后续使用，不承诺正在运行的回合热更新。
