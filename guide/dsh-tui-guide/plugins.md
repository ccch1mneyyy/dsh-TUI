# 插件开发指南（口径见 TUI Profile）

[文档索引](README.md) · [English](plugins.en.md)

> 本文档已与仓内 TUI Profile（`tui-profile/`）的准入规范整合，请阅读：
> [终端交互生态插件准入与开发指南](../tui-profile/docs/plugin-admission-and-development.md)

以下生态入口与接缝稳定性分级仅为速览保留；正式状态与兼容性协定
以准入与开发指南为准。

## 生态入口

- **接口与兼容性协定 / 插件开发指南**：
  [终端交互生态插件准入与开发指南](../tui-profile/docs/plugin-admission-and-development.md)
  （准入规范、接缝、契约、验证清单）。
- **生态组织**：
  [dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem)
  （社区插件与模板的家）。
- **模板仓库**：
  [plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template)
  （从模板起步，5 分钟出一个插件）。
- **参考实现**：`dsh-working-activity`（实时工作状态行：TUI 槽位 +
  `workingActivity` 会话投影双出口）。

## 接缝稳定性参考

按当前实现成熟度给出的**非正式**分级，帮助插件作者评估投入；正式
状态与兼容性协定以[准入与开发指南](../tui-profile/docs/plugin-admission-and-development.md)为准：

| 分级 | 接缝 |
| --- | --- |
| 稳定候选（形态冻结；如有破坏性变更，先在次版本弃用告警再移除） | 六 设置区块 · 八 全屏场景 · 十 托管对话框 · 十一 状态行 · 十二 键盘快捷键 · 十三 条目渲染器 |
| 实验性（仍可能随 dsh-std / TUI Profile 演进调整） | 九 决策事件 · toast 通知（`ctx.tuiToast`，新增） · **侧栏 Panel（`ctx.tuiPanels`，full 面板与 compact 行，实验性）** |
| 跟随上游（稳定性由 cordis / dsh 官方机制决定） | 一 会话事件 · 二 官方 prompt 槽位 · 三 技能打包 · 四 主题 · 五 system prompt 段 · 七 profile 组合 |

另：

- `@deepseek-harness-tui/dsh-tui/api`（纯类型入口）为实验性公开面。
- **侧栏 Panel（实验性，§18）**：`ctx.tuiPanels.register({ apiVersion: 1,
  id, title, icon?, component | compact })` 向右侧栏注册面板（宿主自动加
  `<pluginId>:` 前缀；每插件 ≤4 个、全局 ≤32 个；`open()` 限速每 5s 一次；
  连续崩溃 3 次本会话禁用）。full 面板（`component`）与 compact 行
  （`compact`，1–3 行紧凑呈现）两个渲染槽中，**本阶段 compact 仅校验
  descriptor、尚不挂载渲染**；`sendToChat` 需要 `panels.chat.attach`
  授权（后续版本），当前恒返回 `false` 并提示一次。类型见
  `@deepseek-harness-tui/dsh-tui/panels` 与 `./api`。
- `@deepseek-harness-tui/dsh-tui/test-utils` 子路径与
  `ctx.tuiPluginHost.grants.corrupt` 已随 adapter 分层重构（#705）移除。
- `grants` 收窄为 `HostGrantFacade`，迁移细节见该 PR。
- `TuiSceneProps.channel`（`ChannelUi`）上的 `minimal` / `setMinimal()` 已更名为
  `minimalUi` / `setMinimalUi()`；旧名保留为 **deprecated 别名**，读写同一个
  「极简界面」开关，既有全屏场景插件不受影响。该开关只精简界面装饰，与内核
  Agent preset `minimal`（极简模式）无关。
  **移除条件（可判定）：v0.13**——更名与弃用别名首次随 v0.12.0 发布，
  因此先保留一个已发布的次版本弃用窗口。届时对场景插件消费面
  （本仓库 `src/**` 的再导出，以及 dsh-tui-ecosystem 组织下经
  `TuiSceneProps.channel` 取用该端口的插件）做一次 `.minimal` / `.setMinimal(`
  扫描：零调用方即在 v0.13 删除这两个别名与 `ui-policy.ts` 里的
  `'setMinimal': 'mutate'` 行；仍有调用方则在同一版本内完成迁移，不再顺延。

核心仓库保持独立，社区插件各居其位。
生态组织只维护收录与准入规则——不对社区插件的功能、质量或安全性
作任何背书或担保。
插件作者对自己的仓库保有完全所有权，并负责其维护与安全。
