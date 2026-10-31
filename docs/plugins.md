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
| 稳定候选（形态冻结；如有破坏性变更，先在次版本弃用告警再移除） | 六 设置区块 · 八 全屏场景 · 十 托管对话框 · 十一 状态行（+ 底栏字段 `setField`） · 十二 键盘快捷键 · 十三 条目渲染器 |
| 实验性（仍可能随 dsh-std / TUI Profile 演进调整） | 九 决策事件 · toast 通知（`ctx.tuiToast`） · **十五 侧栏 Panel（`ctx.tuiPanels`，full 面板与 compact 行）** · **十六 会话数据（`ctx.tuiSessionData`，新增）** · **插件 UI 套件（可视化原语、`ui.format`、分类色板 `chart1`–`chart8`，新增）** · **面板/场景共用的 `host` 动词与深链参数（场景只是加了 `host`，其余形态仍冻结）** · **插件命令限定名 `/<pluginId>:<name>`（新增）** |
| 跟随上游（稳定性由 cordis / dsh 官方机制决定） | 一 会话事件 · 二 官方 prompt 槽位 · 三 技能打包 · 四 主题 · 五 system prompt 段 · 七 profile 组合 |

另：

- **底栏插件字段（接缝十一的加法）**：`ctx.tuiStatus.setField(key, text,
  options?)` 把一段键控文本并进底栏既有的左右组（`left-tail` /
  `right-head` / `right-tail` 三槽，可选 hover 详情与全屏点击），不新增行；
  `/settings → statusBar.pluginFields` 可一键关掉全部插件字段，另有
  `statusBar.pluginFieldsOrder` 让用户逐字段启停、按「槽组」排序：
  `build,ci;git;pet` 三组即三槽，**列进名单的字段跟随所在组**（覆盖插件声明的槽）。
  用户把名单固定后，之后新注册的字段默认不出现，直到用户勾选。契约、规则表与
  示例见[准入与开发指南](../tui-profile/docs/plugin-admission-and-development.md)接缝十一「底栏字段」。
- `@deepseek-harness-tui/dsh-tui/api`（纯类型入口）为实验性公开面。
- **preset 内的行（实验性，接缝七）**：bundle 用 `@deepseek-harness-tui/dsh-tui/preset-patch`
  行改 dsh-TUI 注册的 preset 里某一行的 `config`（例如关掉 `standard` 的
  `compaction-basic` 自动压缩），写法见[准入与开发指南](../tui-profile/docs/plugin-admission-and-development.md)接缝七。
- **侧栏 Panel（实验性，接缝十五）**：`ctx.tuiPanels.register({ apiVersion: 1,
  id, title, icon?, component | compact })` 向右侧栏注册面板（宿主自动加
  `<pluginId>:` 前缀；每插件 ≤4 个、全局 ≤32 个；同一面板的 `open()` 5s 内至多一次；
  60 秒内崩溃 3 次本会话禁用）。插件带已准入的 `dsh-plugin.json` 时前缀是它的 id
  （简单 id 或 `com.example.echo` 式 namespaced id），面板 id 稳定、勾选能跨重启保存；
  没有 manifest 的包只拿到一次性的 `session:actN:` 前缀（`ctx.inject` / `ctx.plugin` 嵌套
  fiber 沿用最近一个已准入祖先的身份）。compact 行（`compact`，1–3 行）**已挂载渲染**：
  分栏没有显示时（侧栏收起、inline、内容区窄于 93 列、整页编辑器）画在提示框上方、富状态
  视图之后，合计 3 行，按 `sidePanel.panels` 启用集合取（只有 `compact`、没有 `component` 的面板不进分栏
  标签页，分栏显示时它的行照样留着）；compact 组件也拿到 `snapshot()`
  （与面板同一份快照，含 `usage`，不含随每个流式增量跳动的 `version`）；`opened` / `closed` / `focused` / `blurred` 事件经 `subscribe` 投递；
  键盘经 `host.onKey`（Ctrl/Alt 组合不进面板）。`host.snapshot().usage` 给出与底栏
  `ctx` 同源的占用、组成、token 与花费。`sendToChat` 需要 `panels.chat.attach`
  授权（后续版本），当前恒返回 `false` 并提示一次。类型见
  `@deepseek-harness-tui/dsh-tui/panels` 与 `./api`。
  面板正文可用 `ui.Markdown` / `ui.CodeBlock`（实验性，收窄包装）：前者收一段
  markdown 字符串，后者收原始代码与可选语言标签（围栏长度、语言标签清洗与
  语法高亮由宿主负责）。`ui.Markdown` 与聊天正文同一口径：宿主会先剥离
  `<commit_analysis>` / `<context>` / `<function_analysis>` / `<pr_analysis>`
  标签块（代码围栏内也会）；`ui.CodeBlock` 不做这层剥离，原始代码逐行保留。
  四条限制：① **首帧无语法高亮**（`cli-highlight` 异步
  加载完成后补上，与宿主正文同理）；② 面板**不可选择/复制**（侧栏整列
  `noSelect`，复制能力位另议）；③ 块级 `$$` 公式**跟随用户的 `mathRendering`
  偏好**（终端支持图形时走图片），行内公式不走图片、仍排成 Unicode；④ 正文
  内容**保持不变**才能命中 `React.memo`（字符串按值比较，内容相同的新字符串
  一样命中；只有内容变化才重跑格式化与排版，分词按内容缓存）。
- **插件 UI 套件（实验性）**：场景与侧栏面板的 `ui` 带整套可视化原语——`StackedBar`、
  `Sparkline`、`Meter`、`ColumnChart`、`Heatmap`、`Legend`、`Table`，以及 `ui.format`
  （`tokens` 与底栏上下文条读数逐字相同，`duration` 从 1 秒起与宿主的时长逐字相同）、
  `ui.seriesColor(i)`、`ui.hashSeries(name)`；场景的 `ui` 另带与面板同一份收窄的
  `ui.Markdown` / `ui.CodeBlock`，同一个视图在两处用同样的写法渲染富文本；富状态视图
  （`tuiStatus.registerView`）与面板 compact 行只拿单行子集（`StackedBar` / `Sparkline` /
  `Meter` / `format` / 两个取色函数）。原语受控、无状态、不读键盘，宽度按显示单元计，颜色只收
  分类色槽（数字）或主题键，字面色被拒绝；分类色来自主题新增的 `chart1`–`chart8`
  （见[主题系统](themes.md)）。契约与逐个原语的行为见准入与开发指南「插件 UI 套件」。
- **共用宿主动词（实验性）**：侧栏面板的 `host` 与场景 props 新增的 `host` 共享
  `openSession(id)`（走 `/resume` 同一路径，每插件 2s 一次）、`openFile(path, { line? })`
  （宿主只读文件预览 `dsh-tui:file-preview`，插件不能注册或替换它）、`copy(text)`（每个插件
  activation 每秒至多 1 次，adapter shadow 模式下一律拒绝，被拒返回 `false`）、`openScene` /
  `openPanel(id, params?)` 与 `useParams()` 深链参数（JSON，≤16 KiB、≤32 层、拷贝至多访问 65,536 个属性，冻结深拷贝；对
  正在显示的自己的面板/场景再次打开只更新参数，面板这样做不计入 5s 限速、不改焦点）、`toast`；
  场景的 `host` 另有 `snapshot()` 与 `storage`。场景 props 只加不改。重注册一个正在显示的面板
  会给新注册重放 `opened`（有焦点时再加 `focused`）；compact 组件只在宽度、角标或它读过的快照
  输入变化时重渲染。
- **会话数据（实验性，接缝十六）**：`ctx.tuiSessionData.watchProjection(key)` 订阅当前屏
  会话的一个投影值（绑定读基线、跟随 `/new` `/resume` rewind、忽略后台会话推送），
  `watchSessionList({ projections? })` 读宿主会话列表（与 Web 列表同源，只取宿主已持有的
  投影值；`refresh()` 合并为每个 watch 每秒至多开始一次读取，频繁调用是安全的）；watch 随
  activation 释放。预算按 watch 计：每 activation ≤8 个投影 watch、
  全局 ≤64 个不同 key、每 activation ≤2 个列表 watch。非 DSH 后端恒读 `undefined` / `[]`。
- **插件命令限定名（实验性）**：内置命令永远占裸名；经 `ctx.tuiPluginHost.registerCommand`
  注册、与内置命令同名的插件命令改以 `/<pluginId>:<name>` 出现在 `/` 菜单、补全与 Help 并可
  执行（参数、图片附件、`commands.invoke` 授权与裸名同一路径）；`pluginId` 是已准入
  manifest 的 id。没有归属或没有 manifest 的命令被遮蔽时不可达，`/plugin` 诊断会列出它们。
- **一个插件声明多个命令**：每个 facet 仍只能有一条 `commands.invoke`，scope 二选一——单命令写
  精确 id，多命令写本插件的命名空间通配 `<id>.*`（覆盖 `contributes.commands` 里全部 `<id>.`
  开头的命令）；`*`、别的插件前缀与第二条 `commands.invoke` 在准入拒绝。授权文件里同样可写
  `<id>.*`：宽 deny 关掉整个命名空间，窄 deny 胜过宽 grant。规则表见准入与开发指南的
  `commands`（C-041）段与 `TUI-PKG-002`。
- **插件 Config 生成页（接缝六的补充）**：没有注册 `tuiSettingsSections` 区块的第三方插件，
  其 Config 里声明为 `.volatile()` 的字段会在 `/settings` 的「插件」页自动生成一张卡片（DSH 0.2
  宿主的设置服务描述表单，写入当前 profile 的 `cordis.patch.yml` 覆盖行、即时生效）；其余字段
  只读并提示到 `cordis.patch.yml` 中修改。插件自己为同一命名空间（0.2 宿主上即 loader 行 id）
  注册的区块优先；`settings.configure({ auto: false })` 关掉生成页。控件映射与上限见准入与开发
  指南接缝六「插件 Config 生成页」。`TuiSettingsField` 新增可选 `readOnly`（只显示、不可编辑）。
- **身份继承加固**：嵌套 fiber 继承所属插件身份时沿 Cordis 创建 fiber 时记录的父链查找，改写
  `ctx.fiber.parent` 借不到别的插件的身份；嵌套调用方可把所属插件的 ctx 作末位 `identity`
  传入，兄弟、无关插件、组合根与后代 ctx 一律拒绝。
- `@deepseek-harness-tui/dsh-tui/test-utils` 子路径与
  `ctx.tuiPluginHost.grants.corrupt` 已随 adapter 分层重构（#705）移除。
- **后端贡献族（`tui.dsh/v1alpha1` `Backend`，接缝十四）的公开面已随第一版 apiVersion 冻结**：类型面
  （`BackendSpec`、`validateBackendSpec`、`backendAdmission`）与 conformance
  （`TUI-BACKEND-001`）已可用，**准入链路（清单 → registry → descriptor）与装链路都已接线**：
  启动时扫 profile 声明的已装 bundle（`dsh.profile.bundles`——`/plugin install` 与 `dsh plugin add`
  都写它），按**实际 ESM 入口最近的包根**读 `dsh-plugin.json`，校验 + 准入后注册，于是
  「装一个第三方后端、重启后出现在 picker 里」成立。三条边界：这份扫描**早于**后端选择的注册表成员判定
  （Config Schema 只校验语法，独立入口的完整/轻量组合由装配后的最终内核决定）；后端实现从包入口模块的 `backend` 导出取
  （`backendExport` 是 in-tree 私有项，声明里写不了别的导出名），模块只在真的选中时才 import；
  装完**不重启**仍然不会出现在 picker 里——那不是承诺。
  当前每个 bundle 只接一个 `Backend` 声明；清单须通过规范投影（含贡献身份唯一性），handler 的 id 必须与声明一致。
  等待授权的条目仍注册身份，但不探测、不加载；启动参数或配置显式指定它也会报错。
- **装包本身已在终端里可用（C-4）**：`/plugin install <spec>` 走宿主
  `ctx.pluginManager`，装前给提醒、按来源决定要不要确认信任（嫡系判据是随包发布的
  `tui-profile/feed/first-party.json`，离线可判；验不过一律 fail closed 退回确认），
  `esc` 收起面板；安装进行中会尝试取消，面板等写操作结束后才关闭。取消成功由服务回滚 profile，
  已进入应用阶段而来不及时则等待安装完成。构建脚本被拦时在面板里批准，
  版本不兼容可登记 **精确版本豁免**；登记期间取消会等待当前写入、停止后续登记和重试，
  已写入的豁免保留。**已知缺口**：provenance 只留了「一票否决」的缝、
  没有任何在线校验（宿主服务不暴露这类 API；条款与六档 evidence 的写法见
  [准入与开发指南](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/tui-profile/docs/plugin-admission-and-development.md)的「供应链证据与
  provenance」）；服务缺席时由转录给出 CLI 命令与原因
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
  服务不提供，Esc 只关面板，写入照旧跑完并（在同一会话里）把结果写进转录。
- **授权跟着生命周期走**：`/plugin install` 的确认页列出包内声明的权限，`Enter` 先写授权
  再安装（失败回滚）；registry 包在装上后才读得到声明，装成功后补一个「授予」步骤。
  `enable` 在写入 profile 前按声明授予，`disable` 在关闭后撤销该组件声明过的权限，`remove`
  在卸载后删除该组件的 `grants`/`denies` 条目——授权以 component id 为键，留着会被后来
  复用同一 id 的包静默继承，因此重新安装后需要再授权一次。写授权失败不阻塞安装或启用，
  只会在转录里说明；授权矩阵仍可直接手改（`~/.dsh-tui/extension-grants.json`，写入器与
  读取器共用同一套严格解析，损坏即拒写）。写入会取同目录的 `extension-grants.json.lock`
  （与 profile 原子写同一把锁），多实例的读-改-写因此串行，不会丢掉 revoke/forget。
  终端高度不足以放下一行权限时，清单折成
  计数或把计数放进按键提示；包名与按键提示始终保留。
  **已知缺口**：卸载不删用户数据——`~/.dsh-tui/backends/<id>/`、存储命名空间与效果台账
  保留并按来源逐项**报告一次**，由用户自己决定删不删；包内声明读不到时明说「判断不了」，
  不制造「已清理」的假象。
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
