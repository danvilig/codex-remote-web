# Ubuntu AppArmor 沙箱排查

Linux 原生部署应保留 Codex 的命令审批与沙箱。遇到 `setting up uid map: Permission denied` 时，先检查内核 user namespace 配置和 AppArmor 拒绝日志，确认是否由 bubblewrap 的 userns 限制导致；不要仅为启动 WebUI 全局关闭 AppArmor 或沙箱。

仓库提供可选的 [bubblewrap 配置模板](../ops/apparmor/codex-bwrap)。它对 `/usr/bin/bwrap` 开放 user namespace，影响主机上所有对该可执行文件的调用。仅在确认适用于本机后，由管理员备份已有同名配置并安装、加载；WebUI 不自动修改主机安全策略。

```sh
sudo install -o root -g root -m 0644 ops/apparmor/codex-bwrap /etc/apparmor.d/codex-bwrap
sudo apparmor_parser -r /etc/apparmor.d/codex-bwrap
```

卸载使用 `sudo apparmor_parser -R /etc/apparmor.d/codex-bwrap`，再恢复原配置或移除本次创建的文件。无需重启其他服务。

无模型边界测试可运行 `python3 scripts/verify-sandbox.py`，只操作隔离临时目录；确认工作区内写入、工作区外拒绝以及受限网络。结果保存在忽略的 `.artifacts/`。

真实模型/工具测试位于 `tests/live/`，需阅读脚本并显式设置 `CODEX_WEBUI_RUN_LIVE=1`。它们可能调用模型并执行命令，不属于默认 CI；个人日志、截图、凭据和机器记录不得公开。
