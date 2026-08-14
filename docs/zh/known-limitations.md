<p align="center">
  <strong>简体中文</strong> | <a href="../en/known-limitations.md">English</a>
</p>

[← 文档索引](../Index_ZH.md)

# 已知限制

- 注入上下文（plugin source 内容）未做独立展示，随系统提示词并入进度条统计。
- `/model` 实时切换走"会话 fork 续聊"（DSH 无原位换模型 API）：历史原样保留，
  新会话路由到新模型，旧会话仍留在 `/resume` 列表里；选择会写入
  `~/.dsh-cc/model.json`，重启与 `/new` 均沿用（rewind 也保留当前模型）。
- `Ctrl+V` 读剪贴板依赖 PowerShell `Get-Clipboard`：剪贴板被其他进程
  （如 Explorer）短暂锁定时自动重试，持续锁定时静默放弃（显示"剪贴板为空"提示）。
- 退出时以进程退出收尾，不等待 agent 异步落盘（持久化由 persistence 插件兜底）。
- DSH 的 `/permission`（沙箱模式切换）未适配：需要 approval 服务 + 审批 UI，
  当前 TUI 不消费审批流，刻意不挂（`/permissions` 仅说明现状）。
- `/vim` `/connect` `/hooks` `/memory` 为 CC 同名占位：对应能力在 DSH
  侧无等价机制或未在本 leaf 挂载，命令会给出明确说明而非静默。
