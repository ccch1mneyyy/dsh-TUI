# 插件 UI 基建设计记录：可视化套件、会话数据与导航

让富界面插件能在终端里交付完整体验的通用基建。第一个消费者是第三方插件
[dsh-context](https://github.com/bowenliang123/dsh-context)（上下文可视化），但本文不为任何单个插件做专门适配：
dsh-TUI 只提供可复用的表面、原语、数据通道与导航动词，插件自己的终端界面由插件随包交付。

**状态**：设计记录。一期、二期已实现（全部为**实验性**公开面，与 `tuiPanels` 同档）；三期的
内建迁移（dogfooding）已落地，`watchSessionList` 提前在一期实现。同批还补了四项相邻基建：
插件 Config 生成页、多命令插件的准入、身份继承加固、场景 `ui` 并入面板的 `Markdown` /
`CodeBlock`（见[同批补充的基建](#同批补充的基建)）。本文先写动工前的设计，再在
[实现记录](#实现记录与设计的偏差)里登记落地时的取舍；对插件作者的权威契约在
[准入与开发指南](../tui-profile/docs/plugin-admission-and-development.md)
（接缝六、八、十一、十五、十六，`commands`（C-041）段与「插件 UI 套件」），两者冲突时以指南与代码为准。

**边界**：不在 dsh-TUI 里读第三方插件的私有投影格式，不重实现插件的计算，不扩大面板快照的策展范围。
插件经自己的 `ctx` 读自己的数据；宿主负责「当前屏会话」的生命周期、渲染原语与跨表面一致性。

## 动工前的现状

插件当时有三种可渲染表面，各自一套 UI kit 与宿主 API：

| 表面 | 服务 | `ui` | 宿主 API | 会话数据 |
| --- | --- | --- | --- | --- |
| 全屏场景 | `tuiScenes` | 整个 `src/ui.ts` 模块 | `channel`（完整 `ChannelUi`）、`close` | 有，但只有 channel 字段 |
| 侧栏面板 | `tuiPanels` | `TuiPanelUi`（收窄的 Box/Text/Image/ScrollBox/Divider/Markdown/CodeBlock） | `host`：策展快照、badge、openScene、toast、storage、onKey、focus | 快照不含上下文/用量 |
| 状态视图 | `tuiStatus.registerView` | `TuiStatusViewUi`（Box/Image/Text） | 无 | 无 |

另有对话框、toast、状态行文本与底栏字段、快捷键、条目渲染器、设置区块、命令。

## 缺口

从 dsh-context 的 Web 客户端提炼（`src/client/**`，12k 行视图），抽象成任何富界面插件都会撞上的问题：

1. **没有可视化原语。** 堆叠条、走势、柱图、热力图、图例、表格都得插件自己手搓，且必须自己处理显示单元宽度、CJK、
   最大余数分配、1/8 块精度——仓库已有的 `ContextBarView`、`ProgressBar` 只服务内建界面。
2. **没有分类色板。** 主题只有语义色（成功/警告/强调…）与上下文条五色，插件画多系列图只能写死十六进制色，
   换到浅色或 ANSI 主题即失真。
3. **面板拿不到会话数据。** 快照没有上下文占用、组成、token、费用；插件要读自己的投影，得自己重写
   `session-projection-store.ts` 那一整套「绑定当前屏会话、绑定时读基线、跟随切换、注册表来去」的生命周期。
4. **没有导航动词。** 打开另一个会话、预览文件、复制、带参数打开自己的面板/场景——Web 版靠 `uiWorkspace.openSession`、
   右栏 `openResource`，甚至 DOM hack；终端里一个都没有。
5. **三套 kit 不统一。** 加一个原语要改三处，表面之间能力不对称（场景整模块直通，面板与状态视图各自收窄）。
6. **命令被静默遮蔽。** 插件命令与本地命令同名时直接消失（本地优先），插件无从得知、用户无从调用。

## 原则

- **一套 kit，多处挂载。** 原语只实现一次；各表面按类型收窄暴露子集，不复制实现。
- **原语受控、无状态、不碰键盘。** 选中项、展开项由插件以 props 传入；面板用 `host.onKey`、场景用 `useInput`、
  状态视图只有指针——同一个原语在三处都能用。
- **几何与组件分离。** 列分配、重采样、量化等纯函数单独成模块，无头可测；宽度一律按 terminal cell。
- **对外契约是新定义的收窄包装**（照 `TuiPanelMarkdownProps` 的做法）：只承诺必要字段，宿主内部组件怎么改都不动契约；
  用 `panels.ts` 已有的 `Assert` 类型守卫钉住。
- **后端中立优先。** 原语、色板、用量快照对 Claude/Codex 会话同样有效；DSH 专属能力（投影）只在 `src/dsh-adapter/` 实现，
  其他后端优雅缺席（返回 `undefined`），不报错。
- **数据走插件自己的能力。** 宿主不把任意投影塞进面板快照（快照的「不含转录正文」策展不变）；插件在自己的 activation
  里申请订阅，宿主只做生命周期。
- **不改 patch 面。** 新服务挂在 `dsh-tui-extensions` 行的 apply 上（与 dialogs/status/toast 同法），
  `patch-surface.snapshot.json` 不动。
- **吃自己的狗粮。** 内建界面逐步迁到同一套原语，原语的质量由内建界面背书。

## 一期：可视化套件 · 分类色板 · 会话数据（已实现）

### 1. 可视化原语（已实现）

实现在 `src/components/design-system/`，几何纯函数在 `chartGeometry.ts`，对外契约在 `chartTypes.ts`，
挂载对象在 `chartKit.ts`（`tuiChartKit` / `tuiChartRowKit`）。颜色参数统一为
`TuiChartColor = number | keyof Theme`——数字是分类色序号（见下节），字符串是主题语义键；不接受字面色。

| 原语 | 用途 | 关键 props | 行数 |
| --- | --- | --- | --- |
| `StackedBar` | 组成/占用条（上下文组成、预算、配额） | `segments[{value, color, hatch?}]`、`width`、`capacity?`（按容量画，余下为空白）、`emptyColor?`、`keepVisible?` | 1 |
| `Sparkline` | 单行走势（TPS、逐请求大小） | `values`、`width`、`color?`、`min?`/`max?`、`fit: 'bucket' \| 'tail'` | 1 |
| `ColumnChart` | 逐步/逐日柱图，可堆叠，可打标记 | `columns[{segments, marker?, markerColor?}]`、`height`、`columnWidth?`、`gap?`、`max?`、`selected?` | `height`(+1) |
| `Heatmap` | 日历热力图、矩阵 | `rows: (number \| null)[][]`、`color?`、`levels?`、`cell?: 1 \| 2`、`max?`、`selected?` | `rows.length` |
| `Legend` | 色块 + 标签 + 数值，按宽度折行 | `items[{color, label, value?}]`、`width`、`maxRows?` | ≥1 |
| `Table` | 定宽/弹性列、截断、选中行 | `columns[{key, title?, width?, grow?, minWidth?, align?, color?}]`、`rows`、`width`、`selected?`、`header?` | 行数(+1) |
| `Meter` | 单比例条（即现有 `ProgressBar` 的公开名） | `ratio`、`width`、`fillColor?`、`emptyColor?` | 1 |

几何约定（`chartGeometry.ts`，全部纯函数）：

- `allocateCells(values, cells, { keepVisible? })`：最大余数法，和恒等于 `cells`；`keepVisible` 让非零项至少 1 格
  （格数不足时按值降序取舍）。这与上下文条原有的分配是同一个算法，三期已把 `contextBarColumns` 改成调用它（见三期）。
- 横向 1/8 精度用 `▏▎▍▌▋▊▉█`；纵向用 `▁▂▃▄▅▆▇█`。**堆叠柱的段界落在格内时**，用下块字形配
  前景=下段色、背景=上段色，一格内画出两段的精确分界。
- `resample(values, width, fit)`：`bucket` 按桶取峰值（保留尖峰），`tail` 取最后 `width` 个。
- `quantize(value, max, levels)`：热力图分级；无数据 `null` 与零值分开画（`·` 与空）。
- 非有限数、负值按 0 处理（`ColumnChart` 的有符号模式留到有真实消费者再加），永不抛错。
- 热力图与走势在 16 色终端里靠字形阶梯（`·░▒▓█`、块高度）保持可读，不依赖颜色深浅。

格式化辅助 `ui.format`：`tokens(n)`、`duration(ms)`、`percent(ratio, digits?)`、`relativeTime(at, now?)`、
`cells(text)`、`truncate(text, cells)`。`tokens` 与 `duration` 直接调用宿主的格式化函数（`src/terminal-utils/format.ts`，
不另写一份），最终口径见[实现记录](#实现记录与设计的偏差)。

各表面的可用范围：

| | 场景 | 面板 | 状态视图 |
| --- | --- | --- | --- |
| 全部原语、`format`、`seriesColor`/`hashSeries` | ✓（`ui.ts` 导出，场景的 `ui` 即该模块） | ✓（`TuiPanelUi extends TuiChartKit`） | 单行原语（`StackedBar`、`Sparkline`、`Meter`）、`format` 与两个取色函数（`TuiStatusViewUi extends TuiChartRowKit`） |

面板的 compact 行（二期）拿与状态视图相同的单行子集（`TuiPanelCompactUi`）。场景的 `ui` 后来改为 `TuiSceneUi`
（`src/ui.ts` 模块 + 面板那份收窄的 `Markdown` / `CodeBlock`），富文本视图因此也能在面板与场景之间原样搬家。

### 2. 分类色板（已实现）

- `Theme` 新增 `chart1` … `chart8` 八个键。八色是终端里还能稳定区分的上限；超出的系列循环取色。
- 固定色相顺序：蓝、橙、青绿、黄、品红、绿、紫、红。深色主题共用 `CHART_DARK_RAMP`、浅色主题共用
  `CHART_LIGHT_RAMP`（青绿、黄加深以在白底上过 3:1）、16 色主题用 `CHART_ANSI_RAMP`（`ansi:*`，黄与品红各用
  两次且相隔两槽）；品牌/樱花色板不改色阶。自定义主题 JSON 可逐键覆盖，缺省走 `base`，不报警告。
- `ui.seriesColor(i)` → `chart{(i mod 8)+1}`；`ui.hashSeries(key)` → 稳定的序号（32 位 FNV-1a 模 8；同一个名字在
  任何视图、任何会话里同色，用于工具名、技能名、Agent 名这类开放集合；只读前 256 个 UTF-16 码元，超长名字的代价有界）。

### 3. 会话数据：当前屏会话的投影订阅（DSH，已实现）

服务 `ctx.tuiSessionData`（`src/dsh-adapter/session-data.ts`），在插件 activation 里调用：

```ts
interface TuiSessionDataRuntime {
  /** 订阅「当前屏会话」的一个投影值；随调用方 fiber 释放。拒绝时 warn 并返回 undefined。 */
  watchProjection(key: string, identity?: Context): TuiProjectionWatch | undefined
  /** 宿主会话列表（与 Web 列表同源）；随调用方 fiber 释放。 */
  watchSessionList(options?: { projections?: readonly string[] }, identity?: Context): TuiSessionListWatch | undefined
}

interface TuiProjectionWatch {
  readonly key: string
  /** 当前屏会话；尚未绑定会话时 undefined。 */
  readonly sessionId: string | undefined
  /** 原始 wire 值，由插件自己收窄。未注册、非 DSH 后端或尚无值时 undefined；值不变时引用稳定。 */
  read(): unknown
  subscribe(listener: () => void): () => void
}
```

插件在 apply 里拿到 watch，交给自己的面板/场景组件：
`const value = React.useSyncExternalStore(watch.subscribe, watch.read)`。

- **语义**：绑定会话时读一次基线（投影只在变化时推送，恢复的会话否则要等下一个事件）；`/new`、`/resume`、rewind
  后跟随新会话并先清空旧值；后台会话的推送不覆盖屏上的值；注册表或投影定义来去时重读。即
  `createSessionProjectionStore` 已有的全部语义——实现就是复用它。
- **实现**：根作用域的 `SessionProjectionHub`（`src/dsh-adapter/session-projection-hub.ts`）。每个 key 一个
  store，多个插件订阅同一 key 共享并引用计数；注册表只挂一个 `onChanged` 监听按 key 分发；绑定由
  `binding-events.ts` 与团队、占用同一处调用 `seedProjections(session)`。
- **预算**：见[实现记录](#实现记录与设计的偏差)（最终按 watch 计）；只保存屏上会话的值，不随会话数增长。
- **非 DSH 后端**：hub 没有注册表，`read()` 恒为 `undefined`；会话列表读出 `[]`。
- **为什么不放进面板快照**：投影可能含转录内容；插件本来就能用自己的 `ctx` 读自己的投影（同进程信任），
  这个服务只替它管生命周期，不让面板快照越过现有策展。

### 4. 面板快照补充用量（后端中立，已实现）

`TuiPanelSnapshot` 新增 `usage`（`TuiPanelUsage`），全部来自 `ChannelUi` 已有字段，与底栏 `ctx`、`/tokens`、
Info 面板同源；场景的 `host.snapshot()` 返回同一份快照（`components/sidePanel/panelSnapshot.ts`）：

```ts
readonly usage: Readonly<{
  occupancy: { usedTokens: number; contextWindow: number | undefined; source: 'projection' | 'backend' | 'sample' } | undefined
  breakdown: { systemTokens: number; toolsTokens: number; messageTokens: number } | undefined
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  cost: { currency: string; amount: number; source: 'backend' | 'estimate' } | undefined
}>
```

插件展示占用率时读它，就与宿主的数字一致——不再出现两个占用率打架。`cost` 先取后端自报花费，否则只在官方
DeepSeek 路由有已计价金额时给本地估算（`CNY`）。

### 5. 文档与验证（已完成）

- 准入与开发指南：「接缝十五 · 侧栏面板」（`tuiPanels` 此前只在 `docs/plugins.md` 有一段速览）、
  「接缝十六 · 会话数据」、横切的「插件 UI 套件（图表原语与分类色板）」；接缝八补宿主动词、深链参数与文件预览，
  接缝十一补富状态视图的单行图表；`docs/plugins{,.en}.md` 稳定性表登记为实验性；
  `docs/themes{,.en}.md` 登记 `chart1`–`chart8`；双 README 与用户手册同步。
- 回归（均为 `node --import tsx/esm`）：
  - `scripts/verify-plugin-ui-kit.tsx`（`pnpm verify:plugin-ui-kit`）：几何纯函数、各原语在窄宽与 CJK 标签下的无头渲染、
    暗/亮/ANSI 三套色板取色、kit 收窄。
  - `scripts/verify-session-data.ts`（`pnpm verify:session-data`，已进 `verify:build`）：绑定读基线、跟随切换、后台会话
    推送被忽略、fiber 卸载释放、共享 key 引用计数、预算拒绝、无注册表时恒 undefined、会话列表。
  - `scripts/verify-surface-host.tsx`（`pnpm verify:surface-host`）：宿主动词、深链参数、场景 `host` 与文件预览。
  - `scripts/verify-plugin-panels.tsx`：kit 新成员是收窄包装、`usage` 快照、生命周期事件、compact 行。
  - `scripts/verify-plugin-commands.ts`：限定名的列出、执行、授权与 `/plugin` 诊断。
  - 主题：`verify-themes.mjs`、`verify-runtime-themes.ts`；改动属「主题原语」，三个 CI 回归都要跑；`pnpm build`。

## 二期：导航与命令（已实现）

- **共用宿主 API。** 面板的 `host` 与场景新增的 `host` 共享同一组动词（`TuiSurfaceHostApi`，`src/dsh-adapter/surface-host.ts`；
  场景 props 只加不改）：
  - `openSession(id)`：经 `channel.resumeTo`，照常走 `tui/session-switch` 决策；
  - `openFile(path, { line? })`：宿主只读预览（最终形态见实现记录）；
  - `copy(text)`：OSC 52 + 本地剪贴板工具兜底，与宿主复制同一路径（每个插件 activation 每秒至多 1 次，shadow 模式拒绝）；
  - `openScene(id, params?)` / `openPanel(id, params?)` + `useParams()`：带参数深链接自己的视图（替代 Web 版的 DOM hack 与全局接力）；
  - `toast(text)`。
  场景的 `host` 另有 `snapshot()` 与 `storage`（`TuiSceneHostApi`）。
- **被遮蔽的插件命令可达。** 与本地命令同名、且经 `tuiPluginHost.registerCommand` 归属的插件命令，以
  `/<pluginId>:<name>` 出现在 `/` 菜单与执行路径；本地优先不变。
- **面板补完。** compact 行真正挂载渲染（§18.1 的 TODO）；`opened/closed/focused/blurred` 事件。

## 三期：内建迁移与跨会话（已落地）

- **上下文条的列分配改用 `allocateCells`**（经 `contextBarColumns`，ANSI 的 `renderContextBar` 路径随之一致）。
  底栏输出与迁移前**逐字节相同**：只在每个可见段都放得下时才开 `keepVisible`，已用区太窄、放不下全部非零段的
  小区间仍按原来的比例分配——迁移不改变任何用户看得到的格子。
- **Info 面板改用套件**：各组的行是两列 `Table`；Context 组在读数下面加一条 `Meter`，按底栏 ctx 的阈值配色
  （< 80% 绿、≥ 80% 琥珀、≥ 95% 红）。不加组成 `StackedBar`：claude / codex 品牌下底栏的段色是十六进制表
  （`usedSegmentColor`），不是主题键，而套件拒收字面色——面板里的组成条会和底栏颜色对不上。
- **`formatTokens` 合并为一份**：`src/terminal-utils/format.ts` 的 `formatTokens(count, { style })` 是唯一实现，
  `precise`（默认：状态行 token/缓存/花费字段、悬停明细、转录用量行、`/cost`、轨迹视图）与 `short`（上下文条读数
  与悬停分解、`ui.format.tokens`）两档；`StatusMetrics`、`trajectory/format` 的副本已删。
- **后台任务进度**（`JobCard` 的 `JobProgress`）改用套件的 `Meter`，像素与原 `ProgressBar` 相同。
- `watchSessionList()`：会话列表行 + 投影值，供跨会话仪表盘（用量、热力图、会话卡片）。——**已提前在一期实现**，
  见实现记录。

剩下的内建候选：底栏 `ctx` 字段的读数仍由 `src/tuiDisplayPrefs.ts` 的 `formatTokenCount` 自带一份短档（小写 `1.0m`），
与 `short` 档只差大小写；Info 面板的组成条要等品牌段色改成主题键；上下文条的小区间比例分配保留原样（那里改用
`keepVisible` 会让最大的几段各占一格、改变窄条上看得到的格子）。

## 同批补充的基建

与套件同一批落地、同属「让富界面插件在终端里交付完整体验」的四项：

- **插件 Config 生成页**（`src/dsh-adapter/plugin-config.ts`，接缝六）。DSH 0.2 的设置服务按 profile 行描述
  `.volatile()` Config 字段的表单；没有 `tuiSettingsSections` 区块的第三方插件据此在 `/settings` 的「插件」页
  自动得到一张卡片，写入走既有 `settings.mutate`（当前 profile 的 `cordis.patch.yml` 覆盖行，即时生效）。优先级：
  插件自己的区块 > 宿主策划区块 > 生成页（`autoGenerate !== false`、第三方行、至少一个可表示字段）。schema 只当
  JSON 读，节点、行、选项、页数都有上限；终端单行改不了的值、密钥与非 volatile 字段是只读行。为此
  `TuiSettingsField` 增可选 `readOnly`。回归 `scripts/verify-plugin-config-settings.tsx`。
- **多命令插件的准入**（`src/adapter/standard/{validate,permission-scope}.ts`，`TUI-PKG-002`）。固定 revision 的
  projection 按权限名去重，一个 facet 只能有一条 `commands.invoke`；以前又要求它的 scope 等于某个命令 id，两条
  叠加等于「一个插件最多一个命令」。现在这条可以写命名空间通配 `<id>.*`，覆盖全部 `<id>.` 开头的已声明命令；
  授权文件同样接受 `<id>.*`，宽窄关系与 `session:*` 一致（窄 deny 胜宽 grant）。invoke 检查点仍按精确命令 id
  问授权。回归：`verify:plugin-spec`（fixture 与协商）、`verify:plugin-grants`（A14）、`verify:plugin-commands`。
- **身份继承加固**（`src/dsh-adapter/component-identity.ts`、`host-access.ts`）。嵌套 fiber 沿 Cordis 创建时记录的
  父链（`parentFiberOf`）找最近的已准入祖先，不读可写的 `fiber.parent`，改写它借不到别的插件的身份；可选
  `identity` 参数接受所属插件的 ctx，但祖先链途中有 fiber 自带身份时拒绝（嵌套插件不能冒用父插件）。回归在
  `scripts/verify-plugin-panels.tsx`。
- **场景 `ui` 并入 `Markdown` / `CodeBlock`**（`src/dsh-adapter/scenes.ts` 的 `TuiSceneUi`，`channel-scene-outlet.ts`
  构建一次、身份稳定）。只加不改：模块原有成员全部保留。回归在 `scripts/verify-surface-host.tsx`。

## 实现记录与设计的偏差

落地时的最终口径（插件可见行为以准入与开发指南为准）：

| 项 | 设计稿 | 最终 |
| --- | --- | --- |
| `ui.format.tokens` | 复用 `terminal-utils/format.ts`（`1.2k`/`3.4M`） | 与底栏**上下文条**读数逐字相同（`988`、`3.4k`、`12k`、`1.0M`，`formatTokens` 的 `short` 档）：插件标注与上下文条的数字不会两样。底栏 token 字段用的是 `precise` 档（`12.3k`），不是这一档 |
| `ui.format.duration` | `850ms`、`12s`、`3m 05s`、`2h 10m` | 1 秒起就是宿主的 `formatDuration`（`12s`、`3m 4s`、`2h 10m`、`1h 2m 3s`，与 spinner 计时、工具行逐字相同）；不足 1 秒保留毫秒（`850ms`；向下取整、至少 `1ms`），因为宿主从不显示亚秒而插件标注（首 token 时间、单次快速工具调用）需要；0、负数、非有限数 → `0s` |
| `ColumnChart` 标记行 | `height`(+1)：有标记或选中时加一行 | `selected` **只要是数字**就保留标记行；`-1` 保留但不高亮任何柱——进入/退出选择模式时图不跳行 |
| 会话数据预算 | 每 activation 至多 8 个 key、全局 64 | **按 watch 计**：每 activation ≤8 个投影 watch（同一 key 订阅两次计两个）、全局 ≤64 个不同 key（已被订阅的 key 仍可共享）、每 activation ≤2 个会话列表 watch；超限记台账 `SESSION_DATA_BUDGET_EXCEEDED` |
| `watchSessionList` | 三期 | 一期实现：行与 Web 会话列表同源同规则；每行投影值只取宿主已持有的（已挂载会话的物化单元、冷会话的持久化投影缓存），**从不为此读日志**；答不上的 key 缺席；异步分片读取、`refresh()` 重读、不自动推送 |
| `openFile` 的落点 | 工作区面板/预览 | 宿主自有的**只读整屏预览场景** `dsh-tui:file-preview`：不是插件贡献（id 带冒号，插件注册占不到，`list()` 不列出），插件只能经 `host.openFile` 请求；从场景发起时关闭预览回到该场景（重新挂载），否则回到之前的屏幕；目录、非普通文件、二进制（前 8000 字节含 NUL）、> 2 MiB 显示提示，> 256 KiB 不高亮；控制字符显示为控制图符 |
| compact 行 | 「真正挂载渲染」 | 提示框上方、与富状态视图同一排（排在其后）；**分栏没有显示时**出现——侧栏收起、inline、内容区窄于 93 列、整页编辑器（即 types.ts「侧栏收起/窄屏时的紧凑槽」的原意）；跟随 `sidePanel.panels` 启用集合与顺序；合计 3 行，放不下自己 `maxRows` 的面板整个跳过；每行独立错误边界，计入同一个连续崩溃禁用；props 带 `snapshot()`（与面板同一份快照，含 `usage`），compact 里的占用率能与底栏一致 |
| 插件身份 | 未写 | `ctx.inject` / `ctx.plugin` 嵌套 fiber 以最近一个已准入祖先的 verified 身份行事（自带已准入 manifest 的子插件保留自己的；Loader 实例化的嵌套行是独立插件，自身未准入时不继承）；查找沿 Cordis 创建 fiber 时记录的父链，改写 `fiber.parent` 不转移身份；嵌套调用方把所属插件的 ctx 作 `identity` 传入被接受（祖先链途中有 fiber 自带身份时拒绝）；带显式 owner ctx 的 API（`registerCommand` 等）先解析活动 activation，嵌套回调链里传祖先 ctx 仍被拒 |
| 插件 id 与命名空间 | `/<pluginId>:<name>` | `pluginId` 是已准入 `dsh-plugin.json` 的 verified id：简单 id（`^[a-z][a-z0-9_-]*$`）或 Community v0.15 namespaced id（如 `com.example.echo`）。同一个 id 给面板稳定前缀（`<pluginId>:<sub>`，可写进 `sidePanel.panels`）与命令限定名；没有已准入 manifest 的包只拿到一次性会话 id（`session:actN:<sub>`）、没有限定名 |
| 限定名的列出 | 出现在 `/` 菜单与执行路径 | 只有**被遮蔽**的命令以限定名列出（未被遮蔽的照旧只列裸名，但限定名同样可以手敲）；执行与授权与裸名同一路径（两道 `commands.invoke`、同一条规则管两种写法）；执行前按当前 Agent 实际解析到的定义核对 owner；不可达的遮蔽命令进 `/plugin` 诊断；`tuiCommandTrees` 子命令补全不展开限定名行 |
| 深链参数 | 未定 | JSON（`null`、布尔、有限数字、字符串、数组、普通对象）；序列化 ≤16 KiB（预算在拷贝中累计，共享引用的指数膨胀立刻被拒）、嵌套 ≤32 层、拷贝至多访问 65,536 个自有属性（值为 `undefined` 被丢弃的也算）；冻结深拷贝；深相等的再次打开保持原引用；不带参数打开 = 清空；注册撤下时清除；参数在切屏前写入；对正在显示的自己的面板/场景再次打开只更新参数（面板的这种再次打开不计入 5s 限速、不改焦点） |
| 限速 | 未定 | `openSession` 每插件 activation 2s 一次，属修改类能力 `host.surface.open-session`（adapter slice `surface`），shadow 模式一律返回 `false`（不占窗口）；`openPanel` 与 `tuiPanels.open` 共用窗口，同一面板 5s 一次（参数非法、无聊天屏消费，或目标正在分栏里显示、只更新参数时不消耗窗口）；`copy` 每个插件 activation 每秒至多 1 次（被拒的调用不占窗口），属修改类能力 `host.surface.copy`（adapter slice `surface`），shadow 模式一律返回 `false`，宿主自有场景（文件预览）没有插件身份、也返回 `false`；文本 ≤1,048,576 个 UTF-16 码元；`openFile` 路径 ≤4096 字符 |
| 面板生命周期事件 | `opened/closed/focused/blurred` | 来自侧栏实际状态并去重；`focused` 总在 `opened` 之后、`blurred` 总在 `closed` 之前；聊天屏卸载补发 `blurred`/`closed`；全屏场景（含文件预览）盖住界面时不发 `closed`；撤下时不补发 `closed`；`subscribe` 收得到自己面板的 `registered`；重注册一个正在显示的面板时，新注册紧跟 `registered` 收到 `opened`（有焦点再加 `focused`） |
| compact 行重渲染 | 未写 | 聊天每个流式增量都重渲染 compact 槽，但插件组件带 memo 语义：只在 `width`、`badge`（冻结对象，内容不变身份不变）或——调用过 `snapshot()` 的行——快照输入变化时重渲染；`snapshot()` 调用时才构建，从不调用的行零开销 |
| 会话列表刷新 | `refresh()` 重读 | 读取不重叠，每个 watch 每秒至多开始一次：进行中或一秒内的多次 `refresh()` 合并为一次尾随读取（不再中途取代进行中的读取），首个订阅者的读取受同一间隔约束；最后一个订阅者离开时中止进行中的读取、丢弃尾随读取 |
| 文件预览读取 | 一次有界读取 | 读到 EOF 为止、上限 2 MiB（stat 大小为 0 的 procfs/sysfs 文件也完整显示）；读到中途超限显示「文件过大」而不是截断；顶行路径与正文同样中和控制字符与 bidi 字符 |
| 场景 `ui` | 整个 `src/ui.ts` 模块 | `TuiSceneUi` = 该模块 + 面板那份收窄的 `Markdown` / `CodeBlock`（只加不改） |

## 第一个消费者：dsh-context 的终端部分（上游 PR 计划）

dsh-context 在自己仓库里加 `src/tui/`，宿主侧 apply 探测到 `tuiPanels`/`tuiScenes` 才惰性 `import()`，Web 部署不受影响：

- **面板「Context」**：占用率（`snapshot.usage`）、七类组成 `StackedBar` + `Legend`、最近上下文事件、文件活动前若干行
  （`host.openFile` 跳到文件）。
- **场景「Context」**：概览 / 趋势（`ColumnChart`，✂ 标记压缩与剪枝）/ 浏览器（类别 → 条目 → `Markdown`/`CodeBlock` 正文）/ 事件 / 文件，
  Tab 切页、↑↓ 选择、Enter 展开、Esc 关闭；由插件自己的命令打开（`/context` 是本地命令，取别名，也可经
  `/dsh-context:context` 调用——前提是 dsh-context 带已准入的 `dsh-plugin.json` 并经 `tuiPluginHost.registerCommand` 注册）。
  面板经 `host.openScene('context', { tab })` 深链到某一页。
- **数据**：`tuiSessionData.watchProjection('contextTimeline' | 'contextHeaders')`；若该组合挂了 `connection`
  使投影只给 slim 头，插件在进程内直接调用自己的明细构建，不走 HTTP。跨会话视图用
  `watchSessionList({ projections: ['contextHeaders'] })`。
- **设置**：显示偏好经 `tuiSettingsSections` 进 `/settings`。
- **依赖**：不在运行时依赖 dsh-TUI——元素一律用注入的 `React.createElement`，dsh-TUI 只作纯类型 devDependency；
  缺少一期 kit 成员时不注册面板（特性检测，不按版本号分支）。
- 复用它已有的纯逻辑（`format`、`categories`、`dna`、`fileActivity`、`overview`…约 3.9k 行），只重写视图层。

## 风险与取舍

- **公开面增长。** 新成员全部标实验性（与 `tuiPanels` 同档），类型守卫钉住收窄；稳定前可调整。
- **主题键扩充。** 十个内置色板都要补齐，浅色主题对比度需逐套目测；自定义主题缺键时回落 `base`，不报错。
- **渲染成本。** 原语自身不做每帧分配，几何结果可按输入记忆；输入的稳定性（memo）是插件的责任，指南写明。
- **投影订阅的隐私面。** 只给插件自己的 activation 用、只管生命周期，不改变插件本来就有的读权限；面板快照仍不含转录内容。
- **一期不碰状态行。** 上下文条与底栏维持原样，避免共享渲染回归；三期迁移时以「输出逐字节不变」为约束
  （小区间保留比例分配），并按共享渲染改动跑全套回归。
