<p align="center">
  <strong>简体中文</strong> | <a href="../en/agent-presets.md">English</a>
</p>

[← 文档索引](../Index_ZH.md)

# Agent preset（四种官方 Agent 模式）

接入 DSH 官方的 preset 名册（`@deepseek-ai/dsh-agent-presets`）

| id | 名称 | 说明 |
|---|---|---|
| `standard` | 标准模式（默认） | 功能完整的编码 Agent（编辑、Shell、检索、Skills、计划、目标、子代理、工作流） |
| `code` | PTC 模式 | 标准能力 + Code Mode SDK 呈现工具，模型用一个 TypeScript 程序组合多步操作 |
| `minimal` | 极简模式 | 仅持久 bash + str_replace_editor 双工具，无 compaction |
| `cordis` | 创造模式 | 标准能力 + 运行时检查/插件实验工具，用于创作自定义 preset |

用法：

- `/preset` 打开选择器（显示中文名与说明，✓ 为当前会话 preset）；
- `/preset <id>` 直接切换；`/preset status` 查看当前状态；
- **锁定规则（官方）**：已经产生对话的会话不可切换——此时选择会保存为
  默认 preset，`/new` 或下次启动生效；空白会话立即原地切换（工具集实时
  变化，切换事实写入会话日志，resume/fork 后仍是新 preset）；
- 默认 preset 持久化在 `~/.dsh-cc/agent-preset.json`；优先级：
  cordis.yml 的 `preset` 键（或 `CC_TUI_PRESET` 环境变量）＞ 偏好文件 ＞
  名册默认（standard）；
- resume 旧会话总是恢复其自身日志记录的 preset，不受当前默认影响；
- `/model` 的选择持久化在 `~/.dsh-cc/model.json`；优先级与 preset 一致：
  cordis.yml 的 `provider`/`model` 键 ＞ 偏好文件 ＞  harness 默认
  （deepseek-official / deepseek-v4-flash）；resume 旧会话恢复其自身日志
  记录的路由（request/header），不受当前偏好影响；
- 用户自创 preset：把目录（含 `agent.cordis.yml`）放进
  `~/.dsh/.agent-presets/`，名册即时发现，`/preset` 选择器直接可见。

实现说明：preset 文件由官方 CLI 附带（profile-boot 发现组合里有
`agent-presets` 行就自动注入 shipped 根目录），本包不自拷；原 host 层的
模型侧行（tool-bash/tool-web/subagent 系/compaction-basic 等 24 行）随
preset 化在 bundle patch 中禁用（与官方 dsh-web-app 同款处理），因此
`CC_TUI_COMPACT_RATIO`/`CC_TUI_COMPACT_RETAIN` 与 subagent 深度 1 的
cc-tui 定制随之退役（preset 拥有自己的 compaction/delegation 配置）。
