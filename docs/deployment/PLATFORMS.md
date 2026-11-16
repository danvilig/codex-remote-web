# macOS / Windows

## 本地使用

Release 包包含命令行网关、Bun、Node 和原生终端模块；同时提供 macOS DMG 和 Windows MSI 安装包。macOS 仅 Apple Silicon，最低 macOS 15；Windows 仅 x64，验收基线 Windows 11，需 NTFS 和内置 Windows PowerShell。不包含 Codex CLI、Git 或 cloudflared。

macOS 打开 DMG，将 `.app` 拖入 Applications；双击应用会打开 Terminal 并在网关就绪后打开浏览器。关闭 Terminal/Ctrl+C 停止网关；把 `.app` 移到废纸篓即可移除程序。Windows MSI 安装到当前用户 LocalAppData/Programs，提供开始菜单的启动和浏览器入口，并在“已安装的应用”中卸载，无需管理员权限。两种安装器均不配置后台自启动，不安装或删除 Codex/Cloudflare 凭据、项目、队列和回执。升级前先停止当前网关。

便携归档可解压到用户可写目录（路径允许空格），保留整个文件夹。先核对对应 `.sha256`；macOS 使用 `shasum -a 256 <archive>`，Windows 使用 `Get-FileHash <archive> -Algorithm SHA256`。包未经过 Apple Developer ID/公证或 Authenticode 签名。仅对已核对的可信下载按系统提示单独批准；不全局禁用 Gatekeeper/SmartScreen。

macOS：

```sh
export CODEX_WEBUI_CWD="$HOME/my-project"
./codex-remote-web
```

Windows PowerShell：

```powershell
$env:CODEX_WEBUI_CWD = 'C:\Users\you\my-project'
.\codex-remote-web.exe
```

打开 http://127.0.0.1:8899。默认使用当前用户的 Codex 配置。Windows npm 安装的 `codex.cmd` 通过内置 Node 启动官方 JS 入口，不需要另装 Node 运行 WebUI；原生 `codex.exe` 也可使用。终端默认使用 Windows PowerShell，macOS 使用 zsh。

Windows 私有状态检查使用 NTFS owner/DACL，允许当前用户、SYSTEM、Administrators；拒绝其他账户可访问的目录、链接及无法确认的 ACL。不要在 FAT/exFAT 或多人共享目录保存私有状态。若权限检查失败，检查目录安全属性，不要取消服务端权限检查。Unix 继续校验 uid、mode、真实路径与链接。

## 公网访问

固定域名自动部署向导依赖 Linux user systemd；macOS/Windows 不提供 launchd/Windows Service 自动安装。可手动运行 cloudflared，或将长期部署放在 Linux 上。

1. 在 Cloudflare 创建 Tunnel 和 Access 自托管应用，配置自己的 hostname、Team Domain、应用 AUD，并仅允许指定邮箱。确保 Access 覆盖整个 hostname。
2. Tunnel ingress 指向 `http://127.0.0.1:8899`，网关保持 loopback。
3. 在网关进程配置以下环境变量（以 [配置文档](../CONFIGURATION.md) 中实际名称为准）：

```sh
CODEX_WEBUI_AUTH_MODE=cloudflare-access
CODEX_WEBUI_PUBLIC_ORIGIN=https://your-hostname.example
CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
CODEX_WEBUI_CF_ACCESS_AUD=your-application-aud
CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL=you@example.com
```

使用本机终端环境或私有 `.env`，不要把令牌、Tunnel 凭据或实际身份提交到仓库。启用 Access 模式后，本地浏览器也需要经受保护的公网域名访问；这是认证入口的预期行为，不要通过关闭认证解决。

4. 启动网关及连接器，从公网确认出现 Access 登录、身份验证通过后才能访问，错误邮箱和直接访问源站均被拒绝。参考 [Cloudflare 部署](CLOUDFLARE.md) 配置与回滚。

受保护的无域名临时访问依赖 Unix socket，支持 Linux/macOS；Windows 暂不支持，不会降级为无认证临时隧道。命令行进程停止后网关/临时连接器结束；后台自启动需用户自行配置，本版不提供安装服务按钮。
