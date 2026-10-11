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
- **后端贡献族（`tui.dsh/v1alpha1` `Backend`，接缝十四）为 `alpha`，不承诺**：类型面
  （`BackendSpec`、`validateBackendSpec`、`backendAdmission`）与 conformance
  （`TUI-BACKEND-001`）已可用，但真实准入接线（bundle → registry → picker）是 C 段的
  工作，第三方后端今天还过不了准入（W-1）。
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
- **DSH 内核在本包入口进程内**（独立宿主起的默认，见[配置](configuration.md)）：
  界面先挂、profile 后组合，插件行在首帧**之后**激活，所有 `ctx.tui*` 注册都落到
  已挂载的界面上（主题、面板、状态视图等实时加入）。用户选定的运行时主题在其插件
  注册后生效，此前的首帧用自动检测的配色。根能力守卫与 `dsh --profile` 一致：在首个
  TUI 行之后激活的行，apply 里不能用 `ctx.root` 的能力（`root.plugin`、
  `root.effect`、`root.on` 等）。apply 里等待会拖住组合：耗时工作脱离 apply 启动、
  不要 await。场景的 `TuiSceneProps.channel` 在没有会话撑着时（例如启动会话打开失败，
  见 `startupFailure`）`ready` 为 `false`、`status` 为 `'starting'`。
- **Claude 与 Codex 内核**（轻量 profile；Claude 已验收，Codex 走同一条组合路径但尚未验收）：入口在首帧之后组合本包的行与 profile 声明的
  第三方 bundle，不含 `@deepseek-ai/dsh-base`，规则同上条。`inject` 里有只由 DSH 核心
  提供的服务（`agents`、`llm`、`tools`、`sessionPersistence` 等）的行在这两个内核下保持
  pending；`tui*` 服务都在。

核心仓库保持独立，社区插件各居其位。
生态组织只维护收录与准入规则——不对社区插件的功能、质量或安全性
作任何背书或担保。
插件作者对自己的仓库保有完全所有权，并负责其维护与安全。
