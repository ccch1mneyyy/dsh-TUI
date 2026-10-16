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

按当前实现成熟度给出的分级，帮助插件作者评估投入；正式
状态与兼容性协定以[准入与开发指南](../tui-profile/docs/plugin-admission-and-development.md)为准。
**「稳定候选」那一档已随第一版 apiVersion（`tui.dsh/v1alpha1`）纳入冻结的公开面承诺**
（四条承诺见 `tui-profile/CHANGELOG.md` 的冻结条目）；其余两档仍是**成熟度参考**，不构成承诺：

| 分级 | 接缝 |
| --- | --- |
| 稳定候选（形态冻结；如有破坏性变更，先在次版本弃用告警再移除） | 六 设置区块 · 八 全屏场景 · 十 托管对话框 · 十一 状态行 · 十二 键盘快捷键 · 十三 条目渲染器 |
| 实验性（仍可能随 dsh-std / TUI Profile 演进调整） | 九 决策事件 · toast 通知（`ctx.tuiToast`，新增） · **侧栏 Panel（`ctx.tuiPanels`，full 面板与 compact 行，实验性）** |
| 跟随上游（稳定性由 cordis / dsh 官方机制决定） | 一 会话事件 · 二 官方 prompt 槽位 · 三 技能打包 · 四 主题 · 五 system prompt 段 · 七 profile 组合 |

另：

- `@deepseek-harness-tui/dsh-tui/api`（纯类型入口）为实验性公开面。
- **preset 内的行（实验性，接缝七）**：bundle 用 `@deepseek-harness-tui/dsh-tui/preset-patch`
  行改 dsh-TUI 注册的 preset 里某一行的 `config`（例如关掉 `standard` 的
  `compaction-basic` 自动压缩），写法见[准入与开发指南](../tui-profile/docs/plugin-admission-and-development.md)接缝七。
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
- **后端贡献族（`tui.dsh/v1alpha1` `Backend`，接缝十四）的公开面已随第一版 apiVersion 冻结**：类型面
  （`BackendSpec`、`validateBackendSpec`、`backendAdmission`）与 conformance
  （`TUI-BACKEND-001`）已可用，**准入链路（清单 → registry → descriptor）已接线**；
  仍未做的是把已挂载 bundle 的声明接进注册表与 kernel picker，所以
  「装一个第三方后端、重启后出现在 picker 里」这条端到端流程尚未成立。
- **装包本身已在终端里可用（C-4）**：`/plugin install <spec>` 走宿主
  `ctx.pluginManager`，装前给提醒、按来源决定要不要确认信任（嫡系判据是随包发布的
  `tui-profile/feed/first-party.json`，离线可判；验不过一律 fail closed 退回确认），
  `esc` 收起面板；安装进行中会尝试取消，面板等写操作结束后才关闭。取消成功由服务回滚 profile，
  已进入应用阶段而来不及时则等待安装完成。构建脚本被拦时在面板里批准，
  版本不兼容可登记 **精确版本豁免**；登记期间取消会等待当前写入、停止后续登记和重试，
  已写入的豁免保留。**已知缺口**：provenance 只留了「一票否决」的缝、
  没有任何在线校验（宿主服务不暴露这类 API）；服务缺席时由转录给出 CLI 命令与原因
  （不弹面板：没有可驱动的流程），**不在 TUI 内代跑 `dsh plugin`**。
- **生命周期动作已在终端里可用（C-5）**：`/plugin remove <bundle>`、`/plugin enable
  <名称|id>`、`/plugin disable <名称|id>` 走同一套宿主服务。**bundle 与行是两级语义**：
  bundle 是组合层（写 profile 清单的 `dsh.profile.bundles`），行是 patch 的 `disabled`；
  解析顺序是 bundle 名精确匹配优先，其次 `entryId` → `patchId` → 模块名，都不中就给可寻址
  清单、不猜；模块名匹配多行时，列出行 ID 并拒绝写入，须改用具体 ID。**门禁 2**（不能自己杀自己）在 TUI 侧硬拒三类目标——提供本应用的 bundle、
  宿主层 `@deepseek-ai/dsh-base`、本应用自己的行（加载本包模块的行，**或由本包 patch
  插入的行**：实测本包的 patch 插入 17 行，其中 8 行加载的是首方 `@deepseek-ai/*` 模块，
  上游只锁住其中一个）——拒绝时给一行原因且**不发起任何服务调用**，与 HMR 是否生效无关（上游 `stop-profile` 守卫只在没有 HMR 时生效，本 profile 是
  `patchReload: live`，所以那道守卫靠不住）。`enable` 不因门禁 2 被拒：它是复原动作，把手工
  改坏的 profile 关在门外等于封死唯一的 UI 退路；上游自己的锁（`management-required` /
  `unaddressable`）则两个方向都拒，并原样转述上游的理由。**任何 `enable` 与 `remove` 都要确认**（卸载列出它会动的行数与覆盖数），
  `disable` 只对宿主层自己的行问一句（关掉它会卸载本应用注入的服务）。宿主不提供
  已装包的来源证明，本地或 Git 包也能声明嫡系的名称与版本，因此即使命中 feed 也不能免确认。这些动作**没有取消面**：
  服务不提供，Esc 只关面板，写入照旧跑完并（在同一会话里）把结果写进转录。**已知缺口**：
  卸载不删用户数据——`~/.dsh-tui/backends/<id>/`、grants、存储命名空间只**报告一次**，由
  用户自己决定删不删；包内声明读不到时明说「判断不了」，不制造「已清理」的假象。
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
